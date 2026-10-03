/**
 * Spec R1 — AI 练习 PG 真库冒烟。
 *
 * 覆盖内存模式**测不到**的三件事（双模分叉高发区）：
 * 1. **RLS 策略真的装到位且拦得住**——quiz_attempts 归 `RLS_DIRECT_USER_TABLES`，
 *    谓词 `user_id = app.user_id`。内存模式根本没有 RLS，跨租户隔离完全无从验证。
 * 2. **条件更新的并发正确性**——`UPDATE … WHERE status='in_progress'` 在真库上
 *    影响 0 行才是「重复提交 409」的真正依据。
 * 3. **JSONB 列的往返**——questions/answers 内联为 JSONB，需确认写入与读出无损。
 *
 * ⚠️ **本文件起 HTTP server，必须在 `after()` 里 `server.close()`**——漏掉会让
 * node:test 的事件循环永不空闲、进程不退出，PG 冒烟步骤一直挂到 GitHub 的
 * 6 小时 job 上限（2026-09-16~09-18 连续三次 5h58m 挂死，根因即此）。
 *
 * 跑法（两遍都必须绿）：
 *   一遍 owner 单角色：仅验证建表 + 策略存在 + 基本往返
 *   二遍 arborize_app 为主角色（PG_TEST_URL + DATABASE_SYSTEM_URL + DATABASE_ADMIN_URL）：
 *         「跨租户隔离真的生效」这组才有判别力
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.QUIZ_ENABLED = 'true';
process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
process.env.APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

const { createApp } = await import('../../server/app.js');
// 建表必须显式调用（ADR-0019：懒迁移已从仓储摘除）。动态 import：静态导入会被提升到
// process.env.DATABASE_URL 赋值之前。
const { initDbSchema } = await import('../../server/core/schema.js');
const { runWithUser, runWithSystem } = await import('../../server/core/db-context.js');
const { getOutboxForTest } = await import('../../server/lib/mailer.js');
// 直查 PG 用自建 owner 池（照 tests/pg/rls-isolation.pg.test.ts 的既有范式）：
// 策略元数据（pg_class / pg_policies）需以属主视角读，且不受 getMigrationPool 的部署期配置约束。
const { Pool } = await import('pg');
const OWNER_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
const ownerPool = new Pool({ connectionString: OWNER_URL });

/**
 * 直查 PG（策略元数据 / 夹具核对）。
 *
 * ⚠️ **必须包 `runWithSystem`**（2026-10-03 CI 首跑踩坑）：本池在首遍
 * （owner 单角色、未设 DATABASE_ADMIN_URL）会回落到 `PG_TEST_URL` = `arborize_app`
 * ——也就是**与应用层同一个受 RLS 约束的池**，裸调会被 db-guard 抛
 * `DB_SCOPE_MISSING`（"应用层漏了 runWithUser"），进而让后续所有查询回落内存、
 * 整条用例链级联失败。包 `runWithSystem` 后两种跑法都成立。
 *
 * 既有范式：`tests/pg/rls-isolation.pg.test.ts` 用独立 OWNER_URL 绕开该问题，
 * 但那种写法在「未配 owner 凭据」的首跑里会退化成受约束角色，故这里改用显式作用域。
 */
function ownerQuery<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
  return runWithSystem('R1 PG 用例：直查策略元数据与夹具核对', () =>
    ownerPool.query(sql, params as any[]),
  );
}
const {
  signupRateLimiter,
  sendRegisterCodeRateLimiter,
  quizGenerateRateLimiter,
  quizAttemptRateLimiter,
  quizDailyAttemptLimiter,
} = await import('../../server/middleware/auth.js');
const {
  createAttempt,
  getAttempt,
  listAttempts,
  completeAttempt,
} = await import('../../server/repositories/quiz.repository.js');
const { saveAiModelConfig } = await import('../../server/repositories/ai.repository.js');
const { sampleAiAdvanced } = await import('../../docs/spike/r1-quiz-prompt-validation.js');

const IP_KEY = ipKeyGenerator('127.0.0.1');

