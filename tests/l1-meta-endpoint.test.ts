/**
 * L1 — 画板库元数据端点（PATCH /api/canvases/:id/meta）
 *
 * 覆盖：
 * - 越权矩阵：匿名 401 / 非属主 403 CANVAS_FORBIDDEN / admin 放行
 * - 收藏、归档、标题更新；归档不释放配额（仍在列表）
 * - 轻量端点不触碰节点：收藏后单读 nodes 完好
 * - 共享默认板禁改；软删/不存在 404
 * - zod：空 body、类型错误 → 400 VALIDATION_ERROR
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
let aliceCookie = ''; // 种子体验版 user@deepdive.ai
let bobCookie = ''; // 新注册体验版
let adminCookie = '';

const ALICE_BOARD = 'l1-alice-board';

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

async function saveBoard(cookie: string, id: string, nodes: any[] = []): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function patchMeta(cookie: string | null, id: string, body: any): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function getBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
}

async function getListed(cookie: string, id: string): Promise<any | undefined> {
  const res = await fetch(`${base}/api/canvases`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as any[]).find((c) => c.id === id);
}

describe('L1 画板库元数据端点（后端）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('l1-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('l1-bob@test.local', 'Bob123456!');

    const res = await saveBoard(aliceCookie, ALICE_BOARD, [
      { id: 'l1-n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: '节点一', depth: 0 } },
    ]);
    assert.equal(res.status, 200);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('匿名 PATCH → 401', async () => {
    assert.equal((await patchMeta(null, ALICE_BOARD, { isFavorite: true })).status, 401);
  });

  test('非属主 PATCH → 403 CANVAS_FORBIDDEN，且不改变原值', async () => {
    const res = await patchMeta(bobCookie, ALICE_BOARD, { isFavorite: true });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
    const listed = await getListed(aliceCookie, ALICE_BOARD);
    assert.equal(listed.isFavorite, false);
  });

  test('空 body / 非法类型 → 400 VALIDATION_ERROR', async () => {
    const empty = await patchMeta(aliceCookie, ALICE_BOARD, {});
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as any).code, 'VALIDATION_ERROR');

    const bad = await patchMeta(aliceCookie, ALICE_BOARD, { isFavorite: 'yes' });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).code, 'VALIDATION_ERROR');
  });

  test('不存在 / 非法 id → 404', async () => {
    assert.equal((await patchMeta(aliceCookie, 'l1-no-such-board', { isFavorite: true })).status, 404);
  });

  test('属主收藏 → 200，回包 isFavorite=true 且带 updatedAt', async () => {
    const res = await patchMeta(aliceCookie, ALICE_BOARD, { isFavorite: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.canvas.isFavorite, true);
    assert.equal(body.canvas.isArchived, false);
    assert.equal(body.canvas.title, ALICE_BOARD);
    assert.equal(typeof body.canvas.updatedAt, 'string');
  });

  test('列表反映收藏状态', async () => {
    const listed = await getListed(aliceCookie, ALICE_BOARD);
    assert.equal(listed.isFavorite, true);
  });

  test('轻量端点不触碰节点：收藏后单读 nodes 完好', async () => {
    const res = await getBoard(aliceCookie, ALICE_BOARD);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].data.title, '节点一');
  });

  test('归档 → isArchived=true；归档后仍在列表（不释放配额）', async () => {
    const res = await patchMeta(aliceCookie, ALICE_BOARD, { isFavorite: false, isArchived: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.canvas.isArchived, true);
    assert.equal(body.canvas.isFavorite, false);

    const listed = await getListed(aliceCookie, ALICE_BOARD);
    assert.ok(listed, '归档画板仍应出现在列表（由前端筛选，不释放配额）');
    assert.equal(listed.isArchived, true);
  });

  test('标题更新；收藏/归档状态不受影响', async () => {
    const res = await patchMeta(aliceCookie, ALICE_BOARD, { title: 'L1 改名' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.canvas.title, 'L1 改名');
    assert.equal(body.canvas.isArchived, true);
    assert.equal((await getListed(aliceCookie, ALICE_BOARD)).title, 'L1 改名');
  });

  test('admin 改他人画板 meta → 403 CANVAS_FORBIDDEN', async () => {
    const res = await patchMeta(adminCookie, ALICE_BOARD, { isFavorite: true });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
  });

  test('共享默认板禁改 → 403 CANVAS_FORBIDDEN', async () => {
    for (const cookie of [aliceCookie, adminCookie]) {
      const res = await patchMeta(cookie, 'default-board', { isFavorite: true });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
    }
  });

  test('软删后 PATCH → 404', async () => {
    assert.equal((await saveBoard(aliceCookie, 'l1-softdel')).status, 200);
    const del = await fetch(`${base}/api/canvases/l1-softdel`, { method: 'DELETE', headers: { cookie: aliceCookie } });
    assert.equal(del.status, 200);
    assert.equal((await patchMeta(aliceCookie, 'l1-softdel', { isFavorite: true })).status, 404);
  });
});
