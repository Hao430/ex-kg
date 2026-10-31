/**
 * Spec R1 — AI 出题链路（生成侧）的补充测试。
 *
 * 与既有测试的分工（避免重复）：
 * - `tests/r1-quiz.test.ts`：答案不下发、判卷、状态机、隔离、观测留痕（端到端主干）
 * - `tests/r1-quiz-schema.test.ts`：zod 契约 / 确定性守卫 / 洗牌三步（纯函数）
 * - **本文件**：出题**请求与容错**——上游 wire 契约、题量传递、截断判定、
 *   文本形态回退、网络异常、token 闸门、feature flag、24h 闸门、落库元信息。
 *
 * 为什么单开文件：tests/ 目录按约定只读，新增用例不改既有文件（用户 2026-10-25 授权）。
 *
 * 桩口径与 r1-quiz.test.ts 一致：出题走 openai 兼容 `/responses`，测试无有效凭据故
 * 拦截 `/responses` 返回构造响应；其余 fetch 透传。本文件额外**捕获请求体**，
 * 用于锁定 2026-10-24 线上故障的回归点——参数必须是 Responses API 的
 * `text.format`，写成 Chat Completions 的 `response_format` 会被上游 400。
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import {
  saveAiModelConfig,
  getAiRequestLogsForTest,
  recordAiRequestLog,
} from '../server/repositories/ai.repository.js';
import { quizGenerateRateLimiter } from '../server/middleware/auth.js';
import { sampleAiAdvanced } from '../docs/spike/r1-quiz-prompt-validation.js';

// ⚠️ 必须在导入 app 之前设置：feature flag 在路由处理时读取，但先设可避免竞态
process.env.QUIZ_ENABLED = 'true';

let server: http.Server;
let base = '';
let adminCookie = '';
let userCookie = '';
let vipCookie = '';
let adminId = '';
let vipId = '';

const ADMIN = { email: 'admin@deepdive.ai', password: 'Admin123456!' };
const USER = { email: 'user@deepdive.ai', password: 'User123456!' };
const VIP = { email: 'vip@deepdive.ai', password: 'Vip123456!' };

// ── 上游桩：可控制状态码 / 响应体 / 抛错，并记录每次出站请求 ──
const origFetch = globalThis.fetch;
let stubStatus = 200;
/** 覆盖默认响应体；null = 使用 quizFor(5) */
let stubBody: unknown = null;
/** 模拟网络异常（fetch 直接 reject） */
let stubThrow: Error | null = null;
let capturedRequests: Array<{ url: string; body: any }> = [];

/** 用已验证的 spike 样本构造 n 题（循环取题，题目间允许重复） */
function quizFor(n: number) {
  const baseQuiz = structuredClone(sampleAiAdvanced.output);
  return {
    ...baseQuiz,
    questions: Array.from({ length: n }, (_, i) =>
      structuredClone(baseQuiz.questions[i % baseQuiz.questions.length]),
    ),
  };
}

/** 把题目包进 /responses 的真实信封（extractResponseText 认 output[].content[].text） */
function envelope(quiz: unknown, extra: Record<string, unknown> = {}) {
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(quiz) }] }],
    usage: { total_tokens: 1500 },
    ...extra,
  };
}

function stubResponse(): Response {
  if (stubThrow) throw stubThrow;
  if (stubStatus !== 200) {
    return new Response('upstream rejected', { status: stubStatus });
  }
  return new Response(
    JSON.stringify(stubBody ?? envelope(quizFor(5))),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ── HTTP 辅助 ──
async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = await res.json() as any;
      if (body.userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

async function signIn(account: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  assert.equal(res.status, 200, `sign-in ${account.email} 应成功`);
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

async function listAttempts(cookie: string): Promise<any[]> {
  const res = await fetch(`${base}/api/quiz/attempts`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as any).attempts;
}

/** 递归收集 key，用于「答案/知识点字段不得出网」的结构性断言 */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.add(k); collectKeys(v, into); }
  }
  return into;
}

function latestLog() {
  const logs = getAiRequestLogsForTest();
  assert.ok(logs.length > 0, '调用应留下日志');
  return logs[0];
}

function lastCaptured() {
  assert.ok(capturedRequests.length > 0, '应捕获到出站请求');
  return capturedRequests[capturedRequests.length - 1];
}

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await waitSeeds();

  adminCookie = await signIn(ADMIN);
  userCookie = await signIn(USER);
  vipCookie = await signIn(VIP);
  adminId = await meId(adminCookie);
  vipId = await meId(vipCookie);

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
      let body: any = null;
      try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { /* keep null */ }
      capturedRequests.push({ url, body });
      return stubResponse();
    }
    return origFetch(input, init);
  };
});

