/**
 * Spec F4 — 注销流程（软删除 + 30 天冷却恢复）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { cleanupDeletedUsers } from '../server/repositories/user.repository.js';

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

describe('F4 注销流程', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    const admin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
    });
    adminCookie = (admin.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('自助注销：DELETE /api/auth/account → 200 且踢下线', async () => {
    await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-del@example.com', password: 'Pass123456', name: 'F4' }),
    });
    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-del@example.com', password: 'Pass123456' }),
    });
    userCookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const del = await fetch(`${base}/api/auth/account`, {
      method: 'DELETE',
      headers: { cookie: userCookie },
    });
    assert.equal(del.status, 200);

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } });
    assert.equal(me.status, 401, '注销后原会话应失效');
  });

  test('注销后 sign-in → 401（账号不存在语义）', async () => {
    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-del@example.com', password: 'Pass123456' }),
    });
    assert.equal(res.status, 401);
  });

  test('同邮箱可重新注册（partial 唯一索引语义）', async () => {
    const res = await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-del@example.com', password: 'Pass123456' }),
    });
    assert.equal(res.status, 201);

    // 重新注册 = 新账号新 id（非原地复活），后续用例使用新账号会话
    const body = await res.json() as any;
    assert.ok(body.user?.id, '注册响应应含新账号 user.id');
    assert.match(body.user.id, /^[0-9a-f-]{36}$/i);

    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    if (cookie) userCookie = cookie;
  });

  test('Admin restore 已注销账号 → 200 且可重新登录', async () => {
    // 注销前账号的 userId 已知语义：restore 用邮箱反查已注销用户不可行——restore 接受 id。
    // f4-del 原账号 id 未知，用直接注册再注销的方式拿 id：
    const signUp = await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-restore@example.com', password: 'Pass123456' }),
    });
    assert.equal(signUp.status, 201);
    const suBody = await signUp.json() as any;
    const targetId = suBody.user.id as string;

    // 记住 cookie 再注销
    const login = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-restore@example.com', password: 'Pass123456' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    await fetch(`${base}/api/auth/account`, { method: 'DELETE', headers: { cookie } });

    const restore = await fetch(`${base}/api/admin/users/${targetId}/restore`, {
      method: 'PUT',
      headers: { cookie: adminCookie },
    });
    assert.equal(restore.status, 200);

    const relogin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-restore@example.com', password: 'Pass123456' }),
    });
    assert.equal(relogin.status, 200, '恢复后应可重新登录');
  });

  test('restore 未注销/不存在用户 → 404', async () => {
    const res = await fetch(`${base}/api/admin/users/00000000-0000-0000-0000-000000000002/restore`, {
      method: 'PUT',
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 404);
  });

  test('非管理员调 restore → 403', async () => {
    // 使用 test 3 重注册后的新账号 cookie（旧账号会话已在注销时失效）
    const res = await fetch(`${base}/api/admin/users/00000000-0000-0000-0000-000000000002/restore`, {
      method: 'PUT',
      headers: { cookie: userCookie },
    });
    assert.equal(res.status, 403);
  });

  test('30 天过期：cleanupDeletedUsers(0) 硬删已注销用户', async () => {
    // f4-del 已注销（本套件第一个用例）——retention 0 全清
    const removed = await cleanupDeletedUsers(0);
    assert.ok(removed >= 1, `应至少清理 1 个已注销用户，实际 ${removed}`);

    // 被硬删的用户 restore → 404
    const me = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'f4-restore@example.com', password: 'Pass123456' }),
    });
    // f4-restore 未被注销（第二个用例注册的是同邮箱新号）——使用不存在的邮箱验证 404 语义
    void me;
    const restoreGone = await fetch(`${base}/api/admin/users/f4-nonexistent/restore`, {
      method: 'PUT',
      headers: { cookie: adminCookie },
    });
    assert.equal(restoreGone.status, 404);
  });
});
