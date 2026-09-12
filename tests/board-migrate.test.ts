/**
 * 阶段 5b — 旧共享默认板存量再落位（ADR-0018）。
 *
 * 覆盖：判定门槛（游客/已迁移/服务端可读/无内容/探测不出来）、搬迁结果（新 id、内容整份带走、
 * 旧条目与旧 blob 摘除、不继承旧板版本号）、失败不破坏源（复制没落地）、并发幂等。
 * stub window/localStorage/fetch，动态 import（模式同 tests/board-store.test.ts）。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredBoard } from '../src/lib/storage.ts';

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
    type: string;
    detail: any;
    constructor(type: string, opts?: { detail?: any }) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
}
// 上传队列一旦真的发请求会异步回写列表 meta，干扰断言；挂成永不 resolve 的请求，
// 让它停在 in-flight（afterEach 的 resetForTest 会清掉），事件循环也不被它拖住。
(globalThis as any).fetch = () => new Promise(() => {});

const boardScope = await import('../src/lib/board-scope.js');
const boardStore = await import('../src/lib/board-store.js');
const syncQueue = await import('../src/lib/sync-queue.js');
const { rehomeLegacyDefaultBoard, hasUserContent, probeBoardAccess } = await import(
  '../src/lib/board-migrate.js'
);

const LEGACY = 'default-board';
const USER = 'user-rehome-1';

function starterNodes(): any[] {
  return [
    {
      id: 'n-starter',
      type: 'chat',
      position: { x: 0, y: 0 },
      data: { title: '新探索主题', depth: 0, question: '', answer: '', status: 'idle' },
    },
  ];
}

function contentNodes(): any[] {
  return [
    ...starterNodes(),
    {
      id: 'n-1',
      type: 'chat',
      position: { x: 200, y: 0 },
      data: { title: '子问题', depth: 1, question: '为什么天空是蓝的？', answer: '', status: 'done' },
    },
  ];
}

function localBoard(id: string, nodes: any[], extra: Partial<StoredBoard> = {}): StoredBoard {
  const board: StoredBoard = {
    id,
    name: id,
    updatedAt: 1000,
    nodes,
    edges: [],
    ...extra,
  };
  store.set(`deepdive_board_${id}`, JSON.stringify(board));
  return board;
}

/** 绑到 USER scope，并把 LEGACY 条目放进绘制缓存（= 存量用户本地的样子） */
function seedScope(): void {
  boardScope.writeScopedIndex(
    [{ id: LEGACY, name: '未命名思维画布', updatedAt: 1000, nodeCount: 1 }],
    USER
  );
  boardStore.bindScope(USER);
}

/** 只注入 probe / generateId；load/save 走 storage 真实路径 */
function deps(access: 'ok' | 'denied' | 'unknown', ids: string[] = ['new-board-1']) {
  const probes: string[] = [];
  let i = 0;
  return {
    probes,
    generateId: () => ids[i++] ?? `new-board-${i}`,
    probe: async (id: string) => {
      probes.push(id);
      return access;
    },
  };
}

