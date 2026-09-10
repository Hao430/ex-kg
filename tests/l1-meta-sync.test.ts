/**
 * L1 — 前端 meta 同步执行器（storage.ts ↔ sync-queue）
 *
 * 覆盖：updateBoardMetaLocally 入 meta 队列并 PATCH；200 确认收敛并推进版本小键；
 * 404 收敛幽灵板；网络失败保留任务重试。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
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
    constructor(public type: string, public opts?: { detail?: any }) {}
    get detail() { return this.opts?.detail; }
  };
}

let fetchCalls: Array<{ url: string; method: string; body: any }> = [];
let fetchResponse: { status: number; body?: any } | null = null;
let fetchError: Error | null = null;
(globalThis as any).fetch = async (url: string, init?: any) => {
  if (fetchError) throw fetchError;
  fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
  return {
    ok: (fetchResponse?.status ?? 500) < 400,
    status: fetchResponse?.status ?? 500,
    json: async () => fetchResponse?.body,
  } as any;
};

const bs = await import('../src/lib/board-store.js');
const scope = await import('../src/lib/board-scope.js');
const qs = await import('../src/lib/sync-queue.js');
const storage: any = await import('../src/lib/storage.js');

const ID = 'l1-meta-fe';
const SERVER_TS = '2026-01-01T00:00:00.000Z';

function seedServerBoard(): void {
  store.clear();
  bs.resetForTest();
  qs.resetForTest();
  bs.bindScope('u1');
  qs.bindQueueScope('u1');
  bs.hydrateFromServer([{ id: ID, name: 'B', updatedAt: 1, nodeCount: 0, isFavorite: false, isArchived: false }]);
  store.set(`${scope.SERVER_TS_PREFIX}${ID}`, SERVER_TS);
  fetchCalls = [];
  fetchResponse = null;
  fetchError = null;
}

describe('L1 前端 meta 同步执行器', () => {
  beforeEach(() => {
    seedServerBoard();
  });
  afterEach(() => {
    bs.resetForTest();
    qs.resetForTest();
  });

  test('updateBoardMetaLocally 入 meta 队列并 PATCH，200 收敛且推进版本小键', async () => {
    storage.updateBoardMetaLocally(ID, { isFavorite: true });
    assert.equal(bs.getState().metaDirty.has(ID), true);
    assert.equal(qs.hasPending(ID), true);

    fetchResponse = {
      status: 200,
      body: { success: true, canvas: { id: ID, title: 'B', isFavorite: true, isArchived: false, updatedAt: '2026-02-02T00:00:00.000Z' } },
    };
    await qs.flush();

    const patch = fetchCalls.find((c) => c.method === 'PATCH');
    assert.ok(patch, '应发出 PATCH');
    assert.ok(patch!.url.includes(`/api/canvases/${ID}/meta`), `URL 应为 meta 端点：${patch!.url}`);
    assert.equal(patch!.body.isFavorite, true);
    assert.equal(patch!.body.title, 'B');
    assert.equal(patch!.body.folderId, null);

    assert.equal(qs.hasPending(ID), false, '任务应出队');
    assert.equal(bs.getState().metaDirty.has(ID), false, 'metaDirty 应清零');
    assert.equal(store.get(`${scope.SERVER_TS_PREFIX}${ID}`), '2026-02-02T00:00:00.000Z', '版本小键应推进');
    assert.equal(bs.getBoardList().find((b) => b.id === ID)!.isFavorite, true);
  });

  test('PATCH 404（他端已删）→ 收敛幽灵板', async () => {
    storage.updateBoardMetaLocally(ID, { isArchived: true });
    fetchResponse = { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } };
    await qs.flush();

    assert.equal(bs.getBoardList().some((b) => b.id === ID), false, '画板应移出列表');
    assert.equal(qs.hasPending(ID), false);
  });

  test('网络失败 → 任务保留待重试，本地偏好不回滚', async () => {
    storage.updateBoardMetaLocally(ID, { isFavorite: true });
    fetchError = new Error('network down');
    await qs.flush();

    assert.equal(qs.hasPending(ID), true, '失败应保留任务');
    assert.equal(bs.getBoardList().find((b) => b.id === ID)!.isFavorite, true);
  });

  test('PATCH 400 FOLDER_INVALID → 清除本地陈旧分组归属，任务出队不重试', async () => {
    bs.updateMetaLocal(ID, { folderId: 'stale-folder' });
    storage.updateBoardMetaLocally(ID, { isFavorite: true }); // 携带陈旧 folderId 触发同步
    fetchResponse = { status: 400, body: { error: '分组不存在', code: 'FOLDER_INVALID' } };
    await qs.flush();

    assert.equal(qs.hasPending(ID), false, '永久失败不应重试');
    assert.equal(bs.getBoardList().find((b) => b.id === ID)!.folderId, null);
  });
});
