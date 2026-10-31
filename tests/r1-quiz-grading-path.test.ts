/**
 * Spec R1 — 作答 / 标准答案的**数据来源链路**测试。
 *
 * 链路（本文件逐段锁定）：
 *   客户端 answers[{questionId, choice, elapsedMs}]
 *     → AnswersSubmitSchema（zod：未知键剥离、choice 仅 string）
 *     → gradeAttempt 从**服务端存储的 attempt.questions**取 correct（客户端不可影响）
 *     → validateSubmission 用**存储题目的类型/选项标签**校验 choice
 *     → is_correct = choice === stored.correct（确定性比对，不调模型）
 *     → completeAttempt 落库后**回读** answers/questions 生成响应
 *
 * 因此「你的作答」来自请求体、「标准答案」来自出题时落库的 questions JSONB，
 * 两者在服务端比对；客户端多传的 correct / isCorrect / answer 一律无效。
 *
 * 为什么单开文件：tests/ 按约定只读，仅**新增**文件（用户 2026-10-25 授权）。
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { saveAiModelConfig } from '../server/repositories/ai.repository.js';
import { quizGenerateRateLimiter } from '../server/middleware/auth.js';
import { sampleAiAdvanced } from '../docs/spike/r1-quiz-prompt-validation.js';

process.env.QUIZ_ENABLED = 'true';

let server: http.Server;
let base = '';
let vipCookie = '';
let vipId = '';

const origFetch = globalThis.fetch;
let capturedCount = 0;

/** /responses 桩：返回 spike 已验证的 5 题，并计数出站调用（用于「判卷不调模型」） */
function envelope(quiz: unknown) {
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(quiz) }] }],
    usage: { total_tokens: 1500 },
  };
}

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function createAttempt(cookie: string): Promise<any> {
  const res = await fetch(`${base}/api/quiz/attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ topic: '注意力机制', difficulty: 'beginner', count: 5 }),
  });
  assert.equal(res.status, 200, '出题应成功');
  return res.json();
}

async function submit(
  cookie: string,
  attemptId: string,
  answers: Array<Record<string, unknown>>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/quiz/attempts/${attemptId}/answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ answers }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

/** 一组「全选同一标签」的作答（单选填标签，判断题填 true） */
function uniformAnswers(questions: any[], singleLabel: string, tfChoice = 'true', elapsedMs = 5000) {
  return questions.map((q) => ({
    questionId: q.id,
    choice: q.type === 'true_false' ? tfChoice : singleLabel,
    elapsedMs,
  }));
}

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.add(k); collectKeys(v, into); }
  }
  return into;
}

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await waitSeeds();
  vipCookie = await signIn('vip@deepdive.ai', 'Vip123456!');
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: vipCookie } });
  vipId = ((await me.json()) as any).user.id;

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
      capturedCount += 1;
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
  capturedCount = 0;
  (quizGenerateRateLimiter as any).resetKey(`user_${vipId}`);
});

// ───────────────────── 1. 标准答案的来源 ─────────────────────

describe('R1 标准答案来源：服务端存储，客户端不可影响', () => {
  test('标准答案随题目存储：重新洗牌后仍指向同一选项文本', async () => {
    // 第 1 次：全选 A，读出每题的标准答案（单选为标签，判断题为小写值）
    const first = await createAttempt(vipCookie);
    const firstRes = await submit(vipCookie, first.attemptId, uniformAnswers(first.questions, 'A'));
    assert.equal(firstRes.status, 200);

    const correctTextByStem = new Map<string, string>();
    let tfAnswer = '';
    for (const r of firstRes.body.results) {
      const q = first.questions.find((x: any) => x.id === r.questionId);
      if (r.type === 'single') {
        assert.ok(q.options.some((o: any) => o.label === r.answer), 'answer 必须是存储题目的合法标签');
        correctTextByStem.set(r.stem, q.options.find((o: any) => o.label === r.answer).text);
      } else {
        tfAnswer = r.answer;
        assert.ok(['true', 'false'].includes(r.answer), '判断题 answer 必须是小写契约值');
      }
    }

    // 第 2 次：服务端重新洗牌（正确标签会变），按正确**文本**反查新标签 → 应全对
    const second = await createAttempt(vipCookie);
    const secondAnswers = second.questions.map((q: any) => ({
      questionId: q.id,
      choice: q.type === 'true_false'
        ? tfAnswer
        : q.options.find((o: any) => o.text === correctTextByStem.get(q.stem))?.label,
      elapsedMs: 5000,
    }));
    const secondRes = await submit(vipCookie, second.attemptId, secondAnswers);
    assert.equal(secondRes.status, 200);
    for (const r of secondRes.body.results) {
      const submitted = secondAnswers.find((a) => a.questionId === r.questionId)!;
      assert.equal(r.isCorrect, true, '按标准答案文本作答应全对（洗牌不改变答案语义）');
      assert.equal(r.answer, submitted.choice, '返回的 answer 应等于本次的正确标签');
    }

    // 第 3 次：只把一道单选改成另一标签 → 恰好该题错，其余仍对
    const third = await createAttempt(vipCookie);
    const thirdAnswers = third.questions.map((q: any) => ({
      questionId: q.id,
      choice: q.type === 'true_false'
        ? tfAnswer
        : q.options.find((o: any) => o.text === correctTextByStem.get(q.stem))?.label,
      elapsedMs: 5000,
    }));
    const target = third.questions.find((q: any) => q.type === 'single');
    const targetAnswer = thirdAnswers.find((a) => a.questionId === target.id)!;
    targetAnswer.choice = ['A', 'B', 'C', 'D'].find((l) => l !== targetAnswer.choice)!;

    const thirdRes = await submit(vipCookie, third.attemptId, thirdAnswers);
    assert.equal(thirdRes.status, 200);
    const wrong = thirdRes.body.results.filter((r: any) => !r.isCorrect);
    assert.equal(wrong.length, 1, '只改一题应恰好错一题');
    assert.equal(wrong[0].questionId, target.id);
    assert.notEqual(wrong[0].answer, targetAnswer.choice, '错题的 answer 不得被作答覆盖');
  });

  test('isCorrect 恒等于「本次 choice === 返回的 answer」（逐题）', async () => {
    const created = await createAttempt(vipCookie);
    // 故意按 A/B/C/D 轮转（每道单选只有一个正确标签 → 4 道里至少 3 道必错），同时覆盖对/错两侧
    const singleLabels = ['A', 'B', 'C', 'D'];
    const answers = created.questions.map((q: any, i: number) => ({
      questionId: q.id,
      choice: q.type === 'true_false' ? 'true' : singleLabels[i % singleLabels.length],
      elapsedMs: 4000,
    }));
    const { status, body } = await submit(vipCookie, created.attemptId, answers);
    assert.equal(status, 200);

    for (const r of body.results) {
      const submitted = answers.find((a) => a.questionId === r.questionId)!;
      assert.equal(
        r.isCorrect,
        submitted.choice === r.answer,
        `${r.questionId}: isCorrect 必须由 choice 与标准答案的严格相等决定`,
      );
      assert.equal(r.elapsedMs, submitted.elapsedMs, '回显用时必须来自本次提交，不得重算');
    }
    assert.ok(body.results.some((r: any) => !r.isCorrect), '混合选择应至少有一道错题（用于覆盖 false 分支）');
  });

  test('题干 / 解析 / 知识点来自存储题目，而不是请求体', async () => {
    const created = await createAttempt(vipCookie);
    const { body } = await submit(vipCookie, created.attemptId, uniformAnswers(created.questions, 'A'));
    const sampleByStem = new Map(sampleAiAdvanced.output.questions.map((q) => [q.stem, q]));

    for (const r of body.results) {
      const stored = sampleByStem.get(r.stem);
      assert.ok(stored, '题干应来自出题时写入的题目');
      assert.equal(r.knowledgePoint, stored.knowledge_point, '知识点应来自存储题目');
      assert.equal(r.explanation, stored.explanation, '解析应来自存储题目');
    }
  });
});

// ───────────────────── 2. 客户端伪造字段 ─────────────────────

describe('R1 作答来源：客户端不能伪造判卷结果/标准答案', () => {
  test('answers 里注入 isCorrect / correct / answer 一律被剥离，判卷仍按服务端答案', async () => {
    const created = await createAttempt(vipCookie);
    const forged = created.questions.map((q: any, i: number) => ({
      questionId: q.id,
      choice: q.type === 'true_false' ? 'true' : ['A', 'B', 'C', 'D'][i % 4],
      elapsedMs: 3000,
      // 以下均为客户端伪造：zod 未声明 → 剥离；即便透传也不得参与判卷
      isCorrect: true,
      correct: 'A',
      answer: 'A',
      lowConfidence: false,
    }));

    const { status, body } = await submit(vipCookie, created.attemptId, forged);
    assert.equal(status, 200);
    for (const r of body.results) {
      const submitted = forged.find((a) => a.questionId === r.questionId)!;
      assert.equal(r.isCorrect, submitted.choice === r.answer,
        '判卷只能由 choice 与标准答案比对，不得被 isCorrect/correct 入参左右');
    }
    assert.ok(body.results.some((r: any) => !r.isCorrect), '若注入生效则全部为 true，本断言会失败');
  });

  test('同一 attempt 的多余字段（如 groundTruth）不影响响应结构', async () => {
    const created = await createAttempt(vipCookie);
    const res = await fetch(`${base}/api/quiz/attempts/${created.attemptId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: vipCookie },
      body: JSON.stringify({
        groundTruth: ['A', 'B'],
        answers: uniformAnswers(created.questions, 'A'),
      }),
    });
    assert.equal(res.status, 200);
    const keys = collectKeys(await res.json());
    for (const k of ['groundTruth', 'isCorrect']) {
      // isCorrect 是判卷结果的合法字段；这里只断言顶层伪造字段未回显
      if (k === 'groundTruth') assert.ok(!keys.has(k), '不得回显客户端伪造字段');
    }
  });
});