after(async () => {
  (globalThis as any).fetch = origFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  stubStatus = 200;
  stubBody = null;
  stubThrow = null;
  capturedRequests = [];
  // 出题限流 20/min，逐用例复位避免用例间互相挤额度（vip 的 24h 闸门为不限）
  (quizGenerateRateLimiter as any).resetKey(`user_${vipId}`);
});

afterEach(() => {
  stubStatus = 200;
  stubBody = null;
  stubThrow = null;
});

// ───────────────────────── 1. 上游 wire 契约 ─────────────────────────

describe('R1 出题请求契约（provider wire）', () => {
  test('使用 Responses API 的 text.format，而非 Chat Completions 的 response_format', async () => {
    const { status } = await createAttempt(vipCookie);
    assert.equal(status, 200);

    const { body } = lastCaptured();
    assert.equal(body.text?.format?.type, 'json_schema',
      '2026-10-24 线上故障回归：结构化输出必须走 text.format（/responses 不接受 response_format）');
    assert.equal(body.text?.format?.name, 'quiz_questions');
    assert.equal(body.response_format, undefined,
      '不得同时发送 Chat Completions 的 response_format');
  });

  test('结构化 schema 的题量锁定为本次请求量，correct 带 6 值 enum', async () => {
    stubBody = envelope(quizFor(3));
    const { status, body: created } = await createAttempt(vipCookie, { count: 3 });
    assert.equal(status, 200);
    assert.equal(created.questions.length, 3, '返回题量应与请求一致');

    const schema = lastCaptured().body.text.format.schema;
    assert.equal(schema.properties.questions.minItems, 3);
    assert.equal(schema.properties.questions.maxItems, 3);
    assert.deepEqual(
      [...schema.properties.questions.items.properties.correct.enum].sort(),
      ['A', 'B', 'C', 'D', 'false', 'true'],
      'correct 的 enum 必须随请求下发（裸 string 曾让 "True" 通过上游、在本地报废整批）',
    );
  });

  test('max_output_tokens 按题量给足：4000 下限 / 每题 500', async () => {
    stubBody = envelope(quizFor(3));
    await createAttempt(vipCookie, { count: 3 });
    assert.equal(lastCaptured().body.max_output_tokens, 4000, '小题量应有 4000 下限');

    stubBody = envelope(quizFor(10));
    await createAttempt(vipCookie, { count: 10 });
    assert.equal(lastCaptured().body.max_output_tokens, 5000, '10 题应按 500/题 放宽到 5000');
  });

  test('system prompt 只走 instructions，用户主题只进 input（注入边界）', async () => {
    const topic = '独特主题XYZ-光合作用';
    await createAttempt(vipCookie, { topic });

    const { body } = lastCaptured();
    assert.ok(String(body.instructions).includes('出题专家'), '服务端系统提示词应随请求下发');
    assert.ok(!String(body.instructions).includes(topic), '用户主题不得进入 system prompt');
    assert.ok(JSON.stringify(body.input).includes(topic), '用户主题应只出现在 user message');
    assert.equal(body.stream, false, '出题必须是非流式');
    assert.equal(body.store, false, '不得让上游留存对话（隐私口径）');
    assert.equal(body.enable_thinking, false, '不得把思维链混进题目 JSON');
    assert.equal(body.systemInstruction, undefined, '不得提供客户端 systemInstruction 入参');
  });

  test('缺省 count 按 5 题出题', async () => {
    const { status, body } = await createAttempt(vipCookie, { count: undefined });
    assert.equal(status, 200);
    assert.equal(body.questions.length, 5, '未传 count 应默认为 5');
    assert.ok(JSON.stringify(lastCaptured().body.input).includes('5 道题'));
  });
});

// ───────────────────────── 2. 入参边界 ─────────────────────────

describe('R1 出题入参边界', () => {
  test('count 非法（0 / 11 / 小数 / 字符串）→ 400', async () => {
    for (const count of [0, 11, 2.5, '5']) {
      const { status } = await createAttempt(vipCookie, { count });
      assert.equal(status, 400, `count=${JSON.stringify(count)} 应被拒绝`);
    }
  });

  test('difficulty 只接受三档枚举', async () => {
    for (const difficulty of ['beginner', 'intermediate', 'advanced']) {
      const { status } = await createAttempt(vipCookie, { difficulty });
      assert.equal(status, 200, `difficulty=${difficulty} 应通过`);
    }
  });
});

