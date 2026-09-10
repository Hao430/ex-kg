/**
 * H1 — 画布删除链路安全加固：严格属主制 + 共享默认板特例 + 软删除 + 竞态防复活
 *
 * 后端：
 * - 越权矩阵：非属主读（404）/ 写 / 删（403 CANVAS_FORBIDDEN）
 * - default-board 共享回归：所有登录用户可读写，但禁止删除
 * - admin 放行
 * - 软删：删除后列表/单读 404、幂等再删 {success:false}、同 id 再 save 404 防复活、
 *   搜索不命中、canvas_delete 审计、配额释放
 * 前端（stub window/localStorage/fetch，同 a2/a5 模式）：
 * - deleteBoard 仅服务端确认（2xx/404）才清本地；403/断网保留本地并返回失败
 * - sync-queue dequeue：删除后待同步任务被移除，flush 不再触发保存
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
let carolCookie = ''; // 新注册体验版（配额用例）
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

async function saveBoard(cookie: string, id: string, nodes: any[] = []): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function getBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
}

function delBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { method: 'DELETE', headers: { cookie } });
}

async function listBoardIds(cookie: string): Promise<string[]> {
  const res = await fetch(`${base}/api/canvases`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as any[]).map((c) => c.id);
}

async function auditActions(action: string): Promise<any[]> {
  const url = new URL(`${base}/api/admin/audit-logs`);
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', '100');
  url.searchParams.set('action', action);
  const res = await fetch(url, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200);
  return (await res.json() as any).logs;
}

describe('H1 画布删除链路安全加固（后端）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('h1-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('h1-bob@test.local', 'Bob123456!');
    await registerViaCode('h1-carol@test.local', 'Carol123456!', 'Carol');
    carolCookie = await signIn('h1-carol@test.local', 'Carol123456!');

    // alice 自建画板，供越权矩阵使用
    const res = await saveBoard(aliceCookie, 'h1-alice-board');
    assert.equal(res.status, 200);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('越权：bob 读 alice 画板 → 404（IDOR 保护）', async () => {
    const res = await getBoard(bobCookie, 'h1-alice-board');
    assert.equal(res.status, 404);
  });

  test('越权：bob 写 alice 画板 → 403 CANVAS_FORBIDDEN', async () => {
    const res = await saveBoard(bobCookie, 'h1-alice-board', []);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
  });

  test('越权：bob 删 alice 画板 → 403 CANVAS_FORBIDDEN（修复前为 200 假成功）', async () => {
    const res = await delBoard(bobCookie, 'h1-alice-board');
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
    // alice 画板仍完好
    assert.equal((await getBoard(aliceCookie, 'h1-alice-board')).status, 200);
  });

  test('admin 可读写删任意画板', async () => {
    assert.equal((await getBoard(adminCookie, 'h1-alice-board')).status, 200);
    const del = await delBoard(adminCookie, 'h1-alice-board');
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as any).success, true);
    assert.equal((await getBoard(aliceCookie, 'h1-alice-board')).status, 404);
  });

  test('default-board 共享回归：bob 可写、alice 可读', async () => {
    const save = await saveBoard(bobCookie, 'default-board');
    assert.equal(save.status, 200);
    assert.equal((await getBoard(aliceCookie, 'default-board')).status, 200);
    const save2 = await saveBoard(aliceCookie, 'default-board');
    assert.equal(save2.status, 200);
  });

  test('共享默认板禁删：alice/bob DELETE default-board → 403', async () => {
    for (const cookie of [aliceCookie, bobCookie]) {
      const res = await delBoard(cookie, 'default-board');
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as any).code, 'CANVAS_FORBIDDEN');
    }
    // 未受删除影响
    assert.equal((await getBoard(aliceCookie, 'default-board')).status, 200);
  });

  test('软删：alice 建 h1-softdel 并删除 → 200 {success:true}', async () => {
    const keyword = 'h1青云独关键词xyzzy';
    const res = await saveBoard(aliceCookie, 'h1-softdel', [
      { id: 'h1-n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: keyword, depth: 0 } },
    ]);
    assert.equal(res.status, 200);

    const del = await delBoard(aliceCookie, 'h1-softdel');
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as any).success, true);
  });

  test('软删后：列表不含、单读 404', async () => {
    assert.ok(!(await listBoardIds(aliceCookie)).includes('h1-softdel'));
    assert.equal((await getBoard(aliceCookie, 'h1-softdel')).status, 404);
  });

  test('幂等：再删已软删画板 → 200 {success:false}', async () => {
    const res = await delBoard(aliceCookie, 'h1-softdel');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).success, false);
  });

  test('防复活：同 id 再 save → 404', async () => {
    const res = await saveBoard(aliceCookie, 'h1-softdel');
    assert.equal(res.status, 404);
  });

  test('搜索不命中已删画布节点', async () => {
    const res = await fetch(`${base}/api/canvases/h1-softdel/search?q=${encodeURIComponent('h1青云独关键词xyzzy')}`, {
      headers: { cookie: aliceCookie },
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).results.length, 0);
  });

  test('canvas_delete 审计含 targetId（软删不影响审计）', async () => {
    const logs = await auditActions('canvas_delete');
    assert.ok(logs.some((l) => l.target_id === 'h1-softdel'), '应含 h1-softdel 的删除记录');
  });

  test('配额释放：carol 建满 3 拒第 4 → 删 1 → 再建成功', async () => {
    for (const id of ['h1-carol-1', 'h1-carol-2', 'h1-carol-3']) {
      const res = await saveBoard(carolCookie, id);
      assert.equal(res.status, 200, `${id} 应建成功`);
    }
    const fourth = await saveBoard(carolCookie, 'h1-carol-4');
    assert.equal(fourth.status, 403);
    assert.equal(((await fourth.json()) as any).code, 'BOARD_LIMIT_REACHED');

    const del = await delBoard(carolCookie, 'h1-carol-1');
    assert.equal(del.status, 200);

    const retry = await saveBoard(carolCookie, 'h1-carol-4');
    assert.equal(retry.status, 200, '软删释放配额后应可再建');
  });
});

// ---- 前端：deleteBoard 确认制 + sync-queue dequeue（stub 环境，同 a2/a5 模式） ----
// 注意：stub 在本 describe 的 before 钩子内设置并动态 import（此时后端用例已跑完，
// 覆盖 globalThis.fetch 不再影响后端；动态 import 保证 stub 先于模块顶层副作用就位）。

describe('H1 前端乐观删除（墓碑）与 dequeue', () => {
  const store = new Map<string, string>();
  let fetchResponse: { status: number; body?: any } | null = null;
  let fetchError: Error | null = null;

  let deleteBoardLocally: (id: string) => { needsServer: boolean };
  let loadBoard: (id: string) => any;
  let loadBoardList: () => any[];
  let enqueue: (id: string) => void;
  let dequeue: (id: string) => void;
  let hasPending: (id: string) => boolean;
  let isDeleteQueued: (id: string) => boolean;
  let flush: () => Promise<void>;
  let resetForTest: () => void;
  let setSyncExecutor: (fn: any) => void;
  let setBackoffBaseForTest: (ms: number) => void;
  let boardStore: any;
  let boardScope: any;

  before(async () => {
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
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
    (globalThis as any).fetch = async () => {
      if (fetchError) throw fetchError;
      return {
        ok: (fetchResponse?.status ?? 500) < 400,
        status: fetchResponse?.status ?? 500,
        json: async () => fetchResponse?.body,
      } as any;
    };

    const storageMod: any = await import('../src/lib/storage.ts');
    const queueMod: any = await import('../src/lib/sync-queue.ts');
    boardStore = await import('../src/lib/board-store.ts');
    boardScope = await import('../src/lib/board-scope.ts');
    deleteBoardLocally = storageMod.deleteBoardLocally;
    loadBoard = storageMod.loadBoard;
    loadBoardList = storageMod.loadBoardList;
    enqueue = queueMod.enqueue;
    dequeue = queueMod.dequeue;
    hasPending = queueMod.hasPending;
    isDeleteQueued = queueMod.isDeleteQueued;
    flush = queueMod.flush;
    resetForTest = queueMod.resetForTest;
    setSyncExecutor = queueMod.setSyncExecutor;
    setBackoffBaseForTest = queueMod.setBackoffBaseForTest;
  });

  after(() => {
    resetForTest();
    setBackoffBaseForTest(2000);
  });

  const BOARD_KEY = 'deepdive_board_h1-fe-board';
  const ID = 'h1-fe-board';

  /** server=true：造出「已同步」画板（有 server ts 小键），否则纯本地草稿 */
  const seed = (server: boolean) => {
    store.clear();
    resetForTest();
    boardStore.resetForTest();
    boardStore.bindScope('guest');
    store.set(BOARD_KEY, JSON.stringify({ id: ID, name: 'FE板', updatedAt: 1, nodes: [], edges: [] }));
    if (server) store.set(`${boardScope.SERVER_TS_PREFIX}${ID}`, '2026-01-01T00:00:00.000Z');
    boardStore.upsertLocal({ id: ID, name: 'FE板', updatedAt: 1, nodeCount: 0 }, { dirty: false });
  };

  test('游客/纯本地草稿：直接删除，无需服务端请求', () => {
    seed(false);
    fetchResponse = { status: 200, body: { success: true } };
    const r = deleteBoardLocally(ID);
    assert.equal(r.needsServer, false);
    assert.equal(store.has(BOARD_KEY), false, 'blob 应清理');
    assert.equal(loadBoardList().some((b) => b.id === ID), false);
  });

  test('已同步画板乐观删除：立即隐藏，后台 200 确认后清 blob', async () => {
    seed(true);
    fetchResponse = { status: 200, body: { success: true } };
    const r = deleteBoardLocally(ID);
    assert.equal(r.needsServer, true);
    assert.equal(loadBoardList().some((b) => b.id === ID), false, '应即时隐藏（墓碑）');
    assert.ok(isDeleteQueued(ID), '应入删除队列');
    await flush();
    assert.equal(store.has(BOARD_KEY), false, '服务端确认后清 blob');
    assert.equal(hasPending(ID), false);
  });

  test('404（远端已删）→ 视为成功清理', async () => {
    seed(true);
    fetchResponse = { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } };
    deleteBoardLocally(ID);
    await flush();
    assert.equal(store.has(BOARD_KEY), false);
    assert.equal(loadBoard(ID), null);
  });

  test('403 删除被拒 → 墓碑回滚，画板重新可见且本地保留', async () => {
    seed(true);
    fetchResponse = { status: 403, body: { error: '无权删除此画板', code: 'CANVAS_FORBIDDEN' } };
    deleteBoardLocally(ID);
    await flush();
    assert.ok(loadBoard(ID), '本地 blob 应保留（回滚）');
    assert.ok(loadBoardList().some((b) => b.id === ID), '画板应重新可见');
  });

  test('断网 → 墓碑保留（隐藏防复活），待恢复网络重试', async () => {
    seed(true);
    setBackoffBaseForTest(10000); // 退避放大，避免测试期定时器自动重试
    fetchError = new Error('network down');
    deleteBoardLocally(ID);
    await flush();
    assert.equal(loadBoardList().some((b) => b.id === ID), false, '断网期间保持隐藏');
    assert.equal(isDeleteQueued(ID), true, '删除意图保留待重试');
    fetchError = null;
    resetForTest();
    setBackoffBaseForTest(2000);
  });

  test('dequeue：删除后待同步任务被移除，flush 不再触发保存', async () => {
    store.clear();
    resetForTest();
    setBackoffBaseForTest(10000);
    const executorCalls: string[] = [];
    setSyncExecutor(async (id: string) => {
      executorCalls.push(id);
      return 'ok';
    });
    enqueue('h1-dequeue-target');
    dequeue('h1-dequeue-target'); // 删除画板时同步移除（同一宏任务内，先于定时器 flush）
    assert.equal(hasPending('h1-dequeue-target'), false);
    await new Promise((r) => setTimeout(r, 20)); // 让 scheduleFlush(0) 的定时器跑完
    await flush();
    assert.deepEqual(executorCalls, [], '出队后不应有任何保存调用');
    resetForTest();
    setBackoffBaseForTest(2000);
  });
});
