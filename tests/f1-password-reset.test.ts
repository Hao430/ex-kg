/**
 * Spec F1 — 找回密码
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';

let server: http.Server;
let base = '';
let oldCookie = '';

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

describe('F1 找回密码', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    // 创建独立账号并留一份旧会话（验证踢下线）
    await registerViaCode('f1-reset@example.com', 'OldPass123', 'F1');
    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f1-reset@example.com', password: 'OldPass123' }),
    });
    oldCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function extractResetToken(): string {
    const outbox = getOutboxForTest();
    const mail = outbox.find((m) => m.subject.includes('重置') || m.text?.includes('重置') || m.html?.includes('重置'));
    assert.ok(mail, 'outbox 应含重置邮件');
    const m = (mail.html || mail.text || '').match(/token=([a-f0-9]+)/);
    assert.ok(m, '重置邮件应含 token');
    return m![1];
  }

  test('已知邮箱 forgot-password → 200 且发重置邮件（响应防枚举）', async () => {
    const before = getOutboxForTest().length;
    const res = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f1-reset@example.com' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.message && !JSON.stringify(body).includes('f1-reset@example.com'), '响应不泄露邮箱存在性');
    assert.ok(getOutboxForTest().length > before, '应发出重置邮件');
  });

  test('未知邮箱 forgot-password → 200 且不发邮件', async () => {
    const before = getOutboxForTest().length;
    const res = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    assert.equal(res.status, 200);
    assert.equal(getOutboxForTest().length, before);
  });

  test('reset-password 成功：新密码可登录、旧密码失败', async () => {
    const token = extractResetToken();
    const res = await fetch(`${base}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'NewPass456' }),
    });
    assert.equal(res.status, 200);

    const oldLogin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f1-reset@example.com', password: 'OldPass123' }),
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f1-reset@example.com', password: 'NewPass456' }),
    });
    assert.equal(newLogin.status, 200);
  });

  test('重置后旧会话 cookie 已失效（踢下线）', async () => {
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: oldCookie } });
    assert.equal(res.status, 401);
  });

  test('无效 token → 400 INVALID_TOKEN', async () => {
    const res = await fetch(`${base}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'deadbeef', password: 'Whatever123' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'INVALID_TOKEN');
  });
});