// ───────────────────────── 3. 截断防护 ─────────────────────────

describe('R1 出题截断防护（不修复残缺批次）', () => {
  test('status=INCOMPLETE → 502，且不落库', async () => {
    const topic = `截断主题-${Date.now()}`;
    stubBody = envelope(quizFor(5), {
      status: 'INCOMPLETE',
      incomplete_details: { reason: 'MAX_OUTPUT_TOKENS' },
    });
    const { status, body } = await createAttempt(vipCookie, { topic });
    assert.equal(status, 502);
    assert.equal(body.code, 'QUIZ_GENERATION_FAILED');
    assert.match(String(body.review.error), /截断/);
    assert.equal(body.review.parseFailed, true);

    const logs = getAiRequestLogsForTest();
    assert.equal(logs[0].status, 'error', '截断必须记 error（不得记 success）');
    assert.match(String(logs[0].error_message), /截断/);

    const listed = await listAttempts(vipCookie);
    assert.ok(!listed.some((a) => a.topic === topic), '截断批次不得留下空练习记录');
  });

  test('incomplete_details.reason=MAX_OUTPUT_TOKENS → 502', async () => {
    stubBody = envelope(quizFor(5), { incomplete_details: { reason: 'MAX_OUTPUT_TOKENS' } });
    const { status } = await createAttempt(vipCookie);
    assert.equal(status, 502);
  });

  test('Gemini 形态 candidates.finishReason=MAX_TOKENS → 502（同一判据覆盖双 provider）', async () => {
    stubBody = envelope(quizFor(5), { candidates: [{ finishReason: 'MAX_TOKENS' }] });
    const { status, body } = await createAttempt(vipCookie);
    assert.equal(status, 502);
    assert.match(String(body.review.error), /截断/);
  });

  test('题量与请求不符（请求 5 实回 4）→ 502（.length 挡「4 道半题」）', async () => {
    stubBody = envelope(quizFor(4));
    const { status, body } = await createAttempt(vipCookie, { count: 5 });
    assert.equal(status, 502);
    assert.equal(body.review.parseFailed, true);
  });
});

// ───────────────────────── 4. 输出文本形态回退 ─────────────────────────

describe('R1 出题输出形态回退', () => {
  test('顶层 output_text → 正常解析', async () => {
    stubBody = { output_text: JSON.stringify(quizFor(5)), usage: { total_tokens: 111 } };
    const { status, body } = await createAttempt(vipCookie);
    assert.equal(status, 200);
    assert.equal(body.questions.length, 5);
    assert.equal(latestLog().total_tokens, 111, 'usage.total_tokens 应落日志');
  });

  test('Chat Completions 形态 choices[].message.content → 正常解析', async () => {
    stubBody = { choices: [{ message: { content: JSON.stringify(quizFor(5)) } }] };
    const { status } = await createAttempt(vipCookie);
    assert.equal(status, 200);
  });

  test('完全无文本 → 502 且诊断为 empty', async () => {
    stubBody = { output: [], usage: { total_tokens: 0 } };
    const { status } = await createAttempt(vipCookie);
    assert.equal(status, 502);
    assert.match(String(latestLog().error_message), /shape=empty/);
  });
});

// ───────────────────────── 5. 上游异常 ─────────────────────────

describe('R1 出题上游异常', () => {
  test('fetch 直接抛错（网络中断）→ 502，且恰好一条 error 日志', async () => {
    const before = getAiRequestLogsForTest().length;
    stubThrow = new Error('socket hang up');
    const { status, body } = await createAttempt(vipCookie);
    assert.equal(status, 502);
    assert.match(String(body.review.error), /socket hang up/);

    const logs = getAiRequestLogsForTest();
    assert.equal(logs.length - before, 1, '一次失败调用只记一条日志');
    assert.equal(logs[0].status, 'error');
  });

  test('上游 5xx → 502，日志带 HTTP 状态', async () => {
    stubStatus = 503;
    const { status } = await createAttempt(vipCookie);
    assert.equal(status, 502);
    assert.match(String(latestLog().error_message), /HTTP 503/);
  });
});

// ───────────────────────── 6. 落库元信息 ─────────────────────────

