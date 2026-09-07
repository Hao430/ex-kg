/**
 * J2 — 配额余量 API：服务端单一事实源（跟踪清单 D2 / 里程碑 J 组）
 *
 * 决策：新增 GET /api/quota 返回 {plan, board:{used,limit}, node:{used,limit,remaining}}；
 * node 计数与 chatQuotaMiddleware 完全同口径（已保存画布的 chat 节点，含 suggested 占位）。
 * 前端删除本地预检，只做展示；后端保持唯一裁判。
 * 归属校验：非属主 / 不存在的 canvasId → 404（严格属主制，不泄露存在性）。
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
let aliceCookie = ''; // 种子体验版
let bobCookie = ''; // 新注册体验版
let adminCookie = '';

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
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

async function saveBoard(cookie: string, id: string, nodes: any[]): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function getQuota(cookie: string, canvasId?: string): Promise<Response> {
  const url = new URL(`${base}/api/quota`);
  if (canvasId) url.searchParams.set('canvasId', canvasId);
  return fetch(url, { headers: { cookie } });
}

/** 构造 chat 节点（status 可为 suggested，验证占位计数口径） */
function chatNode(id: string, status: 'idle' | 'suggested' = 'idle'): any {
  return { id, type: 'chat', position: { x: 0, y: 0 }, data: { question: `问题${id}`, status } };
}

describe('J2 配额余量 API（D2）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('j2-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('j2-bob@test.local', 'Bob123456!');

    // alice 画板：7 个 chat 节点，其中 2 个为 suggested 占位 + 1 个 note 节点
    // 服务端口径应计 7（chat 全量含 suggested），note 不计
    const nodes = [
      chatNode('j2-n1'),
      chatNode('j2-n2'),
      chatNode('j2-n3'),
      chatNode('j2-n4'),
      chatNode('j2-n5'),
      chatNode('j2-n6', 'suggested'),
      chatNode('j2-n7', 'suggested'),
      { id: 'j2-note1', type: 'note', position: { x: 0, y: 0 }, data: { noteContent: '便签' } },
    ];
    const res = await saveBoard(aliceCookie, 'j2-alice-board', nodes);
    assert.equal(res.status, 200);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('未登录 → 401', async () => {
    const res = await fetch(`${base}/api/quota`);
    assert.equal(res.status, 401);
  });

  test('体验版无 canvasId：plan/board 口径正确，node 为 null', async () => {
    const res = await getQuota(aliceCookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.plan, 'trial');
    assert.equal(body.vipExpired, false);
    assert.deepEqual(body.board, { used: 1, limit: 3 });
    assert.equal(body.node, null);
    // Spec K7（D3）：VIP 专享模型数量随响应透出；测试环境无 admin 配置 → 0（前端据此隐藏模型权益行）
    assert.equal(body.vipOnlyModelCount, 0);
  });

  test('体验版带 canvasId：node 计数与 chatQuotaMiddleware 同口径（含 suggested，排除 note）', async () => {
    const res = await getQuota(aliceCookie, 'j2-alice-board');
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.plan, 'trial');
    assert.deepEqual(body.node, { used: 7, limit: 10, remaining: 3 });
  });

  test('新注册体验版：board.used=0、未知画布 node 计 0', async () => {
    const res = await getQuota(bobCookie);
    const body = (await res.json()) as any;
    assert.deepEqual(body.board, { used: 0, limit: 3 });
    const res2 = await getQuota(bobCookie, 'j2-bob-never-saved');
    const body2 = (await res2.json()) as any;
    assert.deepEqual(body2.node, { used: 0, limit: 10, remaining: 10 });
  });

  test('越权：bob 查 alice 画布余量 → 404（严格属主制，不泄露存在性）', async () => {
    const res = await getQuota(bobCookie, 'j2-alice-board');
    assert.equal(res.status, 404);
  });

  test('admin：limit 为 null（不受限）', async () => {
    const res = await getQuota(adminCookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.plan, 'admin');
    assert.equal(body.board.limit, null);
    assert.equal(body.node, null);
  });
});
