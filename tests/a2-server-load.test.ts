/**
 * Spec A2 — 画布载入走服务端（stub localStorage/fetch）
 *
 * 2026-09-18（ADR-0025）：载入**一律以服务端为准**——GET 取到就覆盖本地内容（含本机未上传的
 * 改动，这是明确接受的代价）、把差分基线重置成服务端状态并清未同步标记；404 与网络失败才
 * 保留本地（服务端没有版本/拿不到版本，无从「胜出」）。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- window / localStorage 最小 stub（须在 import storage 前就位；ESM import 提升，用动态 import 解决） ----
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

let fetchResponse: { status: number; body: any } | null = null;
let fetchError: Error | null = null;
(globalThis as any).fetch = async () => {
  if (fetchError) throw fetchError;
  return {
    ok: (fetchResponse?.status ?? 500) < 400,
    status: fetchResponse?.status ?? 500,
    json: async () => fetchResponse?.body,
  } as any;
};

const { fetchBoardFromServer, fetchBoardListFromServer, loadBoard, loadBoardList } = await import(
  '../src/lib/storage.ts'
);
const boardStore = await import('../src/lib/board-store.js');
const boardOps = await import('../src/lib/board-ops.ts');

const BOARD_ID = 'srv-board-1';
const SERVER_CANVAS = {
  id: BOARD_ID,
  user_id: 'u1',
  title: '服务端画板',
  description: '',
  viewport: { x: 1, y: 2, zoom: 1.5 },
  defaultModel: 'gemini-3.8-flash',
  createdAt: '2026-09-06T08:00:00.000Z',
  updatedAt: '2026-09-06T09:30:00.000Z',
  nodes: [
    {
      id: 'n1', type: 'chat', position: { x: 0, y: 0 },
      data: { title: 'T', question: 'Q', answer: 'A', messages: [{ role: 'user', content: 'hi' }], isCollapsed: true, color: 'amber' },
    },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n1' }],
  nodeCount: 1,
  edgeCount: 1,
};

/** 造出「本机有内容 + 有未上传改动」的本地状态（blob + 差分基线 + dirty 提示） */
function seedLocalUnsynced(): void {
  store.set(
    `deepdive_board_${BOARD_ID}`,
    JSON.stringify({
      id: BOARD_ID,
      name: '本机未上传的版本',
      updatedAt: 1,
      nodes: [{ id: 'n-local', type: 'chat', position: { x: 0, y: 0 }, data: { question: '本机未上传' } }],
      edges: [],
    })
  );
  boardOps.writeBase(BOARD_ID, { nodes: { 'n-local': 'stale-hash' }, edges: {} });
  boardStore.bindScope('u1');
  boardStore.upsertLocal(
    { id: BOARD_ID, name: '本机未上传的版本', updatedAt: 1, nodeCount: 1 },
    { dirty: true }
  );
}

describe('A2 画布载入走服务端', () => {
  beforeEach(() => {
    store.clear();
    fetchResponse = null;
    fetchError = null;
    boardStore.resetForTest();
  });
  afterEach(() => {});

  test('服务端 200 → 映射正确 + 本地缓存含 serverUpdatedAt + 索引更新', async () => {
    fetchResponse = { status: 200, body: SERVER_CANVAS };

    const board = await fetchBoardFromServer(BOARD_ID);

    assert.ok(board);
    assert.equal(board!.id, BOARD_ID);
    assert.equal(board!.name, '服务端画板');
    assert.equal(board!.serverUpdatedAt, '2026-09-06T09:30:00.000Z');
    assert.equal(board!.nodes.length, 1);
    assert.equal(board!.nodes[0].data.isCollapsed, true);
    assert.equal(board!.edges.length, 1);

    // 本地缓存（服务端为真源）
    const cached = loadBoard(BOARD_ID);
    assert.ok(cached);
    assert.equal(cached!.serverUpdatedAt, '2026-09-06T09:30:00.000Z');
    assert.equal((cached!.nodes[0].data as any).messages.length, 1);

    // 索引被更新
    const list = loadBoardList();
    assert.ok(list.some((b: any) => b.id === BOARD_ID && b.nodeCount === 1));
  });

  test('本机有未上传改动 → 仍以服务端为准覆盖，且基线重置、未同步标记清除', async () => {
    seedLocalUnsynced();
    fetchResponse = { status: 200, body: SERVER_CANVAS };

    const board = await fetchBoardFromServer(BOARD_ID);
    assert.ok(board);

    // 本地 blob 被服务端内容覆盖（本机未上传内容按设计丢弃）
    const cached = loadBoard(BOARD_ID)!;
    assert.deepEqual(cached.nodes.map((n) => n.id), ['n1']);
    assert.equal(cached.name, '服务端画板');

    // 基线重置成服务端那份；本机旧节点不得留在基线里（否则下次保存会把它当本地删除）
    const base = boardOps.readBase(BOARD_ID)!;
    assert.ok(base.nodes['n1'], '基线必须等于刚采用的服务端内容');
    assert.ok(!base.nodes['n-local'], '本机未上传的节点不得留在基线里');
    assert.ok(
      boardOps.isEmptyOps(
        boardOps.computeOps(base, cached as any)
      ),
      '基线若不对齐，刚采用的云端内容会在下次保存时被整批当成自己的改动重推'
    );

    // 未同步标记清除
    assert.equal(boardStore.isDirty(BOARD_ID), false, '采用服务端内容后不再是未同步状态');
  });

  test('404（从未同步）→ null，且本地草稿原样保留', async () => {
    store.set(
      'deepdive_board_never-synced',
      JSON.stringify({ id: 'never-synced', name: '本机草稿', updatedAt: 1, nodes: [], edges: [] })
    );
    fetchResponse = { status: 404, body: { error: 'not found' } };

    const board = await fetchBoardFromServer('never-synced');

    assert.equal(board, null);
    assert.ok(loadBoard('never-synced'), '服务端没有这一行 → 本机就是唯一副本，不得被清掉');
  });

  test('网络异常 → null，本地内容原样保留', async () => {
    seedLocalUnsynced();
    fetchError = new Error('network down');

    const board = await fetchBoardFromServer(BOARD_ID);

    assert.equal(board, null);
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes.map((n) => n.id), ['n-local'], '拿不到服务端内容就无从采用');
  });

  test('fetchBoardListFromServer 200 → DeepDiveBoardMeta[] 映射', async () => {
    fetchResponse = {
      status: 200,
      body: [
        { id: 's1', title: '画板一', updatedAt: '2026-09-06T08:00:00.000Z', nodeCount: 3, edgeCount: 2 },
        { id: 's2', title: '画板二', updatedAt: '2026-09-06T07:00:00.000Z', nodeCount: 0, edgeCount: 0 },
      ],
    };

    const list = await fetchBoardListFromServer();

    assert.ok(list);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 's1');
    assert.equal(list[0].name, '画板一');
    assert.equal(list[0].nodeCount, 3);
  });

  test('fetchBoardListFromServer 失败 → null', async () => {
    fetchError = new Error('offline');
    assert.equal(await fetchBoardListFromServer(), null);
  });
});