describe('R1 出题落库与投影', () => {
  test('自审结论透传，列表含主题/难度/题数且不泄漏答案与知识点', async () => {
    const topic = `落库主题-${Date.now()}`;
    const { status, body } = await createAttempt(vipCookie, {
      topic,
      difficulty: 'advanced',
      count: 5,
    });
    assert.equal(status, 200);
    assert.equal(body.review.subject, sampleAiAdvanced.output.pedagogical_analysis.subject);
    assert.equal(body.review.difficultyFit, sampleAiAdvanced.output.pedagogical_analysis.difficulty_fit);
    assert.equal(body.review.misconceptionDesign, sampleAiAdvanced.output.pedagogical_analysis.misconception_design);
    assert.equal(body.review.model, 'stub-model');

    const keys = collectKeys(body);
    for (const forbidden of ['correct', 'explanation', 'answer', 'knowledge_point']) {
      assert.ok(!keys.has(forbidden), `出题响应不得含「${forbidden}」`);
    }

    const item = (await listAttempts(vipCookie)).find((a) => a.attemptId === body.attemptId);
    assert.ok(item, '新练习应出现在历史列表');
    assert.equal(item.topic, topic);
    assert.equal(item.difficulty, 'advanced');
    assert.equal(item.total, 5, '列表题数来自 DB 聚合，不得为 0');
    for (const forbidden of ['correct', 'explanation', 'answer', 'knowledge_point', 'questions']) {
      assert.ok(!collectKeys(item).has(forbidden), `列表项不得含「${forbidden}」`);
    }
  });
});

// ───────────────────────── 7. feature flag ─────────────────────────

describe('R1 出题 feature flag', () => {
  test('QUIZ_ENABLED=false → 出题与列表一律 404（不暴露端点存在性）', async () => {
    process.env.QUIZ_ENABLED = 'false';
    try {
      const create = await createAttempt(adminCookie);
      assert.equal(create.status, 404, '关闭时出题应 404');
      const list = await fetch(`${base}/api/quiz/attempts`, { headers: { cookie: adminCookie } });
      assert.equal(list.status, 404, '关闭时列表也应 404');
    } finally {
      process.env.QUIZ_ENABLED = 'true';
    }
  });
});

// ───────────────────────── 8. 每日 token 闸门 ─────────────────────────

describe('R1 出题 token 闸门（非流式路径自建）', () => {
  test('当日累计超限 → 429 DAILY_TOKEN_QUOTA_EXCEEDED，且不发上游请求', async () => {
    // 先为 admin 落一条大额用量（内存日志，sumUserTokensSince 直接读它）
    await recordAiRequestLog({
      userId: adminId,
      modelName: 'seed-quota',
      totalTokens: 5_000_000,
      latencyMs: 1,
      status: 'success',
      provider: 'openai',
    });

    process.env.AI_DAILY_TOKEN_QUOTA = '1000';
    try {
      const before = capturedRequests.length;
      const { status, body } = await createAttempt(adminCookie);
      assert.equal(status, 429);
      assert.equal(body.code, 'DAILY_TOKEN_QUOTA_EXCEEDED');
      assert.equal(capturedRequests.length, before, '超限应在发请求前拦下（不消耗上游配额）');
    } finally {
      delete process.env.AI_DAILY_TOKEN_QUOTA;
    }
  });

  test('AI_DAILY_TOKEN_QUOTA=0 表示不限 → 放行', async () => {
    process.env.AI_DAILY_TOKEN_QUOTA = '0';
    try {
      const { status } = await createAttempt(adminCookie);
      assert.equal(status, 200, '0 应视为不限（已累计 5M tokens 仍放行）');
    } finally {
      delete process.env.AI_DAILY_TOKEN_QUOTA;
    }
  });
});

// ───────────────────────── 9. 24h 练习次数闸门 ─────────────────────────

describe('R1 出题 24h 闸门', () => {
  test('体验版第 21 次出题 → 429 QUIZ_DAILY_LIMIT_REACHED', async () => {
    // user@ 在本文件内只用于本用例，故从零计数
    for (let i = 0; i < 20; i++) {
      const { status } = await createAttempt(userCookie);
      assert.equal(status, 200, `第 ${i + 1} 次应成功`);
    }

    // 20/min 与 24h 同为 20：先复位分钟桶，确保第 21 次命中的是 24h 闸门
    (quizGenerateRateLimiter as any).resetKey(`user_${await meId(userCookie)}`);

    const { status, body } = await createAttempt(userCookie);
    assert.equal(status, 429);
    assert.equal(body.code, 'QUIZ_DAILY_LIMIT_REACHED', '应命中 24h 闸门而非分钟限流');
  });
});