describe('阶段 5b 旧共享默认板存量再落位', () => {
  beforeEach(() => {
    store.clear();
    boardStore.resetForTest();
    syncQueue.resetForTest();
  });

  test('游客：不探测也不搬（没有服务端账号可判定）', async () => {
    const d = deps('denied');
    const r = await rehomeLegacyDefaultBoard('guest', d);
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'guest');
    assert.equal(d.probes.length, 0, '游客不该发探测请求');
  });

  test('服务端仍可读（legacy 共享期 / 自己就是认领者）：什么都不做，且置标记不再探测', async () => {
    seedScope();
    localBoard(LEGACY, contentNodes());
    const d = deps('ok');
    const r = await rehomeLegacyDefaultBoard(USER, d);
    assert.equal(r.reason, 'server-reachable');
    assert.deepEqual(d.probes, [LEGACY]);
    assert.ok(boardScope.isDefaultBoardMigrated(USER), '可读也算问过了，别每次启动都探');
    assert.ok(boardStore.getBoardList().some((b) => b.id === LEGACY), '共享板不能被摘掉');
    assert.ok(store.has(`deepdive_board_${LEGACY}`), '共享板的本地缓存要保留');

    const again = deps('denied');
    const r2 = await rehomeLegacyDefaultBoard(USER, again);
    assert.equal(r2.reason, 'already-migrated');
    assert.equal(again.probes.length, 0);
  });

  test('明确拒绝 + 本地有内容：内容整份落成新板，旧条目与旧 blob 摘除', async () => {
    seedScope();
    localBoard(LEGACY, contentNodes(), { serverUpdatedAt: '2026-09-01T00:00:00.000Z' });
    const d = deps('denied', ['fresh-1']);
    const r = await rehomeLegacyDefaultBoard(USER, d);

    assert.equal(r.status, 'migrated');
    assert.equal(r.newBoardId, 'fresh-1');
    const moved = JSON.parse(store.get('deepdive_board_fresh-1')!);
    assert.equal(moved.id, 'fresh-1');
    assert.deepEqual(moved.nodes, contentNodes(), '用户内容一个节点都不能少');
    assert.equal(moved.serverUpdatedAt, undefined, '旧板（共享行）的版本号不能带给新板');

    const list = boardStore.getBoardList();
    assert.ok(list.some((b) => b.id === 'fresh-1'), '新板要在列表里（待上传）');
    assert.ok(!list.some((b) => b.id === LEGACY), '旧条目要摘掉，免得列表里挂着一条读不到的板');
    assert.equal(store.has(`deepdive_board_${LEGACY}`), false, '旧 blob 已搬走，不留重复副本');
    assert.equal(store.has(`deepdive_board_server_ts_${LEGACY}`), false, '旧版本小键一并清理');
    assert.ok(boardScope.isDefaultBoardMigrated(USER));
  });

  test('明确拒绝但本地只剩引导态：内容没得搬，只摘掉旧引用（调用方给新画布）', async () => {
    seedScope();
    localBoard(LEGACY, starterNodes());
    const d = deps('denied');
    const r = await rehomeLegacyDefaultBoard(USER, d);
    assert.equal(r.status, 'dropped');
    assert.equal(r.newBoardId, undefined);
    assert.ok(boardScope.isDefaultBoardMigrated(USER));
    assert.equal(store.has('deepdive_board_new-board-1'), false, '不该凭空造一块空板');
    assert.ok(!boardStore.getBoardList().some((b) => b.id === LEGACY), '旧引用要摘掉');
  });

  test('本账号列表里没有它：不搬本地 blob（可能只是同浏览器上一个账号的缓存）', async () => {
    // 只有 blob、没有本 scope 的列表条目：内容不属于本账号，不得搬走
    localBoard(LEGACY, contentNodes());
    boardStore.bindScope(USER);
    const r = await rehomeLegacyDefaultBoard(USER, deps('denied'));
    assert.equal(r.reason, 'not-listed');
    assert.equal(store.has(`deepdive_board_${LEGACY}`), true, '不属于本账号的缓存不动它');
    assert.equal(store.has('deepdive_board_new-board-1'), false);
    assert.ok(boardScope.isDefaultBoardMigrated(USER));
  });

  test('探测不出来（离线/5xx/401）：不搬且**不打标记**，下次启动重试', async () => {
    seedScope();
    localBoard(LEGACY, contentNodes());
    const first = await rehomeLegacyDefaultBoard(USER, deps('unknown'));
    assert.equal(first.reason, 'unknown-access');
    assert.equal(boardScope.isDefaultBoardMigrated(USER), false, '没问出来就不是结论，不能标记');

    const second = deps('denied', ['fresh-2']);
    const r = await rehomeLegacyDefaultBoard(USER, second);
    assert.equal(r.status, 'migrated');
    assert.equal(r.newBoardId, 'fresh-2');
  });

  test('并发调用共享同一次搬迁（StrictMode 双跑不会搬出两块板）', async () => {
    seedScope();
    localBoard(LEGACY, contentNodes());
    const d = deps('denied', ['fresh-3']);
    const [a, b] = await Promise.all([
      rehomeLegacyDefaultBoard(USER, d),
      rehomeLegacyDefaultBoard(USER, d),
    ]);
    assert.equal(a, b, '同一账号并发应拿到同一个 Promise 的结果');
    assert.deepEqual(d.probes, [LEGACY], '只探测一次');
    assert.equal(a.newBoardId, 'fresh-3');
    assert.equal(
      boardStore.getBoardList().filter((x) => x.id.startsWith('fresh')).length,
      1
    );
  });

  test('复制没落地（配额/隐私模式）：源内容一字不动，也不打标记', async () => {
    seedScope();
    localBoard(LEGACY, contentNodes());
    const r = await rehomeLegacyDefaultBoard(USER, {
      probe: async () => 'denied',
      generateId: () => 'fresh-4',
      save: () => {}, // 模拟写失败：storage.saveBoard 内部吞掉配额异常，只上报
    });
    assert.equal(r.reason, 'copy-failed');
    assert.equal(boardScope.isDefaultBoardMigrated(USER), false);
    assert.ok(store.has(`deepdive_board_${LEGACY}`), '源内容必须保留');
    assert.ok(boardStore.getBoardList().some((b) => b.id === LEGACY));
    assert.ok(!boardStore.getBoardList().some((b) => b.id === 'fresh-4'), '半截条目要收干净');
  });

  test('hasUserContent：引导态不算内容，有提问/有第二个节点/记事文本才算', () => {
    assert.equal(hasUserContent(null), false);
    assert.equal(hasUserContent({ nodes: [], edges: [] } as any), false);
    assert.equal(hasUserContent({ nodes: starterNodes(), edges: [] } as any), false);
    assert.equal(
      hasUserContent({
        nodes: [{ data: { title: '新探索主题', question: '  ' } }],
        edges: [],
      } as any),
      false,
      '空白字符不算内容'
    );
    assert.equal(
      hasUserContent({ nodes: [{ data: { question: '为什么' } }], edges: [] } as any),
      true
    );
    assert.equal(hasUserContent({ nodes: contentNodes(), edges: [] } as any), true);
    assert.equal(
      hasUserContent({
        nodes: [{ data: { messages: [{ content: '模型回复' }] } }],
        edges: [],
      } as any),
      true
    );
    assert.equal(
      hasUserContent({ nodes: [{ data: { text: '一段记事' } }], edges: [] } as any),
      true
    );
  });

  test('probeBoardAccess 默认探针：只有 404/403 算「明确拒绝」，401/5xx 一律不下结论', async () => {
    const real = globalThis.fetch;
    const withStatus = (status: number) => {
      (globalThis as any).fetch = async () => ({ ok: status >= 200 && status < 300, status });
    };
    try {
      withStatus(200);
      assert.equal(await probeBoardAccess(LEGACY), 'ok');
      withStatus(404);
      assert.equal(await probeBoardAccess(LEGACY), 'denied');
      withStatus(403);
      assert.equal(await probeBoardAccess(LEGACY), 'denied');
      withStatus(401);
      assert.equal(await probeBoardAccess(LEGACY), 'unknown', '会话失效不是「这行不属于我」');
      withStatus(500);
      assert.equal(await probeBoardAccess(LEGACY), 'unknown');
      (globalThis as any).fetch = async () => {
        throw new Error('offline');
      };
      assert.equal(await probeBoardAccess(LEGACY), 'unknown');
    } finally {
      (globalThis as any).fetch = real;
    }
  });
});
