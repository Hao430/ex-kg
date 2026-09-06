/**
 * Spec A2 — 画布加载改走服务端（stub localStorage/fetch）
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

const SERVER_CANVAS = {
  id: 'srv-board-1',
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

describe('A2 画布加载走服务端', () => {
  beforeEach(() => {
    store.clear();
    fetchResponse = null;
    fetchError = null;
  });
  afterEach(() => {});

  test('服务端 200 → 映射正确 + 本地缓存含 serverUpdatedAt + 索引更新', async () => {
    fetchResponse = { status: 200, body: SERVER_CANVAS };

    const board = await fetchBoardFromServer('srv-board-1');

    assert.ok(board);
    assert.equal(board!.id, 'srv-board-1');
    assert.equal(board!.name, '服务端画板');
    assert.equal(board!.serverUpdatedAt, '2026-09-06T09:30:00.000Z');
    assert.equal(board!.nodes.length, 1);
    assert.equal(board!.nodes[0].data.isCollapsed, true);
    assert.equal(board!.edges.length, 1);

    // 本地缓存（服务端为真源）
    const cached = loadBoard('srv-board-1');
    assert.ok(cached);
    assert.equal(cached!.serverUpdatedAt, '2026-09-06T09:30:00.000Z');
    assert.equal((cached!.nodes[0].data as any).messages.length, 1);

    // 索引被更新
    const list = loadBoardList();
    assert.ok(list.some((b: any) => b.id === 'srv-board-1' && b.nodeCount === 1));
  });

  test('404（从未同步）→ null，且不写本地缓存', async () => {
    fetchResponse = { status: 404, body: { error: 'not found' } };

    const board = await fetchBoardFromServer('never-synced');

    assert.equal(board, null);
    assert.equal(loadBoard('never-synced'), null);
  });

  test('网络异常 → null', async () => {
    fetchError = new Error('network down');

    const board = await fetchBoardFromServer('srv-board-1');

    assert.equal(board, null);
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
