/**
 * Spec E1+E2 — PaymentProvider 抽象 + MockProvider 订单全生命周期
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { subscriptionRateLimiter } from '../server/middleware/auth.js';
import { ipKeyGenerator } from 'express-rate-limit';

let server: http.Server;
let base = '';
let userCookie = '';

/** 复位订阅限流器：本文件同 IP 订阅请求 >10 次/分钟，会撞新加的 subscriptionRateLimiter 429（技术债 #0012） */
function resetSubLimiter(): void {
  subscriptionRateLimiter.resetKey(ipKeyGenerator('127.0.0.1'));
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

describe('E1+E2 支付抽象与 Mock 生命周期', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    resetSubLimiter();

    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(res.status, 200);
    userCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function startOrder(plan: string): Promise<any> {
    const res = await fetch(`${base}/api/subscriptions/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ plan }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  test('下单 → pending 订单 + mock payUrl，VIP 未生效', async () => {
    resetSubLimiter();
    const { status, body } = await startOrder('weekly');
    assert.equal(status, 201);
    assert.ok(body.orderNo);
    assert.match(body.payUrl, /^mock:\/\//);
    assert.equal(body.amountCents, 990);

    const st = await (await fetch(`${base}/api/subscriptions/orders/${body.orderNo}`, {
      headers: { cookie: userCookie },
    })).json() as any;
    assert.equal(st.order.status, 'pending');

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } })).json() as any;
    assert.equal(me.user.entitlements.plan, 'trial'); // 未支付不生效
  });

  test('模拟支付回调 → 订单 paid + VIP 生效（weekly 7 天）', async () => {
    resetSubLimiter();
    const { body } = await startOrder('weekly');
    const res = await fetch(`${base}/api/subscriptions/orders/${body.orderNo}/mock-pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    assert.equal(res.status, 200);
    const payBody = await res.json() as any;
    assert.equal(payBody.order.status, 'paid');

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } })).json() as any;
    assert.equal(me.user.entitlements.plan, 'vip');
    const expires = new Date(me.user.vip_expires_at).getTime();
    const days = (expires - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days <= 7.1, `weekly 应约 7 天，实际 ${days}`);
  });

  test('重复 mock-pay 已支付订单 → 409 ORDER_ALREADY_PAID', async () => {
    resetSubLimiter();
    const { body } = await startOrder('monthly');
    await fetch(`${base}/api/subscriptions/orders/${body.orderNo}/mock-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    const again = await fetch(`${base}/api/subscriptions/orders/${body.orderNo}/mock-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as any).code, 'ORDER_ALREADY_PAID');
  });

  test('未知 orderNo：mock-pay 与查询均 404', async () => {
    resetSubLimiter();
    const pay = await fetch(`${base}/api/subscriptions/orders/ORD-NOTEXIST/mock-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    assert.equal(pay.status, 404);

    const query = await fetch(`${base}/api/subscriptions/orders/ORD-NOTEXIST`, {
      headers: { cookie: userCookie },
    });
    assert.equal(query.status, 404);
  });

  test('他人订单 mock-pay → 403', async () => {
    resetSubLimiter();
    const admin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
    });
    const adminCookie = (admin.headers.get('set-cookie') || '').split(';')[0];

    const order = await fetch(`${base}/api/subscriptions/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ plan: 'monthly' }), // yearly 已下架（2026-09-10 单笔限额），原用例改用 monthly
    });
    const orderBody = await order.json() as any;

    const cross = await fetch(`${base}/api/subscriptions/orders/${orderBody.orderNo}/mock-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    assert.equal(cross.status, 403);
  });

  test('一步开通 /api/auth/subscribe 回归 200', async () => {
    const res = await fetch(`${base}/api/auth/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ plan: 'monthly' }),
    });
    assert.equal(res.status, 200);
  });
});
