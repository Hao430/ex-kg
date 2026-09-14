/**
 * Spec F2+F3 — 审计日志全量写入 + zod 全入参覆盖
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

let server: http.Server;
let base = '';
let userCookie = '';
let adminCookie = '';

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

async function auditActions(action?: string): Promise<any[]> {
  const url = new URL(`${base}/api/admin/audit-logs`);
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', '100');
  if (action) url.searchParams.set('action', action);
  const res = await fetch(url, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200);
  return (await res.json() as any).logs;
}

describe('F2+F3 审计日志与 zod 覆盖', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    for (const [email, password] of [
      ['user@deepdive.ai', 'User123456!'],
      ['admin@deepdive.ai', 'Admin123456!'],
    ] as const) {
      const res = await fetch(`${base}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(res.status, 200);
      const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
      if (email.startsWith('user')) userCookie = cookie;
      else adminCookie = cookie;
    }
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('F2：登录动作有 sign_in 审计记录', async () => {
    const logs = await auditActions('sign_in');
    assert.ok(logs.length > 0, '应有 sign_in 记录');
  });

  // 走真实链路（下单 → 结算）。原用 POST /api/auth/subscribe「一步开通」——
  // 那是无支付即开通的白拿 VIP 端点，2026-09-14 已整条移除（见 e1-payment.test.ts 回归用例）。
  test('F2：订阅有 subscribe 审计记录', async () => {
    const order = await fetch(`${base}/api/subscriptions/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ plan: 'weekly' }),
    });
    const orderBody = await order.json() as any;
    await fetch(`${base}/api/subscriptions/orders/${orderBody.orderNo}/mock-pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    const logs = await auditActions('subscribe');
    assert.ok(logs.length > 0, '应有 subscribe 记录');
  });

  test('F2：画布删除有 canvas_delete 记录（含 targetId）', async () => {
    await fetch(`${base}/api/canvases/f2-delete-me/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ id: 'f2-delete-me', title: 't', nodes: [], edges: [] }),
    });
    const del = await fetch(`${base}/api/canvases/f2-delete-me`, {
      method: 'DELETE',
      headers: { cookie: userCookie },
    });
    assert.equal(del.status, 200);

    const logs = await auditActions('canvas_delete');
    assert.ok(logs.some((l) => l.target_id === 'f2-delete-me'), '应含 targetId 的删除记录');
  });

  test('F2：admin 冻结用户有 user_freeze 记录（冻结即踢下线，解冻后重新登录）', async () => {
    const res = await fetch(`${base}/api/admin/users/00000000-0000-0000-0000-000000000002/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(res.status, 200);
    // 解冻恢复
    await fetch(`${base}/api/admin/users/00000000-0000-0000-0000-000000000002/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ is_active: true }),
    });
    // 冻结踢下线后原 cookie 失效——重新登录供后续 F3 用例使用
    const relogin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(relogin.status, 200);
    userCookie = (relogin.headers.get('set-cookie') || '').split(';')[0];

    const logs = await auditActions('user_freeze');
    assert.ok(logs.length > 0, '应有 user_freeze 记录');
  });

  test('F2：非管理员查审计日志 → 403', async () => {
    const res = await fetch(`${base}/api/admin/audit-logs`, { headers: { cookie: userCookie } });
    assert.equal(res.status, 403);
  });

  test('F3：chat messages 元素缺 content → 400', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ messages: [{ role: 'user' }], canvasId: null }),
    });
    assert.equal(res.status, 400);
  });

  test('F3：save body nodes 非数组 → 400', async () => {
    const res = await fetch(`${base}/api/canvases/f2-zod/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ id: 'f2-zod', title: 't', nodes: 'not-an-array', edges: [] }),
    });
    assert.equal(res.status, 400);
  });

  test('F3：save title 非字符串 → 400', async () => {
    const res = await fetch(`${base}/api/canvases/f2-zod/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ id: 'f2-zod', title: 12345, nodes: [], edges: [] }),
    });
    assert.equal(res.status, 400);
  });

  test('F3：正常 save 不受影响 → 200', async () => {
    const res = await fetch(`${base}/api/canvases/f2-ok/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ id: 'f2-ok', title: '正常', nodes: [], edges: [], expectedUpdatedAt: undefined }),
    });
    assert.equal(res.status, 200);
  });
});
