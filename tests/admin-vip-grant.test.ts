/**
 * #0103 回归测试 — grantUserVipDays 原子性与并发防丢天数
 *
 * 断言点：
 * 1. 鉴权：非管理员请求 POST /api/admin/users/:id/vip 返回 403
 * 2. 参数校验：days < 0 返回 400
 * 3. 目标不存在：不存在的用户 ID 返回 404
 * 4. 正常增授：体验版用户增授 10 天，role 变 vip，vip_expires_at 为 now + 10 天，审计记录 vip_grant
 * 5. 顺延增授：已是 VIP 的用户再增授 5 天，到期时间在原到期时间基础上顺延 5 天
 * 6. 取消 VIP：days=0 取消 VIP，role 降为 user，vip_expires_at 置 null，审计记录 vip_revoke
 * 7. Admin 角色保护：给 admin 角色增授或取消 VIP，其 role 始终保持 admin 不被降级
 * 8. 并发增授（#0103 核心）：并发增授 7 天与 30 天，37 天全部叠上，不发生丢失更新
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { grantUserVipDays } from '../server/services/admin.service.js';
import { findUserById, createUser } from '../server/repositories/user.repository.js';
import { getAuditLogsForTest } from '../server/repositories/audit.repository.js';

let server: http.Server;
let base = '';
let adminCookie = '';
let userCookie = '';

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.userCount >= 3) return;
    } catch {
      /* not ready */
    }
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
  assert.equal(res.status, 200, `登录 ${email} 失败`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

describe('#0103: grantUserVipDays 增授 VIP 与并发原子性', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    userCookie = await signIn('user@deepdive.ai', 'User123456!');
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('非管理员调用 POST /api/admin/users/:id/vip → 403', async () => {
    const res = await fetch(`${base}/api/admin/users/${USER_ID}/vip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ days: 30 }),
    });
    assert.equal(res.status, 403);
  });

  test('参数非法 days < 0 → 400', async () => {
    const res = await fetch(`${base}/api/admin/users/${USER_ID}/vip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ days: -1 }),
    });
    assert.equal(res.status, 400);
  });

  test('用户不存在 → 404', async () => {
    const res = await fetch(`${base}/api/admin/users/00000000-0000-0000-0000-000000000999/vip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ days: 30 }),
    });
    assert.equal(res.status, 404);
  });

  test('体验版增授 10 天 → role=vip 且 vip_expires_at 正确，审计记录写入', async () => {
    const targetUser = await createUser({
      email: `test-vip-grant-${Date.now()}@example.com`,
      passwordHash: 'dummy-hash',
      role: 'user',
    });

    const res = await fetch(`${base}/api/admin/users/${targetUser.id}/vip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ days: 10 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.user.role, 'vip');
    assert.ok(body.vip_expires_at);

    const expiresMs = new Date(body.vip_expires_at).getTime();
    const expectedMs = Date.now() + 10 * 86400000;
    assert.ok(
      Math.abs(expiresMs - expectedMs) < 10000,
      `到期时间应为约 10 天后，实际差值 ${Math.abs(expiresMs - expectedMs)}ms`
    );

    // 检查审计日志
    const logs = getAuditLogsForTest();
    const grantLog = logs.find(
      (l) => l.action === 'vip_grant' && l.target_id === targetUser.id
    );
    assert.ok(grantLog, '应记录 vip_grant 审计');
    assert.equal(grantLog.details?.days, 10);
  });

  test('顺延增授：已是 VIP 再增授 5 天，在原到期时间基础上累加', async () => {
    const targetUser = await createUser({
      email: `test-vip-extend-${Date.now()}@example.com`,
      passwordHash: 'dummy-hash',
      role: 'user',
    });

    // 先给 10 天
    const r1 = await grantUserVipDays({ userId: targetUser.id, days: 10, actorId: ADMIN_ID });
    const t1 = new Date(r1.vip_expires_at!).getTime();

    // 再顺延 5 天
    const r2 = await grantUserVipDays({ userId: targetUser.id, days: 5, actorId: ADMIN_ID });
    const t2 = new Date(r2.vip_expires_at!).getTime();

    const diffDays = (t2 - t1) / 86400000;
    assert.ok(
      diffDays > 4.9 && diffDays < 5.1,
      `顺延后应刚好增加 5 天，实际增加 ${diffDays} 天`
    );
  });

  test('days=0 取消 VIP：role 降为 user，vip_expires_at 置 null，审计记录 vip_revoke', async () => {
    const targetUser = await createUser({
      email: `test-vip-revoke-${Date.now()}@example.com`,
      passwordHash: 'dummy-hash',
      role: 'user',
    });

    await grantUserVipDays({ userId: targetUser.id, days: 10, actorId: ADMIN_ID });

    const res = await fetch(`${base}/api/admin/users/${targetUser.id}/vip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ days: 0 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.user.role, 'user');
    assert.equal(body.vip_expires_at, null);

    const logs = getAuditLogsForTest();
    const revokeLog = logs.find(
      (l) => l.action === 'vip_revoke' && l.target_id === targetUser.id
    );
    assert.ok(revokeLog, '应记录 vip_revoke 审计');
  });

  test('admin 角色保护：给 admin 增授与取消 VIP，role 恒为 admin 不被降级', async () => {
    // 增授 10 天
    const r1 = await grantUserVipDays({ userId: ADMIN_ID, days: 10, actorId: ADMIN_ID });
    assert.equal(r1.role, 'admin');
    assert.equal(r1.user.role, 'admin');
    assert.ok(r1.vip_expires_at);

    // 取消
    const r2 = await grantUserVipDays({ userId: ADMIN_ID, days: 0, actorId: ADMIN_ID });
    assert.equal(r2.role, 'admin');
    assert.equal(r2.user.role, 'admin');
    assert.equal(r2.vip_expires_at, null);
  });

  test('#0103 并发增授同一用户（7天 + 30天）天数不丢失，共叠满 37 天', async () => {
    const targetUser = await createUser({
      email: `test-vip-concurrent-${Date.now()}@example.com`,
      passwordHash: 'dummy-hash',
      role: 'user',
    });

    const baseMs = Date.now();

    // 并发发起两次增授：7 天 + 30 天
    await Promise.all([
      grantUserVipDays({ userId: targetUser.id, days: 7, actorId: ADMIN_ID }),
      grantUserVipDays({ userId: targetUser.id, days: 30, actorId: ADMIN_ID }),
    ]);

    const updatedUser = await findUserById(targetUser.id);
    assert.ok(updatedUser);
    assert.ok(updatedUser.vip_expires_at, 'vip_expires_at 应该存在');

    const finalExpiryMs = new Date(updatedUser.vip_expires_at!).getTime();
    const addedDays = (finalExpiryMs - baseMs) / 86400000;

    assert.ok(
      addedDays > 36.5 && addedDays < 37.5,
      `两单共 37 天必须全部叠上（若丢失更新说明读-改-写非原子），实际增加 ${addedDays} 天`
    );
  });
});
