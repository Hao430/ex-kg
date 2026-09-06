/**
 * Spec E3+E4 — Admin 订单列表 + is_vip_only 模型白名单
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

let server: http.Server;
let base = '';
let userCookie = '';
let vipCookie = '';
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

describe('E3+E4 订单列表与模型白名单', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    for (const [email, password] of [
      ['user@deepdive.ai', 'User123456!'],
      ['vip@deepdive.ai', 'Vip123456!'],
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
      else if (email.startsWith('vip')) vipCookie = cookie;
      else adminCookie = cookie;
    }
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function startOrder(cookie: string, plan = 'weekly'): Promise<string> {
    const res = await fetch(`${base}/api/subscriptions/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ plan }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as any).orderNo;
  }

  async function chatOnce(cookie: string, model?: string): Promise<Response> {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'model-probe' }],
        canvasId: null,
        ...(model ? { model } : {}),
      }),
    });
  }

  test('E3：Admin 拉取订单列表，含已创建订单', async () => {
    const orderNo = await startOrder(userCookie, 'weekly');
    const res = await fetch(`${base}/api/admin/orders?page=1&limit=50`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.orders.some((o: any) => o.order_no === orderNo));
    assert.ok(typeof body.total === 'number');
  });

  test('E3：status=pending 过滤生效', async () => {
    await startOrder(userCookie, 'monthly'); // pending 未支付
    const res = await fetch(`${base}/api/admin/orders?status=pending&page=1&limit=50`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.orders.length > 0);
    assert.ok(body.orders.every((o: any) => o.status === 'pending'));
  });

  test('E3：非管理员访问订单列表 → 403', async () => {
    const res = await fetch(`${base}/api/admin/orders`, { headers: { cookie: userCookie } });
    assert.equal(res.status, 403);
  });

  test('E4：Admin 配置 vip_only_models 并回读', async () => {
    const put = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        provider: 'gemini',
        openai_model: 'deepseek-chat',
        vip_only_models: ['gemini-3.8-flash'],
      }),
    });
    assert.equal(put.status, 200);
    const got = await (await fetch(`${base}/api/admin/model-config`, { headers: { cookie: adminCookie } })).json() as any;
    assert.deepEqual(got.config.vip_only_models, ['gemini-3.8-flash']);
  });

  test('E4：体验版请求白名单模型 → 403 MODEL_VIP_ONLY；VIP → 放行', async () => {
    const trial = await chatOnce(userCookie, 'gemini-3.8-flash');
    assert.equal(trial.status, 403);
    assert.equal(((await trial.json()) as any).code, 'MODEL_VIP_ONLY');

    const vip = await chatOnce(vipCookie, 'gemini-3.8-flash');
    assert.notEqual(vip.status, 403);
  });

  test('E4：体验版不传 model（走默认模型）命中白名单 → 403', async () => {
    // 白名单含默认模型 gemini-3.8-flash（t4 已配置），不传 model 走默认也应拦截
    const trial = await chatOnce(userCookie);
    assert.equal(trial.status, 403);
    assert.equal(((await trial.json()) as any).code, 'MODEL_VIP_ONLY');
  });

  test('E4：未命中白名单模型不受限', async () => {
    const res = await chatOnce(userCookie, 'gemini-3.1-flash-lite');
    assert.notEqual(res.status, 403);
  });
});
