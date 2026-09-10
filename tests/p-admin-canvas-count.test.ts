/**
 * P0 服务端 — admin 每用户画布数排除软删（2026-09-10 画布计数链路重构）。
 *
 * 排查发现 admin.repository.listAdminUsers 的 PG 与内存分支都缺 deleted_at 过滤，
 * 导致用户删板后：全局 totalCanvases / GET /api/canvases 回落，但 admin 用户行的
 * canvas_count 不减，各用户 canvas_count 之和 ≠ totalCanvases。
 *
 * 本文件（内存模式默认套件）锁定内存分支；PG 分支对应 tests/pg/admin-count.pg.test.ts。
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
let userCookie = '';
let adminCookie = '';
let userId = '';
const EMAIL = 'p-admin-count@test.local';
const PASSWORD = 'Count123456!';

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

async function registerViaCode(email: string, password: string, name?: string): Promise<void> {
  (signupRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  (sendRegisterCodeRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '').match(/\b(\d{6})\b/)![1];
  const res = await fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code }),
  });
  assert.ok([200, 201].includes(res.status), `sign-up ${email} 应成功`);
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

function saveBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes: [], edges: [] }),
  });
}

function delBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { method: 'DELETE', headers: { cookie } });
}

/** 从 admin 用户列表读取目标用户的 canvas_count */
async function canvasCountOf(targetEmail: string): Promise<number> {
  const url = new URL(`${base}/api/admin/users`);
  url.searchParams.set('search', targetEmail);
  url.searchParams.set('limit', '10');
  const res = await fetch(url, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200, 'admin/users 应 200');
  const body = (await res.json()) as any;
  const row = body.users.find((u: any) => u.email === targetEmail);
  assert.ok(row, `应能在 admin 列表找到 ${targetEmail}`);
  return row.canvas_count;
}

async function globalCanvasCount(): Promise<number> {
  const res = await fetch(`${base}/api/db/status`);
  assert.equal(res.status, 200);
  return ((await res.json()) as any).canvasCount;
}

async function overviewTotalCanvases(): Promise<number> {
  const res = await fetch(`${base}/api/admin/overview`, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200, 'admin/overview 应 200');
  return ((await res.json()) as any).overview.totalCanvases;
}

describe('P0 admin 每用户画布数排除软删', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    await registerViaCode(EMAIL, PASSWORD, 'CountUser');
    userCookie = await signIn(EMAIL, PASSWORD);
    userId = ((await (await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } })).json()) as any)?.user?.id;
    assert.ok(userId, '应能取到 userId');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('新建画板 +1；软删后回落到 0，不残留软删行', async () => {
    assert.equal(await canvasCountOf(EMAIL), 0, '初始应为 0');

    assert.equal((await saveBoard(userCookie, 'p-admin-board-1')).status, 200);
    assert.equal(await canvasCountOf(EMAIL), 1, '新建后应为 1');

    assert.equal((await delBoard(userCookie, 'p-admin-board-1')).status, 200);
    assert.equal(await canvasCountOf(EMAIL), 0, '软删后应回落为 0（排除 deleted_at）');
  });

  test('多板只删一个：只统计未删除的画板', async () => {
    assert.equal((await saveBoard(userCookie, 'p-admin-board-2')).status, 200);
    assert.equal((await saveBoard(userCookie, 'p-admin-board-3')).status, 200);
    assert.equal(await canvasCountOf(EMAIL), 2, '两块未删应计 2');

    assert.equal((await delBoard(userCookie, 'p-admin-board-2')).status, 200);
    assert.equal(await canvasCountOf(EMAIL), 1, '删一块后应计 1');
  });

  test('注销用户的画板不计入总数：db/status、overview 与用户列表三处对齐', async () => {
    const delEmail = 'p-admin-del@test.local';
    await registerViaCode(delEmail, PASSWORD, 'DelUser');
    const delCookie = await signIn(delEmail, PASSWORD);

    const before = await globalCanvasCount();
    assert.equal((await saveBoard(delCookie, 'p-admin-del-board')).status, 200);
    assert.equal(await globalCanvasCount(), before + 1, '新建后总数 +1');

    // 自助注销（软删用户）：画板行仍在，但属主已注销
    const delRes = await fetch(`${base}/api/auth/account`, {
      method: 'DELETE',
      headers: { cookie: delCookie },
    });
    assert.equal(delRes.status, 200, '注销应成功');

    assert.equal(await globalCanvasCount(), before, '注销用户的画板不应计入画板总数');

    const url = new URL(`${base}/api/admin/users`);
    url.searchParams.set('search', delEmail);
    url.searchParams.set('limit', '10');
    const usersBody = (await (await fetch(url, { headers: { cookie: adminCookie } })).json()) as any;
    assert.equal(usersBody.users.length, 0, '注销用户不应出现在用户列表');

    assert.equal(await overviewTotalCanvases(), before, 'overview 应与 db/status 同口径');
  });

  test('内存模式硬清理级联删除画板数据（对齐 PG CASCADE）', async () => {
    const { getPool } = await import('../server/core/pool.js');
    if (getPool()) return; // 连了真库时交由 tests/pg 覆盖，避免误删

    const { inMemoryStore } = await import('../server/core/memory-store.js');
    const { cleanupDeletedUsers } = await import('../server/repositories/user.repository.js');

    // 注销用户的画板在保留期内仍留在内存
    assert.ok(
      Array.from(inMemoryStore.canvases.values()).some((c) => c.id === 'p-admin-del-board'),
      '注销保留期内画板仍在'
    );

    await cleanupDeletedUsers(0); // retention<=0：硬清理全部非 admin 用户

    assert.equal(
      Array.from(inMemoryStore.canvases.values()).some((c) => c.id === 'p-admin-del-board'),
      false,
      '硬清理应级联删除该用户画板'
    );
    assert.equal(inMemoryStore.users.has(userId), false, '用户应被硬删除');
  });
});
