/**
 * Spec R1 — 做题记录 CRUD（分页 / 详情回放 / 删除 / 清空 / 幂等）的 RED 用例。
 *
 * 对应修复计划（2026-10-25）：
 * - GET /attempts 支持 page/limit，返回 total/hasMore；
 * - GET /attempts/:id 对已交卷属主返回 results + summary，且「你的作答」为 choice；
 * - DELETE /attempts/:id 与 DELETE /attempts；
 * - POST /attempts 支持客户端 attemptId 幂等（串行/并发均只调一次模型）。
 *
 * tests/ 只读约定：本文件为**新增**（用户 2026-10-25 授权）；
 * 唯一既有改动是 tests/r1-quiz-grading-path.test.ts 的详情断言（同批授权）。
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { saveAiModelConfig } from '../server/repositories/ai.repository.js';
import { getAuditLogsForTest } from '../server/repositories/audit.repository.js';
import { createAttempt as repoCreateAttempt } from '../server/repositories/quiz.repository.js';
import { quizGenerateRateLimiter } from '../server/middleware/auth.js';
import type { QuizQuestionRecord } from '../server/core/records.js';
import { sampleAiAdvanced } from '../docs/spike/r1-quiz-prompt-validation.js';

process.env.QUIZ_ENABLED = 'true';

let server: http.Server;
let base = '';
let vipCookie = '';
let userCookie = '';
let vipId = '';
let userId = '';

const origFetch = globalThis.fetch;
let aiCalls = 0;

function envelope(quiz: unknown) {
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(quiz) }] }],
    usage: { total_tokens: 1500 },
  };
}

function seedQuestions(): QuizQuestionRecord[] {
  return structuredClone(sampleAiAdvanced.output.questions).map((q) => ({
    ...q,
    id: crypto.randomUUID(),
  })) as QuizQuestionRecord[];
}

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      if (((await res.json()) as any).userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function meId(cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as any).user.id;
}

async function createAttempt(
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/quiz/attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ topic: '注意力机制', difficulty: 'beginner', count: 5, ...overrides }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function submitAnswers(
  cookie: string,
  attemptId: string,
  answers: Array<{ questionId: string; choice: string; elapsedMs: number }>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/quiz/attempts/${attemptId}/answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ answers }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

function allFirst(questions: any[]) {
  return questions.map((q) => ({
    questionId: q.id,
    choice: q.type === 'true_false' ? 'true' : 'A',
    elapsedMs: 5000,
  }));
}

async function list(cookie: string, query = ''): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/quiz/attempts${query}`, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function detail(cookie: string, id: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/quiz/attempts/${id}`, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function del(cookie: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/quiz/attempts${path}`, { method: 'DELETE', headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.add(k); collectKeys(v, into); }
  }
  return into;
}

async function seedAttempt(userIdValue: string, topic: string): Promise<string> {
  const id = crypto.randomUUID();
  await repoCreateAttempt({
    id,
    userId: userIdValue,
    topic,
    difficulty: 'beginner',
    questions: seedQuestions(),
    review: {},
  });
  return id;
}

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await waitSeeds();
  vipCookie = await signIn('vip@deepdive.ai', 'Vip123456!');
  userCookie = await signIn('user@deepdive.ai', 'User123456!');
  vipId = await meId(vipCookie);
  userId = await meId(userCookie);

  await saveAiModelConfig({
    provider: 'openai',
    openai_base_url: 'https://example.invalid/v1',
    openai_api_key: 'stub-key-for-tests',
    openai_model: 'stub-model',
    gemini_model: 'stub-model',
    temperature: 0.7,
    max_tokens: 4096,
  });

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (url.includes('/responses')) {
      aiCalls += 1;
      return new Response(JSON.stringify(envelope(sampleAiAdvanced.output)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return origFetch(input, init);
  };
});

after(async () => {
  (globalThis as any).fetch = origFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  aiCalls = 0;
  (quizGenerateRateLimiter as any).resetKey(`user_${vipId}`);
  (quizGenerateRateLimiter as any).resetKey(`user_${userId}`);
});

// ───────────────────────── 1. 分页 ─────────────────────────

describe('R1 记录列表分页', () => {
  test('默认 20 条并返回 total/hasMore；第 2 页补齐且两页无重复', async () => {
    for (let i = 0; i < 25; i++) await seedAttempt(vipId, `分页主题 ${i}`);

    const page1 = await list(vipCookie);
    assert.equal(page1.status, 200);
    assert.equal(page1.body.attempts.length, 20, '默认页大小应为 20');
    assert.equal(page1.body.total, 25, '应返回总条数');
    assert.equal(page1.body.page, 1);
    assert.equal(page1.body.limit, 20);
    assert.equal(page1.body.hasMore, true);

    const page2 = await list(vipCookie, '?page=2&limit=20');
    assert.equal(page2.status, 200);
    assert.equal(page2.body.attempts.length, 5);
    assert.equal(page2.body.hasMore, false);

    const ids = new Set(page1.body.attempts.map((a: any) => a.attemptId));
    for (const a of page2.body.attempts) {
      assert.ok(!ids.has(a.attemptId), '两页不得重复');
      ids.add(a.attemptId);
    }
    assert.equal(ids.size, 25, '两页合计应覆盖全部 25 条');
  });

  test('非法 page/limit → 400', async () => {
    for (const q of ['?page=0', '?page=abc', '?limit=0', '?limit=51', '?limit=abc']) {
      const { status } = await list(vipCookie, q);
      assert.equal(status, 400, q + ' 应 400');
    }
  });

  test('limit 上限 50 生效', async () => {
    const { status, body } = await list(vipCookie, '?limit=50');
    assert.equal(status, 200);
    assert.equal(body.limit, 50);
    assert.ok(body.attempts.length <= 50);
  });

  test('列表仍不泄漏题目/答案字段', async () => {
    const { body } = await list(vipCookie);
    const keys = collectKeys(body);
    for (const forbidden of ['questions', 'answers', 'correct', 'explanation', 'answer', 'knowledge_point']) {
      assert.ok(!keys.has(forbidden), '列表不得含「' + forbidden + '」');
    }
  });
});

// ───────────────────────── 2. 详情回放 ─────────────────────────

describe('R1 详情扩展：已交卷回放', () => {
  test('completed 返回 results + summary，choice 与 answer 分离；不含原始 questions', async () => {
    const created = await createAttempt(vipCookie);
    assert.equal(created.status, 200);
    const answers = allFirst(created.body.questions);
    const graded = await submitAnswers(vipCookie, created.body.attemptId, answers);
    assert.equal(graded.status, 200);

    const { status, body } = await detail(vipCookie, created.body.attemptId);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.results), '已交卷详情应含 results');
    assert.equal(body.results.length, 5);
    assert.equal(body.summary.correct, graded.body.summary.correct);
    assert.equal(body.summary.total, 5);
    assert.equal(body.status, 'completed');

    for (const r of body.results) {
      const submitted = answers.find((a) => a.questionId === r.questionId)!;
      assert.equal(r.choice, submitted.choice, 'choice 必须是用户实际作答');
      assert.equal(typeof r.answer, 'string', 'answer 仍是标准答案');
      assert.ok(r.explanation, '解析应来自存储题目');
      assert.equal(r.isCorrect, submitted.choice === r.answer);
    }

    const keys = collectKeys(body);
    assert.ok(!keys.has('questions'), '不得下发原始 questions 数组（含 correct 对象）');
  });

  test('in_progress 详情：返回安全题目，但仍不含 results / 答案', async () => {
    const created = await createAttempt(vipCookie);
    const { status, body } = await detail(vipCookie, created.body.attemptId);
    assert.equal(status, 200);
    assert.equal(body.results, undefined);
    assert.equal(body.summary, undefined);
    assert.ok(Array.isArray(body.questions), '未完成详情应返回可续答的安全题目');
    for (const q of body.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['id', 'options', 'stem', 'type'], '题目只含展示字段');
    }
    const keys = collectKeys(body);
    for (const forbidden of ['correct', 'explanation', 'answer', 'knowledge_point']) {
      assert.ok(!keys.has(forbidden), '未交卷详情不得含「' + forbidden + '」');
    }
  });

  test('他人/不存在 → 404', async () => {
    const created = await createAttempt(vipCookie);
    assert.equal((await detail(userCookie, created.body.attemptId)).status, 404);
    assert.equal((await detail(vipCookie, crypto.randomUUID())).status, 404);
  });
});

// ───────────────────────── 3. 删除 / 清空 ─────────────────────────

describe('R1 记录删除与清空', () => {
  test('单条删除：成功后详情/列表消失，重复删除 404', async () => {
    const created = await createAttempt(vipCookie);
    const id = created.body.attemptId;

    const first = await del(vipCookie, `/${id}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { success: true, deleted: 1 });
    assert.equal((await detail(vipCookie, id)).status, 404);
    assert.equal((await del(vipCookie, `/${id}`)).status, 404, '重复删除应 404');

    const { body } = await list(vipCookie, '?limit=50');
    assert.ok(!body.attempts.some((a: any) => a.attemptId === id));
  });

  test('非属主删除 → 404，且记录仍在', async () => {
    const created = await createAttempt(vipCookie);
    const id = created.body.attemptId;

    assert.equal((await del(userCookie, `/${id}`)).status, 404);
    assert.equal((await detail(vipCookie, id)).status, 200, '属主记录不得被他人删除');
  });

  test('清空全部只清本人，返回删除条数', async () => {
    // user 两条、vip 一条（vip 的用于验证不跨租户）
    await seedAttempt(userId, '待清空 A');
    await seedAttempt(userId, '待清空 B');
    const vipRecord = await seedAttempt(vipId, '不应被清空');

    const res = await del(userCookie, '');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.deleted, 2);

    const userList = await list(userCookie, '?limit=50');
    assert.equal(userList.body.total, 0, '本人记录应清空');
    assert.equal((await detail(vipCookie, vipRecord)).status, 200, '他人记录不得被清空');
  });

  test('删除/清空写审计，且 details 不含主题/题目内容', async () => {
    const created = await createAttempt(vipCookie, { topic: '审计主题-不应入日志' });
    const id = created.body.attemptId;
    await del(vipCookie, `/${id}`);

    const logs = getAuditLogsForTest();
    const one = logs.find((l) => l.action === 'quiz_attempt_delete' && l.target_id === id);
    assert.ok(one, '单条删除应写审计');
    assert.equal(one!.user_id, vipId);
    assert.equal(one!.target_type, 'quiz_attempt');
    assert.ok(!JSON.stringify(one).includes('审计主题'), '审计不得包含主题');

    const before = logs.filter((l) => l.action === 'quiz_attempt_delete_all').length;
    const res = await del(vipCookie, '');
    assert.equal(res.status, 200);
    const after = getAuditLogsForTest().filter((l) => l.action === 'quiz_attempt_delete_all');
    assert.equal(after.length, before + 1, '清空应写一条审计');
    assert.equal(after[0].details.count, res.body.deleted);
  });
});

// ───────────────────────── 4. 创建幂等 ─────────────────────────

describe('R1 创建幂等（attemptId）', () => {
  test('同一 attemptId 串行提交两次：只调一次模型，返回同一记录', async () => {
    const id = crypto.randomUUID();
    const first = await createAttempt(vipCookie, { attemptId: id });
    const second = await createAttempt(vipCookie, { attemptId: id });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.attemptId, id, '应使用客户端提供的 id');
    assert.equal(second.body.attemptId, id);
    assert.equal(aiCalls, 1, '重复提交不得再次调用模型');
    assert.deepEqual(
      second.body.questions.map((q: any) => q.id),
      first.body.questions.map((q: any) => q.id),
      '应返回同一批题目',
    );
  });

  test('同一 attemptId 并发提交：合并为一次生成', async () => {
    const id = crypto.randomUUID();
    const [a, b] = await Promise.all([
      createAttempt(vipCookie, { attemptId: id }),
      createAttempt(vipCookie, { attemptId: id }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.attemptId, id);
    assert.equal(b.body.attemptId, id);
    assert.equal(aiCalls, 1, '并发同 id 只应生成一次');
  });

  test('他人占用同一 attemptId → 404；非法 id → 400', async () => {
    const id = crypto.randomUUID();
    assert.equal((await createAttempt(vipCookie, { attemptId: id })).status, 200);

    const stolen = await createAttempt(userCookie, { attemptId: id });
    assert.equal(stolen.status, 404, '不得确认他人记录存在');

    assert.equal((await createAttempt(vipCookie, { attemptId: 'not-a-uuid' })).status, 400);
  });

  test('未提供 attemptId 时仍由服务端生成', async () => {
    const { status, body } = await createAttempt(vipCookie);
    assert.equal(status, 200);
    assert.match(body.attemptId, /^[0-9a-f-]{36}$/i);
  });
});
