/**
 * Spec I — AI 推理日志可观测扩列
 *
 * 机制：monkey-patch globalThis.fetch 拦截 chat.ts 对千问 /responses 的调用（先例 h2）。
 * 断言点：
 * - 正常链路：provider='openai'、web_search_calls、raw_sources_count（截断前）、ttft_ms
 * - 35 源截断：raw_sources_count=35、sources_truncated=true、落库 grounding_chunks_count=30
 * - 客户端中断（挂起上游流 + AbortController）：aborted=true 的 ai log + chat_client_abort 事件
 * 注：fallback/reset 走 @google/genai SDK 内部 fetch，无法经 globalThis.fetch 分发器拦截，
 *     相关断言豁免（候选降级计数逻辑与 web_search_call 同型，由代码评审覆盖）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { getAiRequestLogsForTest } from '../server/repositories/ai.repository.js';
import { getEventLogsForTest } from '../server/repositories/event-log.repository.js';

// ADR-0024 出站守卫：本套件刻意把模型地址指向回环（`http://127.0.0.1:9/v1`，由 fetch stub 拦截），
// 守卫默认拒绝回环/内网与明文 http，故显式翻开开关（守卫默认值保持严格，不因测试放宽）。
process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS = 'true';

let server: http.Server;
let base = '';
let adminCookie = '';

const origFetch = globalThis.fetch;
/** stub 场景：1=正常（2 源 1 搜索） 2=截断（35 源） 3=挂起流（供客户端中断） */
let stubScenario: 1 | 2 | 3 = 1;
/** 最近一次 /responses 请求体（断言 tool_choice 联网策略用） */
let lastResponsesBody: any = null;

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function scenario1Response(): Response {
  return sse([
    {
      type: 'response.output_item.done',
      item: {
        type: 'web_search_call',
        action: {
          query: '检索词',
          sources: [
            { url: 'https://example.com/a', title: 'A' },
            { url: 'https://example.com/b', title: 'B' },
          ],
        },
      },
    },
    { type: 'response.output_text.delta', delta: '回答正文 [1]。' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]);
}

function scenario2Response(): Response {
  const sources = Array.from({ length: 35 }, (_, i) => ({ url: `https://s${i}.example.com/x`, title: `来源${i}` }));
  return sse([
    { type: 'response.output_item.done', item: { type: 'web_search_call', action: { sources } } },
    { type: 'response.output_text.delta', delta: '正文' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
}

/** 上游流只发一个 delta 后永久挂起（不 enqueue 也不 close），客户端将主动断连 */
function hangingResponse(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '首字' })}\n\n`)
        );
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
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

function parseSse(raw: string): any[] {
  return raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => {
      try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
    })
    .filter(Boolean);
}

async function chat(body: Record<string, unknown>, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify(body),
    ...init,
  });
}

describe('I2 AI 推理日志可观测扩列', () => {
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
    adminCookie = (res.headers.get('set-cookie') || '').split(';')[0];

    // fetch 分发器：/responses → stub SSE；其余透传原始 fetch
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('/responses')) {
        try { lastResponsesBody = JSON.parse(init?.body || '{}'); } catch { lastResponsesBody = null; }
        if (stubScenario === 2) return scenario2Response();
        if (stubScenario === 3) return hangingResponse();
        return scenario1Response();
      }
      return origFetch(input, init);
    };

    // admin 配置 openai 模型走 PATH A（fake base_url + stub）
    const cfg = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        openai_base_url: 'http://127.0.0.1:9/v1',
        openai_api_key: 'sk-test-i2-key-0001',
        openai_model: 'qwen-i2-test',
      }),
    });
    assert.equal(cfg.status, 200);
  });

  after(() => {
    (globalThis as any).fetch = origFetch;
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('PATH A 正常链路 → provider/web_search_calls/raw_sources_count/ttft 落日志', async () => {
    stubScenario = 1;
    const res = await chat({ messages: [{ role: 'user', content: '量子纠错是什么' }], canvasId: 'i2-board' });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    assert.ok(events.find((e) => e.done), '应有 done 事件');

    // 内存存储 newest-first（unshift），logs[0] 为最新一条
    const log = getAiRequestLogsForTest()[0];
    assert.equal(log.status, 'success');
    assert.equal(log.provider, 'openai');
    assert.equal(log.model_name, 'qwen-i2-test');
    assert.equal(log.web_search_calls, 1);
    assert.equal(log.raw_sources_count, 2);
    assert.equal(log.sources_truncated, false);
    assert.ok(typeof log.ttft_ms === 'number' && log.ttft_ms >= 0);
    // force_web_search 默认开（存量配置无该字段由 DEFAULT 合并补全）→ 单工具场景 tool_choice:'required'
    assert.equal(lastResponsesBody?.tool_choice, 'required');
    assert.deepEqual(lastResponsesBody?.tools, [{ type: 'web_search' }]);
  });

  test('35 源截断 → raw_sources_count=35 / sources_truncated=true / 落库 30', async () => {
    stubScenario = 2;
    const res = await chat({ messages: [{ role: 'user', content: '截断测试' }], canvasId: 'i2-board' });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    assert.ok(events.find((e) => e.done));

    const log = getAiRequestLogsForTest()[0];
    assert.equal(log.raw_sources_count, 35, '截断前原始来源数应落日志');
    assert.equal(log.sources_truncated, true);
    assert.equal(log.grounding_chunks_count, 30, '截断后实际保留数应落审计');
    assert.equal(log.web_search_calls, 1);
  });

  test('客户端中断 → aborted=true 的 ai log + chat_client_abort 事件', async () => {
    stubScenario = 3;
    const controller = new AbortController();
    const res = await chat(
      { messages: [{ role: 'user', content: '中断测试' }], canvasId: 'i2-board' },
      { signal: controller.signal }
    );
    assert.equal(res.status, 200);

    const reader = (res.body as any).getReader();
    await reader.read(); // 读到首字后立即断连
    controller.abort();

    // 轮询等待服务端 close 处理落日志（事件循环异步）
    let abortedLog: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      abortedLog = getAiRequestLogsForTest().find((l) => l.aborted);
      if (abortedLog) break;
    }
    assert.ok(abortedLog, '中断后应落 aborted=true 的 ai log');
    assert.equal(abortedLog.status, 'error');
    assert.equal(abortedLog.provider, 'openai');

    const ev = getEventLogsForTest().find((e) => e.event === 'chat_client_abort');
    assert.ok(ev, '应记录 chat_client_abort 事件');
    assert.equal(ev.category, 'chat');
    assert.equal(ev.entity_id, 'i2-board');
  });

  test('force_web_search:false → 不携带 tool_choice（回落模型自主决策）', async () => {
    const cfg = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        openai_base_url: 'http://127.0.0.1:9/v1',
        openai_api_key: 'sk-test-i2-key-0001',
        openai_model: 'qwen-i2-test',
        force_web_search: false,
      }),
    });
    assert.equal(cfg.status, 200);

    stubScenario = 1;
    const res = await chat({ messages: [{ role: 'user', content: '自主决策测试' }], canvasId: 'i2-board' });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(lastResponsesBody?.tool_choice, undefined, '关闭强制联网后不应携带 tool_choice');
    assert.deepEqual(lastResponsesBody?.tools, [{ type: 'web_search' }]);
  });

  test('force_web_search:true → 恢复 tool_choice:required', async () => {
    const cfg = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        openai_base_url: 'http://127.0.0.1:9/v1',
        openai_api_key: 'sk-test-i2-key-0001',
        openai_model: 'qwen-i2-test',
        force_web_search: true,
      }),
    });
    assert.equal(cfg.status, 200);

    stubScenario = 1;
    const res = await chat({ messages: [{ role: 'user', content: '强制联网恢复' }], canvasId: 'i2-board' });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(lastResponsesBody?.tool_choice, 'required');
  });
});
