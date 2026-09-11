/**
 * S1 — 数据隔离审计修复（2026-09-09）：
 *
 * 1. chat canvasId 归属校验（middleware/quota.ts）：
 *    - 已存在的他人画板作为 chat 归因目标 → 404 NOT_FOUND（仅共享默认板除外；admin 不例外，ADR-0016）
 *    - 不存在的画布放行（首节点对话先于首次自动保存，画布可能尚未落库）
 *    - 本人画板 / 无画布上下文行为不变
 * 2. /api/db/status 生产模式脱敏（server/app.ts）：
 *    - NODE_ENV=production 剥离 userCount/canvasCount/nodeCount 聚合计数，防探测平台规模
 *    - connected/type/databaseUrlConfigured/degraded 保留（部署探活依赖，j1 兼容）
 * 3. 画布 CRUD 属主回归抽查（h1 已全覆盖，此处仅锚定 404/403 口径不回退）
 * 4. 节点检索属主过滤（repositories/canvas.repository.ts searchNodes）：
 *    - userId 由可选收紧为必填，SQL/内存分支均无「省略即全站」的放行分支
 *    - 非属主 / admin 检索他人画板 → 结果恒为空
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

/** 越权检索探针关键字：只出现在 alice 的私人画板节点里 */
const SEARCH_PROBE = 's1越权检索探针';
/** 对照关键字：只出现在 bob 的私人画板节点里（验证属主自身检索不被误伤） */
const BOB_SEARCH_PROBE = 's1bob本人探针';

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

function searchInBoard(cookie: string, id: string, q: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });
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

    // alice 建私人画板（含可检索节点，供越权检索断言用）+ 共享默认板
    assert.equal(
      (await saveBoard(aliceCookie, 's1-alice-board', [
        {
          id: 's1-n1',
          type: 'chat',
          position: { x: 0, y: 0 },
          data: { question: SEARCH_PROBE, answer: '', status: 'idle' },
        },
      ])).status,
      200
    );
    assert.equal((await saveBoard(aliceCookie, 'default-board')).status, 200);
    // bob 建本人画板（含对照关键字节点）
    assert.equal(
      (await saveBoard(bobCookie, 's1-bob-board', [
        {
          id: 's1-bn1',
          type: 'chat',
          position: { x: 0, y: 0 },
          data: { question: BOB_SEARCH_PROBE, answer: '', status: 'idle' },
        },
      ])).status,
      200
    );
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

  test('admin 以他人画板作 chat 归因 → 404 NOT_FOUND（admin 不例外）', async () => {
    const { status, body } = await chat(adminCookie, 's1-alice-board');
    assert.equal(status, 404);
    assert.equal(body.code, 'NOT_FOUND');
  });

  test('auto-title：他人已保存画板 → 404；本人/未保存画布 → 放行', async () => {
    const post = (cookie: string, id: string) =>
      fetch(`${base}/api/canvases/${id}/auto-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ question: '越权探针：给这次探索起个名' }),
      });

    const other = await post(bobCookie, 's1-alice-board');
    assert.equal(other.status, 404, '他人已保存画板不得写入 AI 归因');
    assert.equal(((await other.json()) as any).code, 'NOT_FOUND');

    assert.equal((await post(bobCookie, 's1-bob-board')).status, 200, '本人画板放行');
    assert.equal((await post(bobCookie, 's1-unsaved-board')).status, 200, '未保存画布放行（首节点先于首次保存）');
  });
  });

  describe('节点检索属主过滤（searchNodes userId 必填）', () => {
  test('属主检索本人画板 → 命中探针节点', async () => {
    const res = await searchInBoard(aliceCookie, 's1-alice-board', SEARCH_PROBE);
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 1, '属主应能检索到自己的节点');
  });

  test('非属主检索他人画板 → 空结果（跨租户不返回任何节点）', async () => {
    const res = await searchInBoard(bobCookie, 's1-alice-board', SEARCH_PROBE);
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 0, '跨租户检索必须返回空');
  });

  test('admin 检索他人画板 → 空结果（admin 不例外）', async () => {
    const res = await searchInBoard(adminCookie, 's1-alice-board', SEARCH_PROBE);
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 0, 'admin 检索他人画板必须返回空');
  });

  test('属主检索本人画板命中对照关键字（不误伤正常检索路径）', async () => {
    const res = await searchInBoard(bobCookie, 's1-bob-board', BOB_SEARCH_PROBE);
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 1, 'bob 应能检索到自己画板的节点');
  });

  test('他人关键字在本人画板检索 → 空（隔离是双向的）', async () => {
    const res = await searchInBoard(bobCookie, 's1-bob-board', SEARCH_PROBE);
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 0, 'alice 的探针关键字不应在 bob 画板命中');
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