// ───────────────────── 3. 作答校验与映射 ─────────────────────

describe('R1 作答校验：来源与题目必须一一对应', () => {
  let attempt: any;

  beforeEach(async () => {
    attempt = await createAttempt(vipCookie);
  });

  test('缺题 / 多题 / 重复 questionId / 未知 questionId → 400 QUIZ_ANSWERS_INCOMPLETE', async () => {
    const all = uniformAnswers(attempt.questions, 'A');

    const cases: Array<[string, Array<Record<string, unknown>>]> = [
      ['少答一题', all.slice(0, 4)],
      ['多答一题', [...all, { questionId: 'unknown', choice: 'A', elapsedMs: 1000 }]],
      ['重复 questionId', [all[0], ...all.slice(1, 4), { ...all[0] }]],
      ['未知 questionId 顶替', [{ ...all[0], questionId: 'unknown' }, ...all.slice(1)]],
    ];

    for (const [name, answers] of cases) {
      const { status, body } = await submit(vipCookie, attempt.attemptId, answers);
      assert.equal(status, 400, name + ' 应 400');
      assert.equal(body.code, 'QUIZ_ANSWERS_INCOMPLETE', name + ' 应命中完整性校验');
    }
  });

  test('非法选项（越界标签 / 大小写 / 空白 / 题型错配）→ 400 QUIZ_CHOICE_INVALID', async () => {
    const all = uniformAnswers(attempt.questions, 'A');
    const singleIdx = attempt.questions.findIndex((q: any) => q.type === 'single');
    const tfIdx = attempt.questions.findIndex((q: any) => q.type === 'true_false');

    const variants: Array<[string, string, number]> = [
      ['单选传 E', 'E', singleIdx],
      ['单选传小写 a', 'a', singleIdx],
      ['单选传带空白 A', ' A ', singleIdx],
      ['判断传 True', 'True', tfIdx],
      ['判断传 A', 'A', tfIdx],
    ];

    for (const [name, choice, idx] of variants) {
      const answers = all.map((a, i) => (i === idx ? { ...a, choice } : a));
      const { status, body } = await submit(vipCookie, attempt.attemptId, answers);
      assert.equal(status, 400, name + ' 应 400');
      assert.equal(body.code, 'QUIZ_CHOICE_INVALID', name + ' 应命中选项校验');
    }
  });

  test('作答乱序提交：按 questionId 映射，不按数组下标', async () => {
    const answers = uniformAnswers(attempt.questions, 'A').reverse();
    const { status, body } = await submit(vipCookie, attempt.attemptId, answers);
    assert.equal(status, 200, '乱序不影响判卷');

    // 若实现按下标配对，isCorrect 会与「该题 choice vs 该题 answer」不一致
    for (const r of body.results) {
      const submitted = answers.find((a) => a.questionId === r.questionId)!;
      assert.equal(r.isCorrect, submitted.choice === r.answer, '必须按 questionId 映射作答');
    }
  });

  test('用时边界：0 / 99ms 拒绝，100ms 接受', async () => {
    for (const elapsedMs of [0, 99]) {
      const { status, body } = await submit(
        vipCookie,
        attempt.attemptId,
        uniformAnswers(attempt.questions, 'A', 'true', elapsedMs),
      );
      assert.equal(status, 400, `elapsedMs=${elapsedMs} 应 400`);
      assert.equal(body.code, 'QUIZ_ELAPSED_INVALID');
    }

    // 100ms 是合法下界；attempt 刚创建，总耗时仍在允许窗口内
    const { status } = await submit(
      vipCookie,
      attempt.attemptId,
      uniformAnswers(attempt.questions, 'A', 'true', 100),
    );
    assert.equal(status, 200, 'elapsedMs=100 应接受');
  });
});

