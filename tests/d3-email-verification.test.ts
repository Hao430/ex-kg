/**
 * Spec D3 — 邮箱验证（jsonTransport 干跑模式 + 未验证禁推理）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';

let server: http.Server;
let base = '';

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

describe('D3 邮箱验证', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function signUpNew(email: string): Promise<{ cookie: string; me: any }> {
    const res = await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Pass123456', name: 'D3用例' }),
    });
    assert.equal(res.status, 201, `sign-up ${email}`);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    return { cookie, me };
  }

  async function chatOnce(cookie: string): Promise<Response> {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'd3-probe' }], canvasId: null }),
    });
  }

  test('注册后未验证：email_verified=false 且推理被拒', async () => {
    await signUpNew('d3-unverified@example.com');
    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'd3-unverified@example.com', password: 'Pass123456' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.email_verified, false);

    const chat = await chatOnce(cookie);
    assert.equal(chat.status, 403);
    assert.equal(((await chat.json()) as any).code, 'EMAIL_NOT_VERIFIED');
  });

  test('验证邮件已发送且含 token；验证后推理放行', async () => {
    getOutboxForTest().length = 0;
    await signUpNew('d3-verify@example.com');
    const outbox = getOutboxForTest();
    assert.ok(outbox.length >= 1, '应发出验证邮件');
    const mail = outbox[outbox.length - 1];
    assert.equal(mail.to, 'd3-verify@example.com');
    const tokenMatch = mail.html?.match(/token=([a-f0-9]+)/) || mail.text?.match(/token=([a-f0-9]+)/);
    assert.ok(tokenMatch, '邮件应含验证 token 链接');

    const verify = await fetch(`${base}/api/auth/verify-email?token=${tokenMatch![1]}`);
    assert.equal(verify.status, 200);

    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'd3-verify@example.com', password: 'Pass123456' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.email_verified, true);

    const chat = await chatOnce(cookie);
    assert.notEqual(chat.status, 403); // 不再因未验证被拒
    await chat.body?.cancel();
  });

  test('无效 token → 400 INVALID_TOKEN', async () => {
    const res = await fetch(`${base}/api/auth/verify-email?token=deadbeef`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'INVALID_TOKEN');
  });

  test('resend-verification：未验证可重发，已验证 → 400', async () => {
    const { cookie } = await signUpNew('d3-resend@example.com');
    const before = getOutboxForTest().length;
    const resend = await fetch(`${base}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
    });
    assert.equal(resend.status, 200);
    assert.ok(getOutboxForTest().length > before);

    // 已验证账号 resend → 400
    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'd3-verify@example.com', password: 'Pass123456' }),
    });
    const vCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const res = await fetch(`${base}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: vCookie },
    });
    assert.equal(res.status, 400);
  });

  test('种子账号 email_verified=true，推理无 EMAIL_NOT_VERIFIED', async () => {
    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.email_verified, true);

    const chat = await chatOnce(cookie);
    if (chat.status === 403) {
      assert.notEqual(((await chat.json()) as any).code, 'EMAIL_NOT_VERIFIED');
    }
    await chat.body?.cancel();
  });
});
