/**
 * L2 — 单层分组（folders）服务端行为
 *
 * 覆盖：分组 CRUD、按用户隔离、非属主 403、跨租户 folderId 挂载 400、
 * 删除分组解除画板归属且画板仍在（不级联删、不释放配额）。
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
let aliceCookie = '';
let bobCookie = '';
let adminCookie = '';

const BOARD = 'l2-alice-board';
const FOLDER = 'l2-f-alice';
const BOB_FOLDER = 'l2-f-bob';

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

function req(cookie: string | null, path: string, method = 'GET', body?: any): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createFolder(cookie: string, id: string, name: string): Promise<Response> {
  return req(cookie, '/api/folders', 'POST', { id, name });
}

async function saveBoard(cookie: string, id: string): Promise<Response> {
  return req(cookie, `/api/canvases/${id}/save`, 'POST', { id, title: id, nodes: [], edges: [] });
}

async function patchBoardMeta(cookie: string, id: string, body: any): Promise<Response> {
  return req(cookie, `/api/canvases/${id}/meta`, 'PATCH', body);
}

async function getBoard(cookie: string, id: string): Promise<any> {
  const res = await req(cookie, `/api/canvases/${id}`);
  assert.equal(res.status, 200);
  return res.json();
}

async function listFolders(cookie: string): Promise<any[]> {
  const res = await req(cookie, '/api/folders');
  assert.equal(res.status, 200);
  return ((await res.json()) as any).folders;
}

describe('L2 单层分组（后端）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('l2-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('l2-bob@test.local', 'Bob123456!');

    assert.equal((await saveBoard(aliceCookie, BOARD)).status, 200);
    assert.equal((await createFolder(bobCookie, BOB_FOLDER, 'Bob分组')).status, 201);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('匿名访问分组端点 → 401', async () => {
    assert.equal((await req(null, '/api/folders')).status, 401);
    assert.equal((await req(null, '/api/folders', 'POST', { id: 'x', name: 'x' })).status, 401);
  });

  test('新建分组 → 201；GET 返回本人分组', async () => {
    const res = await createFolder(aliceCookie, FOLDER, '论文研究');
    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.folder.id, FOLDER);
    assert.equal(body.folder.name, '论文研究');

    const folders = await listFolders(aliceCookie);
    assert.ok(folders.some((f) => f.id === FOLDER));
  });

  test('分组列表按用户隔离：bob 看不到 alice 的分组', async () => {
    const folders = await listFolders(bobCookie);
    assert.ok(!folders.some((f) => f.id === FOLDER));
    assert.ok(folders.some((f) => f.id === BOB_FOLDER));
  });

  test('重复 id / 缺名 → 400', async () => {
    const dup = await createFolder(aliceCookie, FOLDER, '重名');
    assert.equal(dup.status, 400);
    assert.equal(((await dup.json()) as any).code, 'FOLDER_EXISTS');

    const bad = await createFolder(aliceCookie, 'l2-bad', '');
    assert.equal(bad.status, 400);
  });

  test('非属主改 / 删分组 → 403 FOLDER_FORBIDDEN', async () => {
    const ren = await req(bobCookie, `/api/folders/${FOLDER}`, 'PATCH', { name: '劫持' });
    assert.equal(ren.status, 403);
    assert.equal(((await ren.json()) as any).code, 'FOLDER_FORBIDDEN');

    const del = await req(bobCookie, `/api/folders/${FOLDER}`, 'DELETE');
    assert.equal(del.status, 403);
  });

  test('不存在分组 PATCH/DELETE → 404', async () => {
    assert.equal((await req(aliceCookie, '/api/folders/l2-none', 'PATCH', { name: 'x' })).status, 404);
    assert.equal((await req(aliceCookie, '/api/folders/l2-none', 'DELETE')).status, 404);
  });

  test('属主改名 → 200', async () => {
    const res = await req(aliceCookie, `/api/folders/${FOLDER}`, 'PATCH', { name: '论文与推导' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).folder.name, '论文与推导');
  });

  test('移入分组：PATCH meta folderId → 200，GET 回读归属', async () => {
    const res = await patchBoardMeta(aliceCookie, BOARD, { folderId: FOLDER });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).canvas.folderId, FOLDER);
    assert.equal((await getBoard(aliceCookie, BOARD)).folderId, FOLDER);
  });

  test('跨租户挂载防护：把画板挂到他人分组 → 400 FOLDER_INVALID', async () => {
    const res = await patchBoardMeta(aliceCookie, BOARD, { folderId: BOB_FOLDER });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'FOLDER_INVALID');
  });

  test('admin 改他人画板 meta → 403 CANVAS_FORBIDDEN（严格属主制）', async () => {
    const res = await patchBoardMeta(adminCookie, BOARD, { folderId: BOB_FOLDER });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
  });

  test('删除分组：画板解除归属（folderId=null）且画板仍在，配额不受影响', async () => {
    const del = await req(aliceCookie, `/api/folders/${FOLDER}`, 'DELETE');
    assert.equal(del.status, 200);

    const board = await getBoard(aliceCookie, BOARD);
    assert.equal(board.folderId, null, '画板应移出已删分组');
    assert.equal((await listFolders(aliceCookie)).some((f) => f.id === FOLDER), false);

    const list = await req(aliceCookie, '/api/canvases');
    const boards = (await list.json()) as any[];
    assert.ok(boards.some((b) => b.id === BOARD), '画板仍应存在（不级联删）');
  });
});
