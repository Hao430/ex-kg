/**
 * S2 — 画布统计链路补全（2026-09-09，审计「画布增删改查统计链路」采纳项）：
 *
 * 1. canvas_create 服务端事实源（server/services/canvas.service.ts）：
 *    - 新建画板落 event_logs（category=canvas, event=canvas_create），全角色覆盖（含 admin）
 *    - 更新保存不产生 canvas_create（借 quotaGate 仅新建触发的语义做旗标）
 * 2. /api/db/status canvasCount 排除软删画布（server/core/db-status.ts）：
 *    - 与 admin overview totalCanvases 口径对齐；删除后计数回落
 * 3. conflict_healed 前端埋点（src/lib/storage.ts + src/lib/analytics.ts）：
 *    - 409 静默自愈成功（attempt>1）→ umami track('conflict_healed', {attempt})
 *    - 无冲突直连成功 / 自愈耗尽降级 → 均不上报
 * 前端部分 stub window/localStorage/fetch，模式同 a6（node 环境动态 import 前端模块）。
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import { signupRateLimiter, sendRegisterCodeRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';
let bobCookie = '';
let bobUserId = '';
let adminCookie = '';

// 本文件后半段会把 globalThis.fetch 换成前端桩（模式同 a6），
// 服务端辅助函数必须在桩安装前捕获真实 fetch。
const realFetch = globalThis.fetch.bind(globalThis);

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await realFetch(`${base}/api/db/status`);
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
  await realFetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '').match(/\b(\d{6})\b/)![1];
  const res = await realFetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code }),
  });
  assert.ok([200, 201].includes(res.status), `sign-up ${email} 应成功`);
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await realFetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

function saveBoard(cookie: string, id: string, title = id): Promise<Response> {
  return realFetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title, nodes: [], edges: [] }),
  });
}

function delBoard(cookie: string, id: string): Promise<Response> {
  return realFetch(`${base}/api/canvases/${id}`, { method: 'DELETE', headers: { cookie } });
}

async function canvasCount(): Promise<number> {
  const res = await realFetch(`${base}/api/db/status`);
  assert.equal(res.status, 200);
  return ((await res.json()) as any).canvasCount;
}

async function createEventsFor(entityId: string): Promise<any[]> {
  const url = new URL(`${base}/api/admin/event-logs`);
  url.searchParams.set('category', 'canvas');
  url.searchParams.set('event', 'canvas_create');
  url.searchParams.set('limit', '100');
  const res = await realFetch(url, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as any).logs.filter((l: any) => l.entity_id === entityId);
}

describe('S2 画布统计链路（服务端）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    await registerViaCode('s2-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('s2-bob@test.local', 'Bob123456!');
    bobUserId = ((await (
      await realFetch(`${base}/api/auth/me`, { headers: { cookie: bobCookie } })
    ).json()) as any)?.user?.id;
    assert.ok(bobUserId, '应能取到 bob userId');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('新建画板落 canvas_create 事件；更新保存不重复落', async () => {
    assert.equal((await saveBoard(bobCookie, 's2-board-1')).status, 200);
    const afterCreate = await createEventsFor('s2-board-1');
    assert.equal(afterCreate.length, 1, '首次保存应恰有一条 canvas_create');
    assert.equal(afterCreate[0].user_id, bobUserId, '事件归属创建者');

    // 更新保存（同 id 再存，改标题）：不得新增 canvas_create
    assert.equal((await saveBoard(bobCookie, 's2-board-1', '改名的画板')).status, 200);
    const afterUpdate = await createEventsFor('s2-board-1');
    assert.equal(afterUpdate.length, 1, '更新保存不得重复计创建事件');
  });

  test('admin 创建画板同样落 canvas_create（全角色覆盖）', async () => {
    assert.equal((await saveBoard(adminCookie, 's2-admin-board')).status, 200);
    const events = await createEventsFor('s2-admin-board');
    assert.equal(events.length, 1);
    assert.equal(events[0].user_id, '00000000-0000-0000-0000-000000000001');
  });

  test('db/status canvasCount 排除软删：新建 +1，删除后回落', async () => {
    const before = await canvasCount();
    assert.equal((await saveBoard(bobCookie, 's2-del-board')).status, 200);
    assert.equal(await canvasCount(), before + 1, '新建后计数 +1');
    assert.equal((await delBoard(bobCookie, 's2-del-board')).status, 200);
    assert.equal(await canvasCount(), before, '软删后计数回落（不含软删行）');
  });
});

// ---------------------------------------------------------------------------
// 前端：conflict_healed 埋点（stub window/localStorage/fetch，模式同 a6）
// ---------------------------------------------------------------------------
const store = new Map<string, string>();
const tracked: Array<{ name: string; data?: any }> = [];
(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  umami: { track: (name: string, data?: any) => tracked.push({ name, data }) },
};
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: any;
    constructor(type: string, opts?: { detail?: any }) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
}

interface MockRes {
  status?: number;
  body?: any;
  networkError?: boolean;
}
let fetchScript: MockRes[] = [];
(globalThis as any).fetch = async (_url: string, init?: any) => {
  const script = fetchScript.shift() ?? { status: 500 };
  if (script.networkError) throw new Error('network down');
  void init;
  const status = script.status ?? 500;
  return {
    ok: status < 400,
    status,
    json: async () => script.body ?? {},
  };
};

const { syncBoardToBackend } = await import('../src/lib/storage.js');

function makeBoard(): any {
  return { id: 's2-fe-board', name: '统计', updatedAt: Date.now(), nodes: [], edges: [] };
}

describe('S2 conflict_healed 前端埋点', () => {
  beforeEach(() => {
    tracked.length = 0;
    fetchScript = [];
    store.clear();
  });

  test('409 后重试成功 → track("conflict_healed", {attempt: 2})', async () => {
    fetchScript = [
      { status: 409, body: { error: 'conflict', latest_updated_at: '2026-09-09T00:00:00.000Z' } },
      { status: 200, body: { canvas: { updatedAt: '2026-09-09T00:00:01.000Z' } } },
    ];
    const result = await syncBoardToBackend(makeBoard());
    assert.equal(result, 'ok');
    const healed = tracked.filter((t) => t.name === 'conflict_healed');
    assert.equal(healed.length, 1);
    assert.deepEqual(healed[0].data, { attempt: 2 });
  });

  test('无冲突直连成功 → 不上报', async () => {
    fetchScript = [{ status: 200, body: { canvas: { updatedAt: '2026-09-09T00:00:00.000Z' } } }];
    assert.equal(await syncBoardToBackend(makeBoard()), 'ok');
    assert.equal(tracked.filter((t) => t.name === 'conflict_healed').length, 0);
  });

  test('自愈重试耗尽（3 次 409）→ 降级提示路径，不上报 healed', async () => {
    const latest = '2026-09-09T00:00:00.000Z';
    fetchScript = [
      { status: 409, body: { latest_updated_at: latest } },
      { status: 409, body: { latest_updated_at: latest } },
      { status: 409, body: { latest_updated_at: latest } },
    ];
    assert.equal(await syncBoardToBackend(makeBoard()), 'conflict');
    assert.equal(tracked.filter((t) => t.name === 'conflict_healed').length, 0);
  });

  test('409 后重试遇网络失败 → fail，不上报 healed', async () => {
    fetchScript = [
      { status: 409, body: { latest_updated_at: '2026-09-09T00:00:00.000Z' } },
      { networkError: true },
    ];
    assert.equal(await syncBoardToBackend(makeBoard()), 'fail');
    assert.equal(tracked.filter((t) => t.name === 'conflict_healed').length, 0);
  });
});
