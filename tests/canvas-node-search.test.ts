/**
 * O1 — 画板内节点搜索（前端入口落地，后端语义钉死；2026-09-16）：
 *
 * searchNodes 此前只有 `.length` 级断言（s1/h1），双模形状分叉一直未被发现。本文件锁定：
 * 1. 空 q = 空结果（仓储在 getDb() 之前早退；此前内存分支 includes('') 恒真 → 返回前 30 个全部节点）
 * 2. ILIKE 通配符字面量化（%/_ 转义 + ESCAPE '\'，与内存 includes() 字面量语义对齐）
 * 3. suggested 灵感占位不参与检索（口径同 countCanvasNodes：尚未提问、不占节点额度）
 * 4. 响应形状双模统一：恰为 camelCase 九键（无 canvas_id / note_content / created_at）
 * 5. 排序稳定：depth → pos_y → pos_x → id（内存分支显式同序，不再依赖 Map 插入序）
 * 6. 独立限流：canvasSearchRateLimiter 60/min per user（第 61 个并发请求 429）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import { signupRateLimiter, sendRegisterCodeRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';
let aliceCookie = ''; // 种子体验版 user@deepdive.ai

/** 响应形状的唯一合法键集合（双模统一 camelCase；钉死分叉回归） */
const RESULT_KEYS = ['answer', 'canvasId', 'depth', 'id', 'model', 'noteContent', 'question', 'title', 'type']
  .sort();

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

async function registerViaCode(email: string, password: string, name?: string): Promise<void> {
  (signupRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  (sendRegisterCodeRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '').match(/\b(\d{6})\b/)![1];
  const res = await fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code }),
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

function saveBoard(cookie: string, id: string, nodes: any[] = []): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function searchInBoard(cookie: string, id: string, q: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });
}

async function searchIds(cookie: string, id: string, q: string): Promise<string[]> {
  const res = await searchInBoard(cookie, id, q);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  return (body.results || []).map((r: any) => r.id);
}

describe('O1 画板内节点搜索', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');

    // 一块板覆盖全部语义探针（关键词互不重叠，用例间不污染）
    assert.equal(
      (await saveBoard(aliceCookie, 'ns-board-1', [
        // title 匹配：客户端 data.title 持久化进 title 列，PG 分支必须搜它（此前只搜 question）
        { id: 'ns-n-title', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'ns标题甲unique', question: '', answer: '', status: 'idle' } },
        // 通配符字面量探针
        { id: 'ns-n-pct', type: 'chat', position: { x: 0, y: 100 }, data: { question: '折扣 100% off', answer: '', status: 'idle' } },
        { id: 'ns-n-thousand', type: 'chat', position: { x: 0, y: 200 }, data: { question: '数量 1000 个', answer: '', status: 'idle' } },
        { id: 'ns-n-underscore', type: 'chat', position: { x: 0, y: 300 }, data: { question: '变量名 user_id 字段', answer: '', status: 'idle' } },
        // suggested 排除探针（同词的 idle 对照节点）
        { id: 'ns-n-suggested', type: 'chat', position: { x: 0, y: 400 }, data: { question: 'ns占位探针word', answer: '', status: 'suggested' } },
        { id: 'ns-n-idle', type: 'chat', position: { x: 0, y: 500 }, data: { question: 'ns普通探针word', answer: '', status: 'idle' } },
        // 排序探针：同词三节点，depth 0/1/2 + 同 depth 组内按 y
        { id: 'ns-n-deep', type: 'chat', position: { x: 0, y: 900 }, data: { question: 'ns排序探针word', answer: '', status: 'idle', depth: 2 } },
        { id: 'ns-n-root', type: 'chat', position: { x: 0, y: 800 }, data: { question: 'ns排序探针word', answer: '', status: 'idle', depth: 0 } },
        { id: 'ns-n-mid', type: 'chat', position: { x: 0, y: 700 }, data: { question: 'ns排序探针word', answer: '', status: 'idle', depth: 1 } },
      ])).status,
      200
    );
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('空 q 与纯空白 q → 200 空结果（不是 400，也绝不是「返回全部节点」）', async () => {
    for (const q of ['', '   ']) {
      const res = await searchInBoard(aliceCookie, 'ns-board-1', q);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.deepEqual(body.results, []);
    }
  });

  test('% 按字面量匹配：搜「100%」只命中含 100% 的节点，不命中 1000', async () => {
    const ids = await searchIds(aliceCookie, 'ns-board-1', '100%');
    assert.deepEqual(ids, ['ns-n-pct']);
  });

  test('_ 按字面量匹配：搜「u_er」不命中 user_id（未转义时 ILIKE 会把 _ 当单字符通配）', async () => {
    const ids = await searchIds(aliceCookie, 'ns-board-1', 'u_er');
    assert.deepEqual(ids, []);
    // 字面量本身可命中
    const direct = await searchIds(aliceCookie, 'ns-board-1', 'user_id');
    assert.deepEqual(direct, ['ns-n-underscore']);
  });

  test('suggested 灵感占位不参与检索，idle 同词节点正常返回', async () => {
    assert.deepEqual(await searchIds(aliceCookie, 'ns-board-1', 'ns占位探针word'), []);
    assert.deepEqual(await searchIds(aliceCookie, 'ns-board-1', 'ns普通探针word'), ['ns-n-idle']);
  });

  test('title 参与匹配（客户端 data.title 持久化后 PG/内存都搜得到）', async () => {
    const ids = await searchIds(aliceCookie, 'ns-board-1', 'ns标题甲unique');
    assert.deepEqual(ids, ['ns-n-title']);
  });

  test('响应形状：恰为 camelCase 九键，无 snake_case 残留（钉死双模分叉）', async () => {
    const res = await searchInBoard(aliceCookie, 'ns-board-1', 'ns排序探针word');
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.results.length >= 3, '排序探针应至少命中 3 个节点');
    for (const row of body.results) {
      assert.deepEqual(Object.keys(row).sort(), RESULT_KEYS);
    }
  });

  test('排序稳定：depth 升序为主序（内存分支显式同序，不依赖 Map 插入序）', async () => {
    const ids = await searchIds(aliceCookie, 'ns-board-1', 'ns排序探针word');
    assert.deepEqual(ids, ['ns-n-root', 'ns-n-mid', 'ns-n-deep']);
  });

  test('q 超长（>100 字符）→ 400 VALIDATION_ERROR', async () => {
    const res = await searchInBoard(aliceCookie, 'ns-board-1', 'a'.repeat(101));
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.equal(body.code, 'VALIDATION_ERROR');
  });

  test('独立限流：同用户窗口内第 61 个并发请求 → 429 RATE_LIMIT_EXCEEDED', async () => {
    // 用新注册用户，不消耗种子账号的限流窗口（key 为 user_${id}，无法按 IP 复位）
    const email = 'ns-ratelimit@test.local';
    await registerViaCode(email, 'NsRl123456!');
    const cookie = await signIn(email, 'NsRl123456!');

    const responses = await Promise.all(
      Array.from({ length: 61 }, () => searchInBoard(cookie, 'ns-board-1', ''))
    );
    const ok = responses.filter((r) => r.status === 200).length;
    const limited = responses.filter((r) => r.status === 429);
    assert.equal(ok, 60, '窗口内应恰好放行 60 个请求');
    assert.equal(limited.length, 1, '第 61 个请求应被限流');
    const body = await limited[0].json() as any;
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
  });
});
