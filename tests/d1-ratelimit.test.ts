/**
 * Spec D1+D2 — IP 注册限流 + 阶梯限流角色差异化
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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** 发起一次 chat，读完状态后立刻取消流，避免 socket 堆积 */
async function chatOnce(cookie: string): Promise<number> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ratelimit-probe' }], canvasId: null }),
  });
  const status = res.status;
  try {
    await res.body?.cancel();
  } catch { /* ignore */ }
  return status;
}

describe('D1+D2 滥用防线', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    userCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('D1：同 IP 第 6 次 sign-up 被拒（5 次/小时）', async () => {
    const codes: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await fetch(`${base}/api/auth/sign-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `d1-user-${i}@example.com`, password: 'Pass123456' }),
      });
      codes.push(res.status);
      if (res.status !== 201) {
        const body = await res.json() as any;
        if (codes[i - 1] === 429) assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
      }
    }
    assert.ok(codes.includes(429), `第 6 次注册应触发 429，实际 ${codes}`);
    assert.equal(codes[codes.length - 1], 429);
  });

  test('D2：体验版 chat 第 26 次触发 429（阈值 25/分）', async () => {
    let saw429 = false;
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) {
      const status = await chatOnce(userCookie);
      codes.push(status);
      if (status === 429) saw429 = true;
    }
    assert.ok(saw429, `应有 429，实际序列 ${codes.join(',')}`);
    // 前 25 次不应被阶梯限流拒绝（可能因无 API Key 返回 5xx，但不该是 429）
    assert.ok(!codes.slice(0, 25).includes(429), `前 25 次不应 429：${codes.join(',')}`);
  });

  test('D2：Admin 同窗口 30 次 chat 无 429（阈值 120/分，角色差异化）', async () => {
    for (let i = 0; i < 30; i++) {
      const status = await chatOnce(adminCookie);
      assert.notEqual(status, 429, `Admin 第 ${i + 1} 次不应 429`);
    }
  });
});
