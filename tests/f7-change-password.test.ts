/**
 * 修改密码 — POST /api/auth/change-password（登录态）
 * 旧密码校验 → 更新 → 踢全部会话（含当前会话，需重新登录）。
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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

function authedJSON(cookie: string) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
  };
}

describe('修改密码 change-password', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    // 创建独立账号并建立两个会话（验证踢下线含当前会话）
    await registerViaCode('f7-changepw@example.com', 'OldPass123', 'F7');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('未登录调用 → 401', async () => {
    const res = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'OldPass123', newPassword: 'NewPass456' }),
    });
    assert.equal(res.status, 401);
  });

  test('旧密码错误 → 400 WRONG_OLD_PASSWORD，且密码未被修改', async () => {
    const cookie = await signIn('f7-changepw@example.com', 'OldPass123');
    const res = await fetch(`${base}/api/auth/change-password`, {
      ...authedJSON(cookie),
      body: JSON.stringify({ oldPassword: 'WrongOld999', newPassword: 'NewPass456' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'WRONG_OLD_PASSWORD');

    // 密码未被修改：旧密码仍可登录
    const stillOld = await signIn('f7-changepw@example.com', 'OldPass123');
    assert.ok(stillOld.startsWith('session_token='), '旧密码应仍可登录');
  });

  test('新密码不足 6 位 → 400', async () => {
    const cookie = await signIn('f7-changepw@example.com', 'OldPass123');
    const res = await fetch(`${base}/api/auth/change-password`, {
      ...authedJSON(cookie),
      body: JSON.stringify({ oldPassword: 'OldPass123', newPassword: '12345' }),
    });
    assert.equal(res.status, 400);
  });

  test('成功修改：新密码可登录、旧密码 401、响应清除 cookie', async () => {
    const cookie = await signIn('f7-changepw@example.com', 'OldPass123');
    const res = await fetch(`${base}/api/auth/change-password`, {
      ...authedJSON(cookie),
      body: JSON.stringify({ oldPassword: 'OldPass123', newPassword: 'NewPass456' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.success, '应返回 success');
    assert.ok(res.headers.get('set-cookie')?.includes('session_token='), '应清除 session cookie');

    const oldLogin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f7-changepw@example.com', password: 'OldPass123' }),
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f7-changepw@example.com', password: 'NewPass456' }),
    });
    assert.equal(newLogin.status, 200);
  });

  test('修改成功后全部会话失效（含发起修改的当前会话）', async () => {
    // 用新密码重新建立两个会话
    const cookieA = await signIn('f7-changepw@example.com', 'NewPass456');
    const cookieB = await signIn('f7-changepw@example.com', 'NewPass456');

    const res = await fetch(`${base}/api/auth/change-password`, {
      ...authedJSON(cookieA),
      body: JSON.stringify({ oldPassword: 'NewPass456', newPassword: 'FinalPass789' }),
    });
    assert.equal(res.status, 200);

    const meA = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieA } });
    const meB = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieB } });
    assert.equal(meA.status, 401, '发起修改的当前会话应被踢下线');
    assert.equal(meB.status, 401, '其他并行会话也应被踢下线');
  });
});
