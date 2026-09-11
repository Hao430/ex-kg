/**
 * 前端 — board-store 唯一列表真相（2026-09-10 画布列表/同步重构）。
 * stub window/localStorage，动态 import（模式同 tests/a2-server-load.test.ts）。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DeepDiveBoardMeta } from '../src/types.ts';

const store = new Map<string, string>();
const events: Array<{ type: string; detail: any }> = [];
(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: (e: any) => {
    events.push({ type: e?.type, detail: e?.detail });
    return true;
  },
};
/** 置 true 模拟配额耗尽 / 隐私模式：localStorage 写抛异常（读仍可用） */
let failWrites = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error('QuotaExceededError');
    store.set(k, v);
  },
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

const boardScope = await import('../src/lib/board-scope.js');
const boardStore = await import('../src/lib/board-store.js');

function meta(id: string, name = id, updatedAt = 1000, nodeCount = 0): DeepDiveBoardMeta {
  return { id, name, updatedAt, nodeCount };
}

describe('board-store 合并与一致性', () => {
  beforeEach(() => {
    store.clear();
    events.length = 0;
    failWrites = false;
    boardStore.resetForTest();
    boardScope.resetPersistFailureThrottleForTest();
  });

  test('hydrateFromServer 后列表= 服务端快照，getBoardList 稳定引用', () => {
    boardStore.hydrateFromServer([meta('s1'), meta('s2')]);
    const a = boardStore.getBoardList();
    const b = boardStore.getBoardList();
    assert.equal(a, b, '未变更时必须返回同一引用（useSyncExternalStore 前提）');
    assert.deepEqual(a.map((m) => m.id), ['s1', 's2']);

    boardStore.upsertLocal(meta('d1', 'draft'), { dirty: true });
    const c = boardStore.getBoardList();
    assert.notEqual(a, c, '变更后应替换引用');
    assert.deepEqual(c.map((m) => m.id), ['s1', 's2', 'd1'], '本地草稿尾插');
  });

  test('dirty 本地版胜出服务端 meta（与服务端 409 自愈口径一致）', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1', 'server-name', 100)]);
    boardStore.upsertLocal(meta('s1', 'local-name', 200), { dirty: true });
    const list = boardStore.getBoardList();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'local-name');
  });

  test('墓碑隐藏 + 服务端删除确认后清理 blob/索引', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1')]);
    store.set(`${boardScope.BOARD_BLOB_PREFIX}s1`, '{}');
    store.set(`${boardScope.SERVER_TS_PREFIX}s1`, '2026-09-10T00:00:00.000Z');

    boardStore.addTombstone('s1');
    assert.equal(boardStore.getBoardList().length, 0, '墓碑应即时隐藏');
    assert.ok(boardStore.getState().tombstones.has('s1'));

    boardStore.confirmServerDelete('s1');
    assert.equal(store.has(`${boardScope.BOARD_BLOB_PREFIX}s1`), false, 'blob 应清理');
    assert.equal(store.has(`${boardScope.SERVER_TS_PREFIX}s1`), false, '版本小键应清理');
    assert.equal(boardStore.getState().tombstones.size, 0);
  });

  test('hydrateFromServer(null / 非数组) 为 no-op（离线不得清空缓存）', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1')]);
    boardStore.hydrateFromServer(null as any);
    boardStore.hydrateFromServer(undefined as any);
    assert.equal(boardStore.getBoardList().length, 1, '离线刷新不得丢列表');
  });

  test('离线冷启动：绑定 scope 后用持久化索引立即出列表（无需网络）', () => {
    boardScope.writeScopedIndex([meta('cached', '缓存板')], 'u1');
    boardStore.bindScope('u1');
    const list = boardStore.getBoardList();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '缓存板');
  });

  test('幽灵板：有服务端版本、非 dirty、服务端已无 → 移出列表并派发事件', () => {
    boardStore.bindScope('u1');
    store.set(`${boardScope.SERVER_TS_PREFIX}ghost`, '2026-09-10T00:00:00.000Z');
    boardStore.upsertLocal(meta('ghost'), { dirty: true });
    boardStore.markDirty('ghost', false);
    assert.equal(boardStore.getBoardList().length, 1, '水合前不作为幽灵');

    boardStore.hydrateFromServer([]); // 服务端列表成功返回但无此板
    assert.equal(boardStore.getBoardList().length, 0, '幽灵应移出列表');
    assert.ok(
      events.some((e) => e.type === 'deepdive:board-remote-deleted' && e.detail?.boardId === 'ghost'),
      '应派发远端删除事件'
    );
  });

  test('confirmServerSave：清 dirty 且列表立即反映最新本地 meta', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1', 'old-name', 100)]);
    boardStore.upsertLocal(meta('s1', 'new-name', 200), { dirty: true });
    assert.equal(boardStore.isDirty('s1'), true);

    boardStore.confirmServerSave('s1');
    assert.equal(boardStore.isDirty('s1'), false);
    const entry = boardStore.getBoardList().find((m) => m.id === 's1');
    assert.equal(entry?.name, 'new-name');
    assert.equal(entry?.updatedAt, 200);
  });

  test('hydrateClaimedDrafts：游客草稿迁入账号 scope 且标 dirty，guest 索引移除该条', () => {
    boardScope.writeScopedIndex([meta('g1'), meta('default-board')], 'guest');
    boardStore.bindScope('u1');
    boardStore.hydrateClaimedDrafts([meta('g1')], 'u1');

    assert.deepEqual(boardStore.getBoardList().map((m) => m.id), ['g1']);
    assert.equal(boardStore.isDirty('g1'), true, '认领后应待上传');
    assert.deepEqual(
      boardScope.readScopedIndex('guest').map((m) => m.id),
      ['default-board'],
      'guest 索引只移除已认领条目'
    );
  });

  test('localStorage 写失败派发 local-persist-failed（dirty 落不了盘必须让用户看见）', () => {
    boardStore.bindScope('u1');
    boardStore.upsertLocal(meta('d1'), { dirty: true }); // 正常写入，先建立基线
    events.length = 0;

    failWrites = true;
    boardStore.upsertLocal(meta('d2'), { dirty: true }); // recompute → persist 抛异常

    const notify = events.filter((e) => e.type === 'deepdive:local-persist-failed');
    assert.equal(notify.length, 1, '写失败必须派发通知事件（旧实现只 console.error）');
    assert.equal(notify[0].detail?.where, 'board-store');
    // 内存列表仍前进（UI 不因配额问题卡住），只是未落盘
    assert.deepEqual(boardStore.getBoardList().map((m) => m.id), ['d1', 'd2']);
  });

  test('作用域隔离：u1 草稿不出现在 u2，切回 u1 仍在（持久化）', () => {
    boardStore.bindScope('u1');
    boardStore.upsertLocal(meta('draft-u1'), { dirty: true });
    assert.equal(boardStore.getBoardList().length, 1);

    boardStore.bindScope('u2');
    assert.equal(boardStore.getBoardList().length, 0, 'u2 不得看到 u1 草稿');

    boardStore.bindScope('u1');
    assert.deepEqual(
      boardStore.getBoardList().map((m) => m.id),
      ['draft-u1'],
      '切回 u1 草稿应从持久化恢复'
    );
  });
});