/**
 * 当前连接角色是否真受 RLS 约束。
 * 首遍（owner 单角色）下**属主天然绕过 ENABLE 级 RLS**，「跨作用域读不到他人行」
 * 这类断言没有判别力，须跳过；第二遍（arborize_app 为主角色）才有。
 * 范式照 tests/pg/rls-isolation.pg.test.ts。
 */
let rlsActive = false;
let appRole = '';

let server: http.Server;
let base = '';

/** /responses 出题桩（照 tests/h2-grounding-chain.test.ts 的 fetch 分发器范式） */
function stubQuizResponse(): Response {
  return new Response(
    JSON.stringify({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(sampleAiAdvanced.output) }],
        },
      ],
      usage: { total_tokens: 1200 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const origFetch = globalThis.fetch;

async function waitPgReady(tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.connected === true && body.type === 'postgresql') return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('PG not ready — 请先 docker compose -f docker-compose.pg-smoke.yml up -d postgres');
}

async function registerViaCode(email: string, password: string): Promise<void> {
  (signupRateLimiter as any).resetKey(IP_KEY);
  (sendRegisterCodeRateLimiter as any).resetKey(IP_KEY);
  await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '')!.match(/\b(\d{6})\b/)![1];
  const res = await fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
  });
  assert.ok([200, 201].includes(res.status), `sign-up ${email} 应成功`);
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** 复位三个练习限流器（express-rate-limit v8 无公开 store，靠 resetKey） */
function resetQuizLimiters(): void {
  (quizGenerateRateLimiter as any).resetKey(IP_KEY);
  (quizAttemptRateLimiter as any).resetKey(IP_KEY);
  (quizDailyAttemptLimiter as any).resetKey(IP_KEY);
}

const stamp = Date.now().toString(36);
const ALICE_EMAIL = `r1-alice-${stamp}@t.ai`;
const BOB_EMAIL = `r1-bob-${stamp}@t.ai`;
const ALICE_PW = 'R1alice123!';
const BOB_PW = 'R1bob123!';
let aliceCookie = '';
let bobCookie = '';
let aliceId = '';
let bobId = '';

