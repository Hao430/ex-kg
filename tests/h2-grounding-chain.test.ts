/**
 * H2 — 来源索引（Grounding）链路：产生侧 + 审计归因 + 配额生效
 *
 * 机制：monkey-patch globalThis.fetch 拦截 chat.ts 对千问 /responses 的调用，
 * 返回构造好的 SSE 流（web_search_call + usage），其余请求透传原始 fetch。
 * 断言点：
 * - collectSources 形状 {index,title,uri,domain,snippet?}、URI 去重、域名回退
 * - 来源/检索词上限截断（30/10）
 * - ai_request_logs 归因（canvas_id/node_id/model_name/grounding_chunks_count）
 * - 前端补 canvasId 后画布级 10 chat 节点上限真实触发 NODE_LIMIT_REACHED
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
let userCookie = '';

const origFetch = globalThis.fetch;
/** 当前 /responses stub 场景：1=主链路（4 源 3 询） 2=截断（35 源 12 询） */
let stubScenario = 1;

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
          query: '量子纠错',
          queries: ['量子纠错 Surface Code', '量子纠错 Surface Code', '容错阈值'],
          sources: [
            { url: 'https://example.com/a', title: 'A 页面标题', snippet: 'A 片段摘要' },
            { url: 'https://example.com/a', title: '重复（应被 URI 去重丢弃）' },
            { url: 'https://www.example.com/b' },
            { url: 'not-a-valid-uri' },
          ],
        },
      },
    },
    { type: 'response.output_text.delta', delta: '量子纠错依赖表面码 [1]，阈值见 [2]。' },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
    },
  ]);
}

function scenario2Response(): Response {
  const sources = Array.from({ length: 35 }, (_, i) => ({ url: `https://s${i}.example.com/x`, title: `来源${i}` }));
  const queries = Array.from({ length: 12 }, (_, i) => `检索词${i}`);
  return sse([
    { type: 'response.output_item.done', item: { type: 'web_search_call', action: { sources, queries } } },
    { type: 'response.output_text.delta', delta: '正文' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
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
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function chat(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** 解析服务端 SSE 文本为事件数组 */
function parseSse(raw: string): any[] {
  return raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => {
      try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
    })
    .filter(Boolean);
}

async function saveCanvas(cookie: string, id: string, nodes: any[]): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

describe('H2 来源索引链路', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    userCookie = await signIn('user@deepdive.ai', 'User123456!');

    // fetch 分发器：/responses → stub SSE；其余透传原始 fetch
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('/responses')) {
        return stubScenario === 1 ? scenario1Response() : scenario2Response();
      }
      return origFetch(input, init);
    };
  });

  after(() => {
    (globalThis as any).fetch = origFetch;
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('admin 配置 openai 模型走 PATH A（fake base_url + stub）', async () => {
    const res = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        openai_base_url: 'http://127.0.0.1:9/v1',
        openai_api_key: 'sk-test-h2-key-0001',
        openai_model: 'qwen-h2-test',
      }),
    });
    assert.equal(res.status, 200);
  });

  test('PATH A 主链路：grounding 形状/去重/标题/snippet/域名回退 + usage', async () => {
    stubScenario = 1;
    const res = await chat(adminCookie, {
      messages: [{ role: 'user', content: '量子纠错是什么' }],
      canvasId: 'h2-board',
      nodeId: 'h2-node-1',
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const done = events.find((e) => e.done);
    assert.ok(done, '应有 done 事件');

    // 来源：4 条输入 → URI 去重后 3 条，index 连续
    const sources = done.grounding.sources;
    assert.equal(sources.length, 3);
    assert.deepEqual(sources.map((s: any) => s.index), [1, 2, 3]);

    // #3：真标题优先于域名回退；snippet 透传
    assert.equal(sources[0].title, 'A 页面标题');
    assert.equal(sources[0].uri, 'https://example.com/a');
    assert.equal(sources[0].domain, 'example.com');
    assert.equal(sources[0].snippet, 'A 片段摘要');

    // 无标题来源回退域名（www. 剥离）；无 snippet 则不带该键
    assert.equal(sources[1].title, 'example.com');
    assert.equal(sources[1].uri, 'https://www.example.com/b');
    assert.equal(sources[1].domain, 'example.com');
    assert.equal('snippet' in sources[1], false);

    // 非法 URI：domain 回退为 uri 本身
    assert.equal(sources[2].uri, 'not-a-valid-uri');
    assert.equal(sources[2].domain, 'not-a-valid-uri');

    // 检索词去重：query 1 条 + queries 3 条（含 1 重复）→ 3 条
    assert.deepEqual(done.grounding.queries, ['量子纠错', '量子纠错 Surface Code', '容错阈值']);

    // usage 精确透传
    assert.equal(done.modelUsed, 'qwen-h2-test');
    assert.equal(done.tokensConsumed, 150);
  });

  test('#6 上限截断：35 源/12 询 → 30/10', async () => {
    stubScenario = 2;
    const res = await chat(adminCookie, {
      messages: [{ role: 'user', content: '截断测试' }],
      canvasId: 'h2-board',
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const done = events.find((e) => e.done);
    assert.ok(done);
    assert.equal(done.grounding.sources.length, 30);
    assert.equal(done.grounding.queries.length, 10);
    assert.equal(done.grounding.sources[29].index, 30);
  });

  test('审计归因：ai_request_logs 带 canvas_id/node_id/模型/来源数', async () => {
    // 内存存储 newest-first（unshift），logs[0] 为最新一条
    const logs = getAiRequestLogsForTest();
    const first = logs.find((l) => l.node_id === 'h2-node-1');
    assert.ok(first, '应存在 h2-node-1 的推理日志');
    assert.equal(first.canvas_id, 'h2-board');
    assert.equal(first.model_name, 'qwen-h2-test');
    assert.equal(first.status, 'success');
    assert.equal(first.grounding_chunks_count, 3);

    assert.equal(logs[0].grounding_chunks_count, 30, '截断后来源数应落审计');
  });

  test('#2 配额生效：画布满 10 个 chat 节点后推理 → 403 NODE_LIMIT_REACHED', async () => {
    // 必须带 answer：无 answer 且无显式 status 的节点会被判为 suggested 灵感占位，
    // 而占位自 2026-09-14 起**不计入**节点额度（见 countCanvasNodes）。用空占位冒充
    // 「已推理的 10 个节点」会让配额闸门放行，本用例随即失去判别力。
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `h2-n${i}`,
      type: 'chat',
      position: { x: i * 10, y: 0 },
      data: { title: `节点${i}`, depth: 0, answer: `第 ${i} 次推理的答案` },
    }));
    const save = await saveCanvas(userCookie, 'h2-limit-board', nodes);
    assert.equal(save.status, 200);

    const res = await chat(userCookie, {
      messages: [{ role: 'user', content: '测试' }],
      canvasId: 'h2-limit-board',
      nodeId: 'h2-n0',
    });
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.equal(body.code, 'NODE_LIMIT_REACHED');
  });
});