// ───────────────────── 4. 判卷不调模型 / 不覆盖 ─────────────────────

describe('R1 判卷的确定性', () => {
  test('交卷过程中不发起任何模型调用（标准答案是本地比对）', async () => {
    const created = await createAttempt(vipCookie);
    const before = capturedCount;
    const { status } = await submit(vipCookie, created.attemptId, uniformAnswers(created.questions, 'A'));
    assert.equal(status, 200);
    assert.equal(capturedCount, before, '判卷不得调用 AI（标准答案已在出题时落库）');
  });

  test('列表 correctCount：未提交为 null，交卷后等于小结 correct', async () => {
    const created = await createAttempt(vipCookie);
    const listBefore = await fetch(`${base}/api/quiz/attempts`, { headers: { cookie: vipCookie } });
    const before = (await listBefore.json() as any).attempts
      .find((a: any) => a.attemptId === created.attemptId);
    assert.equal(before.correctCount, null, '未提交的记录不应有成绩');

    const { body } = await submit(vipCookie, created.attemptId, uniformAnswers(created.questions, 'A'));
    const listAfter = await fetch(`${base}/api/quiz/attempts`, { headers: { cookie: vipCookie } });
    const after = (await listAfter.json() as any).attempts
      .find((a: any) => a.attemptId === created.attemptId);
    assert.equal(after.status, 'completed');
    assert.equal(after.correctCount, body.summary.correct,
      '列表成绩必须与交卷小结一致（此前恒为 null，历史页「掌握 X/Y」永不显示）');
    assert.equal(after.total, created.questions.length);
  });

  test('重复提交 409 且不覆盖首次判卷结果', async () => {
    const created = await createAttempt(vipCookie);
    const first = await submit(vipCookie, created.attemptId, uniformAnswers(created.questions, 'A'));
    assert.equal(first.status, 200);
    const firstCorrect = first.body.summary.correct;

    // 换一套完全相反的答案再交：若覆盖成功，correctCount 会变化
    const opposite = created.questions.map((q: any) => ({
      questionId: q.id,
      choice: q.type === 'true_false' ? 'false' : 'D',
      elapsedMs: 5000,
    }));
    const second = await submit(vipCookie, created.attemptId, opposite);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'QUIZ_ALREADY_SUBMITTED');

    const res = await fetch(`${base}/api/quiz/attempts`, { headers: { cookie: vipCookie } });
    const list = (await res.json() as any).attempts;
    const item = list.find((a: any) => a.attemptId === created.attemptId);
    assert.equal(item.correctCount, firstCorrect, '二次提交不得覆盖首次判卷结果');
  });

  test('交卷后详情返回逐题回放，但不下发原始 questions', async () => {
    const created = await createAttempt(vipCookie);
    const answers = uniformAnswers(created.questions, 'A');
    await submit(vipCookie, created.attemptId, answers);

    const res = await fetch(`${base}/api/quiz/attempts/${created.attemptId}`, {
      headers: { cookie: vipCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.results), '已交卷详情应返回逐题结果');
    assert.equal(body.results.length, created.questions.length);
    for (const r of body.results) {
      const submitted = answers.find((a) => a.questionId === r.questionId)!;
      assert.equal(r.choice, submitted.choice, '「你的作答」应来自提交记录');
      assert.ok(r.answer, '「标准答案」应来自存储题目');
    }
    const keys = collectKeys(body);
    assert.ok(!keys.has('questions'), '不得下发原始 questions 数组（含 correct 对象）');
  });
});