describe('R1 AI 练习 PG 真库', () => {
  // ⚠️ 必须在 after 里关 server，否则本文件让 node:test 的事件循环永不空闲
  after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  /**
   * 装配**刻意不放在 `before()` 钩子里**：`before` 不受 `PG_SMOKE` 门控，
   * 即便全部用例 skip 也会执行 → 无 PG 时白等 30s 并抛「PG not ready」。
   * 既有 canvas-search.pg.test.ts 同样把 server 启动放进第一个 `t()` 用例内部，
   * 本文件照抄该结构（先例见 2026-09-16 三次挂死的教训）。
   */
  async function setup(): Promise<void> {
    if (base) return; // 幂等
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await waitPgReady();
    await initDbSchema();

    await registerViaCode(ALICE_EMAIL, ALICE_PW);
    await registerViaCode(BOB_EMAIL, BOB_PW);
    aliceCookie = await signIn(ALICE_EMAIL, ALICE_PW);
    bobCookie = await signIn(BOB_EMAIL, BOB_PW);

    // 探测角色是否真受 RLS 约束（决定「隔离生效」类断言是否适用）。
    // ⚠️ **必须用应用层那个池（DATABASE_URL）探测**，不能用 ownerPool——
    // `row_security_active()` 反映的是**当前连接角色**的状态，而仓储走的是
    // getDb()（即 DATABASE_URL 那个池）。用 ownerPool 探测在双角色跑法下仍会读到
    // 属主，导致隔离断言被误判为「不适用」而跳过（2026-10-03 CI 三跑的实际教训）。
    // 范式照 tests/pg/rls-isolation.pg.test.ts:57,115-118。
    const appPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const who = await appPool.query(
      "SELECT current_user AS role, row_security_active('quiz_attempts') AS active",
    );
    appRole = who.rows[0].role;
    rlsActive = who.rows[0].active === true;
    await appPool.end();

    const me = async (cookie: string) => (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()) as any;
    aliceId = (await me(aliceCookie)).user.id;
    bobId = (await me(bobCookie)).user.id;

    // 出题走 openai 兼容渠道 → 打桩 /responses
    // 出题走 openai 兼容渠道 → 打桩 /responses。
    // ⚠️ 必须包作用域：saveAiModelConfig 走 getDb()，裸调会被 db-guard 拦
    // （DB_SCOPE_MISSING）而**静默回落内存**，于是 HTTP 路径读不到配置、
    // 回落到 DEFAULT_AI_MODEL_CONFIG 的 gemini 分支 → 打桩不命中 → 报
    // 「GEMINI_API_KEY is not configured」（这正是 2026-10-03 CI 首跑的实际现象）。
    await runWithSystem('R1 PG 用例：写入出题模型桩配置', () =>
      saveAiModelConfig({
        provider: 'openai',
        openai_base_url: 'https://example.invalid/v1',
        openai_api_key: 'stub-key',
        openai_model: 'stub-model',
        gemini_model: 'stub-model',
      }),
    );

    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('/responses')) return stubQuizResponse();
      return origFetch(input, init);
    };
  }

  after(() => {
    (globalThis as any).fetch = origFetch;
  });

  // ⚠️ **必须**关闭自建 owner 池：不关就是一条常开连接，node:test 的事件循环永不空闲
  // → 进程不退出 → PG 冒烟步骤挂到 GitHub 的 6 小时 job 上限。
  // （与上面 server.close() 同等重要，两处都要有。）
  after(() => new Promise<void>((resolve) => { void ownerPool.end().then(() => resolve()); }));

  t('quiz_attempts 表已建 + RLS 已启用且未 FORCE', async () => {
    await setup();
    const res = await ownerQuery(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE relname = 'quiz_attempts'`,
    );
    assert.equal(res.rows.length, 1, 'quiz_attempts 表应存在');
    assert.equal(res.rows[0].relrowsecurity, true, 'RLS 应已启用');
    assert.equal(
      res.rows[0].relforcerowsecurity,
      false,
      '⛔ 不得 FORCE ROW LEVEL SECURITY（会让归属探针静默失效，ADR-0019）',
    );
  });

  t('RLS 策略谓词用 user_id = app.user_id，且带 WITH CHECK', async () => {
    const res = await ownerQuery(
      `SELECT cmd, qual, with_check FROM pg_policies
       WHERE tablename = 'quiz_attempts' AND policyname = 'tenant_isolation'`,
    );
    const rows = res.rows as any[];
    assert.ok(rows.length > 0, '应有 tenant_isolation 策略');
    const qual = String(rows[0].qual || '');
    assert.match(qual, /user_id/, `策略谓词应含 user_id，实际为 ${qual}`);
    assert.match(qual, /current_setting/, `策略谓词应基于 app.user_id GUC，实际为 ${qual}`);
    const withCheck = String(rows[0].with_check || '');
    assert.match(
      withCheck,
      /user_id/,
      `WITH CHECK 也应含 user_id（否则可写入他人行），实际为 ${withCheck}`,
    );
  });

  t('出题落库：JSONB 无损往返', async () => {
    resetQuizLimiters();
    const res = await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: '注意力机制', difficulty: 'advanced', count: 5 }),
    });
    assert.equal(res.status, 200, `出题应成功：${await res.clone().text()}`);
    const body = await res.json() as any;
    assert.equal(body.questions.length, 5);

    // 直查 PG：questions JSONB 应存有 5 题且含 correct/explanation（服务端独占列）
    const row = await ownerQuery(
      'SELECT questions, status FROM quiz_attempts WHERE id = $1',
      [body.attemptId],
    );
    assert.equal(row.rows.length, 1, 'quiz_attempts 应有一行');
    assert.equal(row.rows[0].status, 'in_progress', '初始状态应为 in_progress');
    const stored = row.rows[0].questions as any[];
    assert.equal(stored.length, 5, 'JSONB 内应存 5 题');
    assert.ok(stored[0].correct, '存储层应含 correct（仅 ② 才下发客户端）');
    assert.ok(stored[0].explanation, '存储层应含 explanation');
    assert.ok(stored[0].id, '每题应有题级 id');
  });

  t('① 响应体不含答案（PG 路径同样成立）', async () => {
    resetQuizLimiters();
    const res = await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: '光合作用', difficulty: 'beginner', count: 5 }),
    });
    const text = await res.text();
    for (const forbidden of ['"correct"', '"explanation"', '"knowledge_point"']) {
      assert.ok(!text.includes(forbidden), `① 响应体不得含 ${forbidden}`);
    }
  });

  t('列表接口不 select questions 列（题数由 jsonb_array_length 提供）', async () => {
    resetQuizLimiters();
    const res = await fetch(`${base}/api/quiz/attempts`, { headers: { cookie: aliceCookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.attempts) && body.attempts.length > 0, '应有历史记录');
    for (const item of body.attempts) {
      assert.ok(item.total > 0, `题数应由 jsonb_array_length 给出，实际 ${item.total}`);
      assert.ok(!('questions' in item), '列表项不得含 questions');
      assert.ok(!('correct' in item), '列表项不得含 correct 键（避免与答案混淆）');
    }
  });

  t('交卷：条件更新 + JSONB 往返 + 状态流转', async () => {
    resetQuizLimiters();
    const created = await (await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: '梯度下降', difficulty: 'intermediate', count: 5 }),
    })).json() as any;

    const answers = created.questions.map((q: any) => ({
      questionId: q.id,
      choice: q.type === 'true_false' ? 'true' : (q.options?.[0]?.label ?? 'A'),
      elapsedMs: 30_000,
    }));
    const sr = await fetch(`${base}/api/quiz/attempts/${created.attemptId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ answers }),
    });
    assert.equal(sr.status, 200);
    const graded = await sr.json() as any;
    assert.equal(graded.summary.total, 5);
    assert.ok(graded.results.some((r: any) => r.answer), '② 应返回正确答案');

    // PG 侧确认 status 已翻转、answers 已落库
    const row = await ownerQuery(
      'SELECT status, answers, completed_at FROM quiz_attempts WHERE id = $1',
      [created.attemptId],
    );
    assert.equal(row.rows[0].status, 'completed', 'PG 侧状态应为 completed');
    assert.ok(row.rows[0].completed_at, 'completed_at 应回填');
    assert.equal((row.rows[0].answers as any[]).length, 5, 'answers JSONB 应存 5 条');
  });

  t('重复交卷 → 条件更新影响 0 行 → 409（真库上的并发正确性）', async () => {
    resetQuizLimiters();
    const created = await (await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: '卷积神经网络', difficulty: 'beginner', count: 5 }),
    })).json() as any;
    const answers = created.questions.map((q: any) => ({
      questionId: q.id,
      choice: q.type === 'true_false' ? 'false' : (q.options?.[0]?.label ?? 'A'),
      elapsedMs: 20_000,
    }));
    const post = () => fetch(`${base}/api/quiz/attempts/${created.attemptId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ answers }),
    });
    assert.equal((await post()).status, 200, '首次交卷应成功');
    assert.equal((await post()).status, 409, '重复交卷应 409（条件更新影响 0 行）');
  });

  t('跨租户隔离：他人 attemptId 读/答均不可见（RLS 实证）', async () => {
    resetQuizLimiters();
    const created = await (await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: '过拟合与正则化', difficulty: 'intermediate', count: 5 }),
    })).json() as any;

    const bobRead = await fetch(`${base}/api/quiz/attempts/${created.attemptId}`, {
      headers: { cookie: bobCookie },
    });
    assert.ok([403, 404].includes(bobRead.status), `bob 读应 403/404，实际 ${bobRead.status}`);

    const bobSubmit = await fetch(`${base}/api/quiz/attempts/${created.attemptId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: bobCookie },
      body: JSON.stringify({
        answers: created.questions.map((q: any) => ({
          questionId: q.id,
          choice: 'A',
          elapsedMs: 20_000,
        })),
      }),
    });
    assert.ok([403, 404].includes(bobSubmit.status), `bob 作答应 403/404，实际 ${bobSubmit.status}`);

    // bob 的列表里不应出现 alice 的记录
    const bobList = await (await fetch(`${base}/api/quiz/attempts`, {
      headers: { cookie: bobCookie },
    })).json() as any;
    assert.ok(
      !bobList.attempts.some((x: any) => x.attemptId === created.attemptId),
      'bob 列表不得出现 alice 的记录',
    );

    // 原属主数据未受影响
    const stillThere = await fetch(`${base}/api/quiz/attempts/${created.attemptId}`, {
      headers: { cookie: aliceCookie },
    });
    assert.equal(stillThere.status, 200, '越权不得影响原属主数据');
  });

  t('仓储层：RLS 作用域下 runWithUser 只看得见本人行', async () => {
    // 属主直查：alice 有行
    const asOwner = await ownerQuery(
      'SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE user_id = $1',
      [aliceId],
    );
    assert.ok(asOwner.rows[0].n > 0, 'alice 应有练习记录');

    // 经作用域读取：只能看见 alice 自己的（RLS 过滤）
    const viaScope = await runWithUser(aliceId, async () => {
      const rows = await listAttempts(aliceId, 50);
      return rows;
    });
    assert.ok(viaScope.length > 0, 'alice 作用域内应能读到自己的行');
    assert.ok(
      viaScope.every((r) => r.user_id === aliceId),
      '作用域内不得混入他人行',
    );
  });

  t('仓储层：getAttempt 越权不泄漏（按 id 直取也只在本作用域内可见）', async (ctx) => {
    resetQuizLimiters();
    const created = await (await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: 'Transformer 自注意力', difficulty: 'advanced', count: 5 }),
    })).json() as any;

    // ⚠️ 属主（首遍）天然绕过 ENABLE 级 RLS，故「bob 读不到 alice」在首遍不成立——
    // 这不是漏洞而是角色差异。照 tests/pg/rls-isolation.pg.test.ts 的既有范式：
    // 探测角色是否真受 RLS 约束，不受则跳过该断言（第二遍双角色跑法才会有判别力）。
    if (!rlsActive) {
      return ctx.skip(`当前角色 ${appRole} 不受 RLS 约束（属主/BYPASSRLS）：隔离断言仅在双角色跑法下适用`);
    }

    const asBob = await runWithUser(bobId, () => getAttempt(created.attemptId));
    assert.equal(asBob, null, 'bob 作用域内不应拿到 alice 的行（RLS 应过滤为不可见）');

    const asAlice = await runWithUser(aliceId, () => getAttempt(created.attemptId));
    assert.ok(asAlice, 'alice 应能取到自己的行');
    assert.equal(asAlice!.user_id, aliceId);
    assert.equal(asAlice!.questions.length, 5, '详情应含题目');
  });

  t('completeAttempt 仓储层：越权作答抛 403、重复交卷抛 409', async () => {
    resetQuizLimiters();
    const created = await (await fetch(`${base}/api/quiz/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ topic: '模型训练', difficulty: 'beginner', count: 5 }),
    })).json() as any;
    const answers = created.questions.map((q: any) => ({
      question_id: q.id,
      choice: q.type === 'true_false' ? 'true' : (q.options?.[0]?.label ?? 'A'),
      is_correct: false,
      elapsed_ms: 15_000,
      low_confidence: false,
    }));

    await assert.rejects(
      () => runWithUser(aliceId, () => completeAttempt(created.attemptId, bobId, answers)),
      (e: any) => e.status === 403 || e.code === 'QUIZ_FORBIDDEN',
      '越权作答应抛 Forbidden',
    );
    await runWithUser(aliceId, () => completeAttempt(created.attemptId, aliceId, answers));
    await assert.rejects(
      () => runWithUser(aliceId, () => completeAttempt(created.attemptId, aliceId, answers)),
      (e: any) => e.status === 409 || e.code === 'QUIZ_ALREADY_SUBMITTED',
      '重复交卷应抛 Conflict',
    );
  });
});
