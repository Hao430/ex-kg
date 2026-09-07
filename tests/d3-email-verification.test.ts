/**
 * Spec D3（2026-09 重设计）— 注册邮箱验证码先行验证
 * 流程：POST /send-register-code → POST /sign-up(code) → 出生即 email_verified=true。
 * 链接式验证链路（/verify-email、/resend-verification）保留供 admin 换绑二次验证，本文件一并保护。
 * 注：用户已授权本次重写 tests/（只读约定豁免）。
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

const TEST_IP = ipKeyGenerator('127.0.0.1');
/** 文件内多次 sign-up/send-code 会顶满 5/h 的 IP 限流，重号用例前复位 */
function resetLimiters(): void {
  (signupRateLimiter as any).resetKey(TEST_IP);
  (sendRegisterCodeRateLimiter as any).resetKey(TEST_IP);
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

describe('D3 邮箱验证（验证码先行）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function sendCode(email: string): Promise<Response> {
    return fetch(`${base}/api/auth/send-register-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  }

  /** 取某邮箱最新一封验证码邮件（outbox unshift 最新在前）并提取 6 位码 */
  function extractCode(email: string): string {
    const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
    assert.ok(mail, `应发出验证码邮件（${email}）`);
    const match = mail.text?.match(/\b(\d{6})\b/) || mail.html?.match(/\b(\d{6})\b/);
    assert.ok(match, '邮件应含 6 位数字验证码');
    return match![1];
  }

  async function signUpWithCode(email: string, code: string): Promise<Response> {
    return fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Pass123456', name: 'D3用例', code }),
    });
  }

  async function signIn(email: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `sign-in ${email}`);
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }

  async function chatOnce(cookie: string): Promise<Response> {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'd3-probe' }], canvasId: null }),
    });
  }

  test('发送验证码：200 且 outbox 含 6 位码', async () => {
    resetLimiters();
    getOutboxForTest().length = 0;
    const res = await sendCode('d3-code1@example.com');
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.message.includes('10 分钟'));
    const code = extractCode('d3-code1@example.com');
    assert.match(code, /^\d{6}$/);
  });

  test('错误验证码注册 → 400 INVALID_CODE', async () => {
    resetLimiters();
    const email = 'd3-code2@example.com';
    await sendCode(email);
    extractCode(email); // 产出真实码但故意不用
    const res = await signUpWithCode(email, '000000');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'INVALID_CODE');
  });

  test('正确验证码注册 → 201 且 email_verified=true', async () => {
    resetLimiters();
    const email = 'd3-ok@example.com';
    await sendCode(email);
    const code = extractCode(email);
    const res = await signUpWithCode(email, code);
    assert.equal(res.status, 201);
    const body = await res.json() as any;
    assert.equal(body.user.email_verified, true);

    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.email_verified, true);
    assert.equal(me.user.email, email);
  });

  test('注册后推理不被 EMAIL_NOT_VERIFIED 拦截', async () => {
    resetLimiters();
    const email = 'd3-chat@example.com';
    await sendCode(email);
    const res = await signUpWithCode(email, extractCode(email));
    assert.equal(res.status, 201);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

    const chat = await chatOnce(cookie);
    if (chat.status === 403) {
      assert.notEqual(((await chat.json()) as any).code, 'EMAIL_NOT_VERIFIED');
    }
    await chat.body?.cancel();
  });

  test('已注册邮箱 send-code → 409 EMAIL_EXISTS', async () => {
    resetLimiters();
    const res = await sendCode('user@deepdive.ai');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).code, 'EMAIL_EXISTS');
  });

  test('60s 冷却：同邮箱连发第二次 → 429 CODE_COOLDOWN', async () => {
    resetLimiters();
    const email = 'd3-cool@example.com';
    const first = await sendCode(email);
    assert.equal(first.status, 200);
    const second = await sendCode(email);
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as any).code, 'CODE_COOLDOWN');
  });

  test('连错 5 次作废；重新发送后可成功注册', async () => {
    resetLimiters();
    const email = 'd3-attempt@example.com';
    await sendCode(email);
    const realCode = extractCode(email);

    // 连错 5 次（每次 attempts+1，第 5 次触发作废删除）
    for (let i = 0; i < 5; i++) {
      const res = await signUpWithCode(email, String(i).padStart(6, '0'));
      assert.equal(res.status, 400, `第 ${i + 1} 次错码应 400`);
      assert.equal(((await res.json()) as any).code, 'INVALID_CODE');
    }
    // 码已作废：提交正确码也 400（先复位 IP 限流，前 5 次已顶满 5/h）
    resetLimiters();
    const invalidated = await signUpWithCode(email, realCode);
    assert.equal(invalidated.status, 400);

    // 重新发送（作废删除后无冷却）→ 新码可成功注册
    resetLimiters();
    const resend = await sendCode(email);
    assert.equal(resend.status, 200);
    const newCode = extractCode(email);
    assert.notEqual(newCode, realCode);
    const ok = await signUpWithCode(email, newCode);
    assert.equal(ok.status, 201);
  });

  test('admin 换绑 → 链接式验证仍工作（保护保留链路）', async () => {
    resetLimiters();
    const email = 'd3-rebind@example.com';
    await sendCode(email);
    const res = await signUpWithCode(email, extractCode(email));
    assert.equal(res.status, 201);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    const userId = me.user.id;

    const adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    const newEmail = 'd3-rebind-new@example.com';
    const change = await fetch(`${base}/api/admin/users/${userId}/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: newEmail }),
    });
    assert.equal(change.status, 200);

    // 换绑后发链接式验证邮件 → token 验证 → email_verified=true
    const mail = getOutboxForTest().find((m) => m.to === newEmail && m.subject === '枝想 邮箱验证');
    assert.ok(mail, '换绑后应发出验证链接邮件');
    const tokenMatch = mail.html?.match(/token=([a-f0-9]+)/) || mail.text?.match(/token=([a-f0-9]+)/);
    assert.ok(tokenMatch, '邮件应含验证 token 链接');
    const verify = await fetch(`${base}/api/auth/verify-email?token=${tokenMatch![1]}`);
    assert.equal(verify.status, 200);

    const meAfter = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(meAfter.user.email, newEmail);
    assert.equal(meAfter.user.email_verified, true);
  });

  test('无效 token → 400 INVALID_TOKEN', async () => {
    const res = await fetch(`${base}/api/auth/verify-email?token=deadbeef`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'INVALID_TOKEN');
  });

  test('种子账号 email_verified=true，推理无 EMAIL_NOT_VERIFIED', async () => {
    const cookie = await signIn('user@deepdive.ai', 'User123456!');
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
    assert.equal(me.user.email_verified, true);

    const chat = await chatOnce(cookie);
    if (chat.status === 403) {
      assert.notEqual(((await chat.json()) as any).code, 'EMAIL_NOT_VERIFIED');
    }
    await chat.body?.cancel();
  });
});
