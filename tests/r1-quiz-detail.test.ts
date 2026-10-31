/**
 * Spec R1 — 详情 DTO：选项全文与未完成记录的安全题目。
 *
 * tests/ 只读：本文件为新增（用户 2026-10-25 授权）。
 * 关联授权改动：tests/r1-quiz-history.test.ts 的 in_progress 断言（允许安全 questions）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { saveAiModelConfig } from '../server/repositories/ai.repository.js';
import { sampleAiAdvanced } from '../docs/spike/r1-quiz-prompt-validation.js';

process.env.QUIZ_ENABLED = 'true';

let server: http.Server;
let base = '';
let cookie = '';

const origFetch = globalThis.fetch;

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
      if (((await res.json()) as any).userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vip@deepdive.ai', password: 'Vip123456!' }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function createAttempt(): Promise<any> {
  const res = await fetch(`${base}/api/quiz/attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ topic: '注意力机制', difficulty: 'beginner', count: 5 }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function submit(attemptId: string): Promise<{ status: number; body: any }> {
  const detailRes = await fetch(`${base}/api/quiz/attempts/`, { headers: { cookie } });
  void detailRes;
  const created = await fetch(`${base}/api/quiz/attempts/${attemptId}`, { headers: { cookie } });
  const view = await created.json() as any;
  const answers = view.questions.map((q: any) => ({
    questionId: q.id,
    choice: q.type === 'true_false' ? 'true' : 'A',
    elapsedMs: 5000,
  }));
  const res = await fetch(`${base}/api/quiz/attempts/${attemptId}/answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ answers }),
  });
  return { status: res.status, body: await res.json() };
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
  cookie = await signIn();
  await saveAiModelConfig({
    provider: 'openai',
    openai_base_url: 'https://example.invalid/v1',
    openai_api_key: 'stub',
    openai_model: 'stub-model',
    gemini_model: 'stub-model',
  });
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (url.includes('/responses')) {
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

describe('R1 详情 DTO', () => {
  test('completed：results 带 options 全文，判断题 options=null，仍无原始 questions', async () => {
    const created = await createAttempt();
    const graded = await submit(created.attemptId);
    assert.equal(graded.status, 200);

    const res = await fetch(`${base}/api/quiz/attempts/${created.attemptId}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.results.length, 5);

    for (const r of body.results) {
      assert.ok('options' in r, '每题应带 options');
      if (r.type === 'single') {
        assert.equal(r.options.length, 4);
        assert.deepEqual(r.options.map((o: any) => o.label).sort(), ['A', 'B', 'C', 'D']);
        assert.ok(r.options.every((o: any) => typeof o.text === 'string' && o.text.length > 0));
        assert.ok(r.options.some((o: any) => o.label === r.answer), '标准答案必须是选项之一');
      } else {
        assert.equal(r.options, null, '判断题 options 恒为 null');
      }
    }
    assert.ok(!collectKeys(body).has('questions'), '不得下发原始 questions 数组');
    for (const r of body.results) {
      assert.ok(!('correct' in r), '逐题不得出现 correct 键（summary.correct 是统计字段，允许）');
    }
  });

  test('交卷 ② 的响应同样带 options（与详情同源）', async () => {
    const created = await createAttempt();
    const graded = await submit(created.attemptId);
    assert.equal(graded.status, 200);
    const single = graded.body.results.find((r: any) => r.type === 'single');
    assert.equal(single.options.length, 4);
  });

  test('in_progress：返回安全 questions（仅 id/type/stem/options），无答案/解析/知识点', async () => {
    const created = await createAttempt();
    const res = await fetch(`${base}/api/quiz/attempts/${created.attemptId}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;

    assert.equal(body.results, undefined);
    assert.equal(body.summary, undefined);
    assert.ok(Array.isArray(body.questions), '未完成详情应返回安全题目');
    assert.equal(body.questions.length, 5);

    for (const q of body.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['id', 'options', 'stem', 'type']);
      if (q.type === 'single') assert.equal(q.options.length, 4);
      else assert.equal(q.options, null);
    }

    const keys = collectKeys(body);
    for (const forbidden of ['correct', 'explanation', 'answer', 'knowledge_point', 'is_correct']) {
      assert.ok(!keys.has(forbidden), '未完成详情不得含「' + forbidden + '」');
    }
  });
});
