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

  test('幽灵板：曾同步过（有版本小键）却不在服务端快照里 → 水合时收敛并派发事件', () => {
    // 绘制缓存里有一条上次同步过的板；版本小键 = 「服务端本应有它」的证据
    store.set(`${boardScope.SERVER_TS_PREFIX}ghost`, '2026-09-10T00:00:00.000Z');
    boardScope.writeScopedIndex([meta('ghost')], 'u1');
    boardStore.bindScope('u1');
    assert.equal(boardStore.getBoardList().length, 1, '水合前用缓存出画面');

    boardStore.hydrateFromServer([]); // 服务端列表成功返回但无此板
    assert.equal(boardStore.getBoardList().length, 0, '幽灵应移出列表');
    assert.ok(
      events.some((e) => e.type === 'deepdive:board-remote-deleted' && e.detail?.boardId === 'ghost'),
      '应派发远端删除事件'
    );
  });

  test('未确认改动优先于远端删除判定：dirty 的板不因服务端快照里没有而消失', () => {
    store.set(`${boardScope.SERVER_TS_PREFIX}wip`, '2026-09-10T00:00:00.000Z');
    boardScope.writeScopedIndex([meta('wip')], 'u1');
    boardStore.bindScope('u1');
    boardStore.upsertLocal(meta('wip', '本地改过的名'), { dirty: true });

    boardStore.hydrateFromServer([]);
    assert.deepEqual(
      boardStore.getBoardList().map((m) => m.id),
      ['wip'],
      '还没传上去的改动不能被「服务端没有」判成已删'
    );
    assert.equal(boardStore.isDirty('wip'), true);
  });

  test('confirmServerSave：清 dirty，并以服务端回包收敛条目（本地投影不顶替服务端真相）', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1', 'old-name', 100)]);
    boardStore.upsertLocal(meta('s1', 'local-name', 200, 2), { dirty: true });
    assert.equal(boardStore.isDirty('s1'), true);

    boardStore.confirmServerSave('s1', {
      title: 'server-name',
      nodeCount: 7,
      updatedAt: new Date(9000).toISOString(),
    });
    assert.equal(boardStore.isDirty('s1'), false);
    const entry = boardStore.getBoardList().find((m) => m.id === 's1');
    assert.equal(entry?.name, 'server-name', '服务端确认过的字段由服务端回包决定');
    assert.equal(entry?.nodeCount, 7, 'nodeCount 取事务内重算值（含墓碑拒绝）');
    assert.equal(entry?.updatedAt, 9000);
  });

  test('confirmServerSave：回包里没有的字段退回本地（新建板第一次保存）', () => {
    boardStore.bindScope('u1');
    boardStore.upsertLocal(meta('fresh', '我的新板', 500, 1), { dirty: true });

    boardStore.confirmServerSave('fresh');
    const entry = boardStore.getBoardList().find((m) => m.id === 'fresh');
    assert.equal(entry?.name, '我的新板');
    assert.equal(boardStore.getState().serverIds.has('fresh'), true, '保存成功即归入服务端快照');
  });

  test('未落地的改名不被内容保存回包吞掉（metaDirty 期间保持本地值）', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1', 'old-name', 100)]);
    boardStore.updateMetaLocal('s1', { name: '改过的名' }); // 入队 PATCH，尚未确认
    boardStore.upsertLocal(meta('s1', '改过的名', 200), { dirty: true });

    // 内容保存先回来：服务端此时回包里的 title 仍是旧名（PATCH 还没落）
    boardStore.confirmServerSave('s1', { title: 'old-name', updatedAt: new Date(300).toISOString() });
    const entry = boardStore.getBoardList().find((m) => m.id === 's1');
    assert.equal(entry?.name, '改过的名', 'meta 执行器从列表读 PATCH body，吞掉即等于取消用户改名');
    assert.equal(boardStore.getState().metaDirty.has('s1'), true, 'PATCH 未确认前必须保持待同步');
  });

  test('[不变量] 已同步条目的展示值只能由服务端推进，本地非脏回写不产生陈旧覆盖', () => {
    boardStore.bindScope('u1');
    boardStore.hydrateFromServer([meta('s1', 'server-name', 100)]);
    // 采用服务端版落盘：内容就是服务端那份，不得留成永不失效的本地覆盖
    boardStore.upsertServerMeta(meta('s1', 'stale-local', 50));
    boardStore.hydrateFromServer([meta('s1', 'renamed-elsewhere', 300)]);
    const entry = boardStore.getBoardList().find((m) => m.id === 's1');
    assert.equal(entry?.name, 'renamed-elsewhere', '他端改名必须能透出（旧实现在这里会永久停在本地值）');
  });

  test('isShared 是服务端口径：水合带过来，本地缓冲/回包不得改写（ADR-0018）', () => {
    boardStore.hydrateFromServer([{ ...meta('default-board'), isShared: true }]);
    assert.equal(boardStore.getBoardList()[0].isShared, true);

    // 本地未确认 meta（改名/收藏）叠加显示时不得把共享标记抹掉或反向置位
    boardStore.upsertLocal({ ...meta('default-board', '我改的名'), isShared: false });
    assert.equal(boardStore.getBoardList()[0].isShared, true, '本地投影不得改写服务端口径');

    // 内容保存回包同样不带该字段 → 继续跟随服务端快照
    boardStore.confirmServerSave('default-board', { title: '服务端名' });
    assert.equal(boardStore.getBoardList()[0].isShared, true);

    // private 模式下服务端给 false，本地也不得把它翻成 true
    boardStore.hydrateFromServer([{ ...meta('default-board'), isShared: false }]);
    boardStore.upsertLocal({ ...meta('default-board'), isShared: true });
    assert.equal(boardStore.getBoardList()[0].isShared, false);
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
