/**
 * S1 — 数据隔离审计修复（2026-09-09）：
 *
 * 1. chat canvasId 归属校验（middleware/quota.ts）：
 *    - 已存在的他人画板作为 chat 归因目标 → 404 NOT_FOUND（admin / 共享默认板除外）
 *    - 不存在的画布放行（首节点对话先于首次自动保存，画布可能尚未落库）
 *    - 本人画板 / 无画布上下文行为不变
 * 2. /api/db/status 生产模式脱敏（server/app.ts）：
 *    - NODE_ENV=production 剥离 userCount/canvasCount/nodeCount 聚合计数，防探测平台规模
 *    - connected/type/databaseUrlConfigured/degraded 保留（部署探活依赖，j1 兼容）
 * 3. 画布 CRUD 属主回归抽查（h1 已全覆盖，此处仅锚定 404/403 口径不回退）
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

function saveBoard(cookie: string, id: string, nodes: any[] = []): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function getBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
}

async function chat(
  cookie: string,
  canvasId: string | null
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '数据隔离探针：请简述什么是拓扑。' }],
      canvasId,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('S1 数据隔离修复', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('s1-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('s1-bob@test.local', 'Bob123456!');

    // alice 建私人画板 + 共享默认板（供归属矩阵使用）
    assert.equal((await saveBoard(aliceCookie, 's1-alice-board')).status, 200);
    assert.equal((await saveBoard(aliceCookie, 'default-board')).status, 200);
    // bob 建本人画板
    assert.equal((await saveBoard(bobCookie, 's1-bob-board')).status, 200);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  describe('chat canvasId 归属校验', () => {

  test('CRUD 归属口径锚定：非属主读他人画板 404（不泄露存在性）', async () => {
    const res = await getBoard(bobCookie, 's1-alice-board');
    assert.equal(res.status, 404);
  });

  test('他人已存在画板作 chat 归因 → 404 NOT_FOUND（审计修复主断言）', async () => {
    const { status, body } = await chat(bobCookie, 's1-alice-board');
    assert.equal(status, 404);
    assert.equal(body.code, 'NOT_FOUND');
  });

  test('不存在的画布作 chat 归因 → 放行到模型配置检查（400 MODEL_NOT_CONFIGURED，首节点先于保存语义保留）', async () => {
    const { status, body } = await chat(bobCookie, 's1-nonexistent-board');
    assert.equal(status, 400);
    assert.equal(body.code, 'MODEL_NOT_CONFIGURED');
  });

  test('共享默认板 default-board 作 chat 归因 → 放行（isSharedDefaultCanvas 特例保留）', async () => {
    const { status, body } = await chat(bobCookie, 'default-board');
    assert.equal(status, 400);
    assert.equal(body.code, 'MODEL_NOT_CONFIGURED');
  });

  test('本人画板作 chat 归因 → 放行', async () => {
    const { status, body } = await chat(bobCookie, 's1-bob-board');
    assert.equal(status, 400);
    assert.equal(body.code, 'MODEL_NOT_CONFIGURED');
  });

  test('无画布上下文（canvasId=null）→ 行为不变', async () => {
    const { status, body } = await chat(bobCookie, null);
    assert.equal(status, 400);
    assert.equal(body.code, 'MODEL_NOT_CONFIGURED');
  });

  test('admin 以他人画板作 chat 归因 → 豁免放行', async () => {
    const { status, body } = await chat(adminCookie, 's1-alice-board');
    assert.equal(status, 400);
    assert.equal(body.code, 'MODEL_NOT_CONFIGURED');
  });
  });

  describe('/api/db/status 生产模式脱敏', () => {
  test('开发/测试模式：聚合计数正常返回（waitSeeds 等依赖不回退）', async () => {
    const res = await fetch(`${base}/api/db/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.userCount >= 3);
    assert.ok(typeof body.canvasCount === 'number');
    assert.ok(typeof body.nodeCount === 'number');
  });

  test('NODE_ENV=production：剥离聚合计数，探活字段保留（j1 兼容口径）', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const res = await fetch(`${base}/api/db/status`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.ok(!('userCount' in body), '生产模式不得暴露 userCount');
      assert.ok(!('canvasCount' in body), '生产模式不得暴露 canvasCount');
      assert.ok(!('nodeCount' in body), '生产模式不得暴露 nodeCount');
      assert.equal(body.connected, false); // 测试进程未配 DATABASE_URL → 内存回退模式
      assert.equal(body.type, 'in-memory-fallback');
      assert.equal(body.databaseUrlConfigured, false);
      assert.equal(body.degraded, false);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  test('恢复后聚合计数回归可见', async () => {
    const res = await fetch(`${base}/api/db/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.userCount >= 3);
  });
  });
});
