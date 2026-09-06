/**
 * Spec B3 — VIP 到期宽限期（7 天）与提醒字段
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { updateVipMembership } from '../server/repositories/user.repository.js';

let server: http.Server;
let base = '';
const VIP_ID = '00000000-0000-0000-0000-000000000003';

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

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vip@deepdive.ai', password: 'Vip123456!' }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

describe('B3 宽限期', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('到期 3 天内：宽限期放行 + 提醒字段', async () => {
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: daysFromNow(-4) }); // 已到期 4 天，宽限剩 3 天
    const cookie = await signIn();

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.entitlements.plan, 'vip');
    assert.equal(me.user.entitlements.vipExpired, true);
    assert.equal(me.user.entitlements.vipGraceDaysRemaining, 3);

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], canvasId: null }),
    });
    assert.notEqual(chat.status, 403); // 宽限期内体验不中断
  });

  test('宽限期内（6 天前到期）：仍放行，剩余 1 天', async () => {
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: daysFromNow(-6) });
    const cookie = await signIn();

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.entitlements.plan, 'vip');
    assert.equal(me.user.entitlements.vipExpired, true);
    assert.equal(me.user.entitlements.vipGraceDaysRemaining, 1);
  });

  test('超过宽限期（8 天前到期）：硬锁定 403 VIP_EXPIRED', async () => {
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: daysFromNow(-8) });
    const cookie = await signIn();

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.entitlements.plan, 'trial');
    assert.equal(me.user.entitlements.vipExpired, true);

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], canvasId: null }),
    });
    assert.equal(chat.status, 403);
    assert.equal(((await chat.json()) as any).code, 'VIP_EXPIRED');
  });

  test('VIP 有效（未来 30 天）：无提醒字段', async () => {
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: daysFromNow(30) });
    const cookie = await signIn();

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.entitlements.plan, 'vip');
    assert.equal(me.user.entitlements.vipExpired, false);
    assert.equal(me.user.entitlements.vipGraceDaysRemaining, undefined);
  });
});
