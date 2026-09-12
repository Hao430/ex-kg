/**
 * H4 — 默认画板私有化（ADR-0018，SAVE_DEFAULT_BOARD_MODE=private）
 *
 * legacy 模式的共享回归在 h1（bob 可写、alice 可读）；本文件专测 private 模式：
 * - 授权路径不再有任何默认板放行：非属主读 404 / 写 403 / meta 403
 * - 默认板退化为「首个认领者的普通画板」：未认领 = 行不存在 → 首个保存者创建并认领
 * - 禁删与授权解耦：两种模式下 default-board 都 403，不因翻开关而变得可删
 * - 属主的默认板可正常收藏/归档/改名（legacy 下整体禁改）
 * - 各用户建自己的画板不受影响（客户端「不可访问则建新板」依赖这条）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import { signupRateLimiter, sendRegisterCodeRateLimiter } from '../server/middleware/auth.js';

// 必须在 createApp 之前设置：仓储层按调用时读 env，但保持「整个文件同模式」才不会有跨用例串扰
process.env.SAVE_DEFAULT_BOARD_MODE = 'private';

let server: http.Server;
let base = '';
let aliceCookie = '';
let bobCookie = '';

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.userCount >= 1) return;
    } catch {
      /* not ready */
    }
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
    body: JSON.stringify({
      id,
      title: id,
      protocolVersion: 2,
      nodes: [{ id: `${id}-n1`, type: 'chat', position: { x: 0, y: 0 }, data: { title: id } }],
      edges: [],
    }),
  });
}

function getBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
}

function delBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { method: 'DELETE', headers: { cookie } });
}

function patchMeta(cookie: string, id: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('H4 默认画板私有化（private 模式）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    await registerViaCode('h4-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('h4-bob@test.local', 'Bob123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('未认领 = 行不存在：alice 首次保存 default-board → 200 并认领', async () => {
    const res = await saveBoard(aliceCookie, 'default-board');
    assert.equal(res.status, 200);
    assert.equal((await getBoard(aliceCookie, 'default-board')).status, 200);
  });

  test('非属主写 default-board → 403 CANVAS_FORBIDDEN（不再跨租户混写）', async () => {
    const res = await saveBoard(bobCookie, 'default-board');
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
  });

  test('非属主读 default-board → 404（不泄露存在性）', async () => {
    assert.equal((await getBoard(bobCookie, 'default-board')).status, 404);
  });

  test('非属主 PATCH meta → 不泄露内容（403/404），属主可正常收藏', async () => {
    const denied = await patchMeta(bobCookie, 'default-board', { isFavorite: true });
    assert.ok([403, 404].includes(denied.status), `非属主不得改 meta（实际 ${denied.status}）`);

    const ok = await patchMeta(aliceCookie, 'default-board', { isFavorite: true });
    assert.equal(ok.status, 200, 'private 模式下默认板是属主自己的普通画板，可收藏');
  });

  test('禁删与授权解耦：两种模式下 default-board 都不可删', async () => {
    for (const cookie of [aliceCookie, bobCookie]) {
      const res = await delBoard(cookie, 'default-board');
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
    }
    assert.equal((await getBoard(aliceCookie, 'default-board')).status, 200, '禁删不得真的删掉');
  });

  test('首次保存前 404：认领竞态下客户端可据此判断「建新板」', async () => {
    // bob 从未写过 h4-bob-board：GET 404 而不是 403，语义是「未知 id，可自行创建」
    assert.equal((await getBoard(bobCookie, 'h4-bob-board')).status, 404);
  });

  test('各用户建自己的画板不受影响（客户端「不可访问则建新板」的落点）', async () => {
    const bobId = 'h4-bob-board';
    assert.equal((await saveBoard(bobCookie, bobId)).status, 200);
    assert.equal((await getBoard(bobCookie, bobId)).status, 200);
    assert.equal((await getBoard(aliceCookie, bobId)).status, 404, '他人新板仍严格隔离');
  });
});
