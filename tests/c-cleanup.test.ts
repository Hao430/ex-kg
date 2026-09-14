/**
 * Spec C — 清理算力点数体系（C1–C6）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';

let server: http.Server;
let base = '';
let userCookie = '';
let adminCookie = '';

/** 注册验证码先行：发码 → 从 outbox 取码 → sign-up */
async function registerViaCode(email: string, password: string, name?: string): Promise<Response> {
  await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '').match(/\b(\d{6})\b/)![1];
  return fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code }),
  });
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

describe('C 清理算力点数体系', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    const user = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    userCookie = (user.headers.get('set-cookie') || '').split(';')[0];
    const admin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
    });
    adminCookie = (admin.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('注册响应与 /me 均无 credits_balance', async () => {
    const signUp = await registerViaCode('c-test@example.com', 'Pass123456', 'C用例');
    assert.equal(signUp.status, 201);
    const suBody = await signUp.json() as any;
    assert.equal(suBody.user?.credits_balance, undefined);
    assert.ok(!JSON.stringify(suBody).includes('credits_balance'));

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } })).json() as any;
    assert.equal(me.user.credits_balance, undefined);
    assert.ok(!JSON.stringify(me).includes('credits_balance'));
  });

  test('POST /api/auth/recharge → 404', async () => {
    const res = await fetch(`${base}/api/auth/recharge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(res.status, 404);
  });

  test('POST /api/admin/users/:id/credits → 404', async () => {
    const res = await fetch(`${base}/api/admin/users/00000000-0000-0000-0000-000000000002/credits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ amount: 100, reason: 'test' }),
    });
    assert.equal(res.status, 404);
  });

  test('GET /api/admin/transactions → 404', async () => {
    const res = await fetch(`${base}/api/admin/transactions`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 404);
  });

  // 走真实链路（下单 → 结算）。原用 POST /api/auth/subscribe「一步开通」——
  // 那是无支付即开通的白拿 VIP 端点，2026-09-14 已整条移除（见 e1-payment.test.ts 回归用例）。
  test('订阅链路不回归（orders 保留）', async () => {
    const order = await fetch(`${base}/api/subscriptions/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ plan: 'weekly' }),
    });
    assert.equal(order.status, 201);
    const orderBody = await order.json() as any;
    assert.ok(orderBody.orderNo);

    const pay = await fetch(`${base}/api/subscriptions/orders/${orderBody.orderNo}/mock-pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    assert.equal(pay.status, 200);
    assert.equal(((await pay.json()) as any).order.status, 'paid');
  });

  test('admin overview 仍可用（token 统计已改源 ai_request_logs）', async () => {
    const res = await fetch(`${base}/api/admin/overview`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok('overview' in body);
  });
});
