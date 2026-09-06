/**
 * Spec A1 — 删除游客模式，强制登录
 * 运行：npm run test（tsx --test，内存模式，不依赖 PG）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

let server: http.Server;
let base: string;

async function startServer(): Promise<string> {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 等待内存种子账号就绪（seedDefaultUsers 为异步 scrypt；轮询 db/status 避开登录限流） */
async function waitSeeds(base: string, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = await res.json() as any;
      if (body.userCount >= 3) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

describe('A1 删除游客模式', () => {
  before(async () => {
    base = await startServer();
    await waitSeeds(base);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('未登录 GET /api/auth/me 返回 401（不再自动建游客号）', async () => {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 401);
    const body = await res.json() as any;
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('未登录 GET /api/canvases 返回 401', async () => {
    const res = await fetch(`${base}/api/canvases`);
    assert.equal(res.status, 401);
    const body = await res.json() as any;
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('POST /api/auth/guest 路由已删除（404）', async () => {
    const res = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('seed 账号正常登录不受影响', async () => {
    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /session_token=/);
  });

  test('有效会话访问受保护端点正常', async () => {
    const signIn = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    const cookie = (signIn.headers.get('set-cookie') || '').split(';')[0];

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as any;
    assert.equal(meBody.user.email, 'user@deepdive.ai');

    const canvases = await fetch(`${base}/api/canvases`, { headers: { cookie } });
    assert.equal(canvases.status, 200);
  });

  test('匿名反馈提交仍可用（可选认证，不受 A1 影响）', async () => {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'suggestion', rating: 5, content: 'A1 匿名反馈' }),
    });
    assert.equal(res.status, 201);
  });

  test('无 token sign-out 仍幂等返回 200', async () => {
    const res = await fetch(`${base}/api/auth/sign-out`, { method: 'POST' });
    assert.equal(res.status, 200);
  });
});
