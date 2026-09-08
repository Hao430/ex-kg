/**
 * Spec J1 — 自动命名：POST /api/canvases/:id/auto-title
 *
 * 机制：monkey-patch globalThis.fetch 拦截 /responses（非流式 JSON），其余透传。
 * 断言点：
 * - 一次调用产出 nodeTitle + boardTitle（15 字钳制、JSON 解析容错）
 * - 调用落 ai_request_logs 归因（provider=openai-title、canvas_id）
 * - 模型输出非法 JSON → 200 + 双 null（非关键路径静默）
 * - 未登录 → 401
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { getAiRequestLogsForTest } from '../server/repositories/ai.repository.js';

let server: http.Server;
let base = '';
let adminCookie = '';

const origFetch = globalThis.fetch;
/** stub 场景：1=合法 JSON 标题输出 2=非法输出 */
let stubScenario: 1 | 2 = 1;

function responsesJson(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_i3',
      object: 'response',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
      usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
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

async function autoTitle(body: Record<string, unknown>, cookie = adminCookie): Promise<Response> {
  return fetch(`${base}/api/canvases/i3-board/auto-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('J1 自动命名端点', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
    });
    assert.equal(res.status, 200);
    adminCookie = (res.headers.get('set-cookie') || '').split(';')[0];

    // admin 配置 openai 模型（fake base_url + fetch stub）
    const cfg = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        openai_base_url: 'http://127.0.0.1:9/v1',
        openai_api_key: 'sk-test-i3-key-0001',
        openai_model: 'qwen-i3-test',
      }),
    });
    assert.equal(cfg.status, 200);

    // fetch 分发器：/responses → 非流式 JSON stub；其余透传原始 fetch
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('/responses')) {
        if (stubScenario === 2) return responsesJson('这不是 JSON 输出');
        return responsesJson('{"node":"表面码容错阈值推导","board":"量子纠错基础"}');
      }
      return origFetch(input, init);
    };
  });

  after(() => {
    (globalThis as any).fetch = origFetch;
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('合法输出 → nodeTitle/boardTitle 各 15 字内 + ai log 归因', async () => {
    const res = await autoTitle({
      question: '量子纠错中表面码的容错阈值是如何推导的？',
      answer: '表面码的容错阈值约为 1%，推导依赖码距与物理错误率的关系……',
      includeBoard: true,
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.success, true);
    assert.equal(body.nodeTitle, '表面码容错阈值推导');
    assert.equal(body.boardTitle, '量子纠错基础');

    const log = getAiRequestLogsForTest()[0];
    assert.equal(log.status, 'success');
    assert.equal(log.provider, 'openai-title');
    assert.equal(log.model_name, 'qwen-i3-test');
    assert.equal(log.canvas_id, 'i3-board');
    assert.equal(log.total_tokens, 70);
  });

  test('模型输出非法 JSON → 200 双 null（非关键路径静默）', async () => {
    stubScenario = 2;
    const res = await autoTitle({ question: '测试', answer: '摘录', includeBoard: true });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.nodeTitle, null);
    assert.equal(body.boardTitle, null);
  });

  test('未登录 → 401', async () => {
    const res = await autoTitle({ question: '测试' }, 'cookie=invalid');
    assert.equal(res.status, 401);
  });
});
