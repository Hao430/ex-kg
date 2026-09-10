/**
 * L1 — folder-store 在线优先 CRUD 与本地缓存
 *
 * 覆盖：scope 缓存载入、服务端水合排序、创建/改名/删除的乐观更新与失败回滚、
 * 离线拒绝、删除分组后本地画板归属收敛。
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
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
  writable: true,
});

let fetchResponse: { status: number; body?: any } | null = null;
let fetchError: Error | null = null;
let fetchCalls: Array<{ url: string; method: string; body: any }> = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  if (fetchError) throw fetchError;
  fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
  return {
    ok: (fetchResponse?.status ?? 500) < 400,
    status: fetchResponse?.status ?? 500,
    json: async () => fetchResponse?.body,
  } as any;
};

const fs = await import('../src/lib/folder-store.js');
const bs = await import('../src/lib/board-store.js');
const scope = await import('../src/lib/board-scope.js');

function setOnline(v: boolean): void {
  (globalThis as any).navigator.onLine = v;
}

describe('L1 folder-store', () => {
  beforeEach(() => {
    store.clear();
    fs.resetForTest();
    bs.resetForTest();
    fetchCalls = [];
    fetchResponse = null;
    fetchError = null;
    setOnline(true);
    fs.bindScope('u1');
    bs.bindScope('u1');
  });
  afterEach(() => {
    fs.resetForTest();
    bs.resetForTest();
  });

  test('hydrateFromServer 按 sort_order 排序并持久化到 scoped key', () => {
    fs.hydrateFromServer([
      { id: 'b', name: '乙', sort_order: 2 },
      { id: 'a', name: '甲', sort_order: 1 },
    ]);
    assert.deepEqual(fs.getFolders().map((f) => f.id), ['a', 'b']);
    const raw = store.get(scope.foldersKey('u1'));
    assert.ok(raw && raw.includes('甲'));
  });

  test('bindScope 载入本地缓存（离线可见）', () => {
    fs.hydrateFromServer([{ id: 'a', name: '甲', sort_order: 1 }]);
    const cached = fs.getFolders();
    fs.resetForTest();
    fs.bindScope('u1');
    assert.deepEqual(fs.getFolders(), cached, '新 scope 应命中本地缓存');
  });

  test('创建分组：乐观添加 → 201 以服务端条目收敛', async () => {
    fetchResponse = { status: 201, body: { success: true, folder: { id: 'x', name: '新组', sort_order: 0 } } };
    const r = await fs.createFolder('新组');
    assert.equal(r.ok, true);
    const call = fetchCalls.find((c) => c.method === 'POST');
    assert.ok(call && call.body.name === '新组');
    assert.ok(fs.getFolders().some((f) => f.name === '新组'));
  });

  test('创建分组失败 → 回滚且返回错误', async () => {
    fetchResponse = { status: 400, body: { error: '分组已存在', code: 'FOLDER_EXISTS' } };
    const r = await fs.createFolder('重复');
    assert.equal(r.ok, false);
    assert.equal((r as any).error, '分组已存在');
    assert.equal(fs.getFolders().length, 0, '失败应回滚乐观条目');
  });

  test('离线创建 → 拒绝且不发请求', async () => {
    setOnline(false);
    const r = await fs.createFolder('离线组');
    assert.equal(r.ok, false);
    assert.equal(fetchCalls.length, 0);
  });

  test('改名失败 → 回滚原名', async () => {
    fs.hydrateFromServer([{ id: 'a', name: '甲', sort_order: 1 }]);
    fetchResponse = { status: 403, body: { error: '无权修改', code: 'FOLDER_FORBIDDEN' } };
    const r = await fs.renameFolder('a', '乙');
    assert.equal(r.ok, false);
    assert.equal(fs.getFolders()[0].name, '甲');
  });

  test('删除分组成功 → 移除并收敛本地画板归属', async () => {
    fs.hydrateFromServer([{ id: 'a', name: '甲', sort_order: 1 }]);
    bs.upsertLocal({ id: 'board-1', name: '板一', updatedAt: 1, nodeCount: 0, folderId: 'a' }, { dirty: false });
    assert.equal(bs.getBoardList().find((b) => b.id === 'board-1')!.folderId, 'a');

    fetchResponse = { status: 200, body: { success: true } };
    const r = await fs.deleteFolder('a');
    assert.equal(r.ok, true);
    assert.equal(fs.getFolders().length, 0);
    assert.equal(bs.getBoardList().find((b) => b.id === 'board-1')!.folderId, null, '画板应回到未分组');
  });

  test('refreshFolders 401 → 标记离线且不清空缓存', async () => {
    fs.hydrateFromServer([{ id: 'a', name: '甲', sort_order: 1 }]);
    fetchResponse = { status: 401, body: { error: 'unauthorized' } };
    const ok = await fs.refreshFolders();
    assert.equal(ok, false);
    assert.equal(fs.getFolders().length, 1, '失败不得清空缓存');
    assert.equal(fs.getFoldersView().offline, true);
  });
});
