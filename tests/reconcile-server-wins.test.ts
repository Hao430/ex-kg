/**
 * ADR-0025 — 载入以服务端为准（stub localStorage/fetch，模式同 a2/a6）
 *
 * 覆盖：
 * - 载入采用服务端内容后**不产生任何冲突副本**、不发保存请求
 * - 采用前的在途保存回包被作废（contentEpoch）：不得把刚重置的基线打回旧值
 * - 空差分保存不发请求并收敛未同步标记（打开/选中画板不该永远「未同步」）
 */
import { test, describe, beforeEach } from 'node:test';
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
    type: string;
    detail: any;
    constructor(type: string, opts?: { detail?: any }) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
}

interface MockRes {
  status: number;
  body?: any;
  networkError?: boolean;
}
interface FetchCall {
  url: string;
  method: string;
  body: any;
}

let fetchCalls: FetchCall[] = [];
let getScripts = new Map<string, MockRes[]>();
/** POST 挂起门：非 null 时 POST 会等它 resolve（用于模拟「保存发出后、回包到达前」） */
let postGate: Promise<void> | null = null;
let releasePost: (() => void) | null = null;

function responseLike(status: number, body: any) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as any;
}

(globalThis as any).fetch = async (url: string, init?: any) => {
  const method = String(init?.method || 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  fetchCalls.push({ url: String(url), method, body });
  const m = /^\/api\/canvases\/([^/?]+)(\/save)?$/.exec(String(url));
  const boardId = m ? decodeURIComponent(m[1]) : '';

  if (method === 'POST') {
    if (postGate) await postGate; // 挂起直到测试放行
    return responseLike(200, { canvas: { updatedAt: '2026-09-06T08:00:00.000Z' } });
  }
  const q = getScripts.get(boardId);
  const script = q && q.length > 0 ? q.shift()! : { status: 404 };
  if (script.networkError) throw new Error('network down');
  return responseLike(script.status, script.body);
};

const { syncBoardToBackend, fetchBoardFromServer, loadBoard, loadBoardList } = await import(
  '../src/lib/storage.ts'
);
const { resetForTest, setBackoffBaseForTest } = await import('../src/lib/sync-queue.ts');
const boardStore = await import('../src/lib/board-store.js');
const boardOps = await import('../src/lib/board-ops.ts');

const BOARD_ID = 'srv-wins-board';
const SMALL_KEY = `deepdive_board_server_ts_${BOARD_ID}`;
const BLOB_KEY = `deepdive_board_${BOARD_ID}`;
const LOCAL_BASE = '2026-09-06T09:00:00.000Z';
const SERVER_AHEAD = '2026-09-06T10:00:00.000Z';

const LOCAL_NODE = { id: 'n-local', type: 'chat', position: { x: 0, y: 0 }, data: { question: '本机未上传' } };
const SERVER_NODE = { id: 'n-server', type: 'chat', position: { x: 10, y: 0 }, data: { question: '他端写入' } };
const BOARD_NAME = '服务端画板';

const serverBoardPayload = (updatedAt: string, nodes: any[] = []) => ({
  id: BOARD_ID,
  title: BOARD_NAME,
  updatedAt,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  edges: [],
});

/** 本机有内容且标了未同步（blob + 差分基线 + board-store dirty 提示） */
function seedLocalUnsynced(): void {
  store.set(
    BLOB_KEY,
    JSON.stringify({ id: BOARD_ID, name: '本机版', updatedAt: 1, nodes: [LOCAL_NODE], edges: [] })
  );
  store.set(SMALL_KEY, LOCAL_BASE);
  boardOps.writeBase(BOARD_ID, { nodes: { 'n-local': 'stale-hash' }, edges: {} });
  boardStore.bindScope('u1');
  boardStore.upsertLocal({ id: BOARD_ID, name: '本机版', updatedAt: 1, nodeCount: 1 }, { dirty: true });
}

describe('ADR-0025 载入以服务端为准', () => {
  beforeEach(() => {
    store.clear();
    fetchCalls = [];
    getScripts = new Map();
    postGate = null;
    releasePost = null;
    resetForTest();
    setBackoffBaseForTest(10000); // 定时器不触发，重试全部手动驱动
    boardStore.resetForTest();
  });

  test('本机有未上传改动 → 载入覆盖为服务端内容，不发保存、不产生任何副本', async () => {
    seedLocalUnsynced();
    getScripts.set(BOARD_ID, [{ status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) }]);

    const loaded = await fetchBoardFromServer(BOARD_ID);
    assert.ok(loaded);

    assert.deepEqual(loadBoard(BOARD_ID)?.nodes.map((n) => n.id), ['n-server']);
    assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, 0, '载入不该触发保存');
    assert.equal(loadBoardList().length, 1, '不得凭空多出一块画板');
    assert.equal(
      loadBoardList().filter((b) => b.name.includes('冲突副本')).length,
      0,
      '冲突副本机制已删除（ADR-0025）'
    );
  });

  test('在途保存回包在载入之后到达 → 被作废，不得把基线打回旧值', async () => {
    seedLocalUnsynced();
    getScripts.set(BOARD_ID, [{ status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) }]);

    // 让这次保存的 POST 挂在半空
    postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const inFlight = syncBoardToBackend(loadBoard(BOARD_ID) as any);
    await new Promise((r) => setTimeout(r, 0)); // 让 POST 真正发出
    assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, 1);

    // 期间发生载入采用（会重置基线并作废在途保存）
    const loaded = await fetchBoardFromServer(BOARD_ID);
    assert.ok(loaded);

    releasePost!();
    assert.equal(await inFlight, 'ok', '被作废的保存仍算已处理，不该反复重试');

    const base = boardOps.readBase(BOARD_ID)!;
    assert.ok(base.nodes['n-server'], '基线必须仍是载入采用的服务端状态');
    assert.ok(!base.nodes['n-local'], '在途保存不得把旧快照推进成基线');
    assert.equal(store.get(SMALL_KEY), SERVER_AHEAD, '版本小键必须仍是载入采用的那份');
  });

  test('空差分保存（打开/选中画板）→ 不发请求并清掉未同步标记', async () => {
    const nodes = [LOCAL_NODE];
    store.set(
      BLOB_KEY,
      JSON.stringify({ id: BOARD_ID, name: BOARD_NAME, updatedAt: 1, nodes, edges: [] })
    );
    store.set(SMALL_KEY, LOCAL_BASE);
    // 基线 = 当前内容（模拟「打开画板，React Flow 只发了量测/选中变化」）
    boardOps.writeBase(
      BOARD_ID,
      boardOps.baseFromSnapshot({ nodes, edges: [], name: BOARD_NAME }, '')
    );
    boardStore.bindScope('u1');
    boardStore.upsertLocal({ id: BOARD_ID, name: BOARD_NAME, updatedAt: 1, nodeCount: 1 }, { dirty: true });
    assert.equal(boardStore.isDirty(BOARD_ID), true, '前置：本地被标了未同步');

    const outcome = await syncBoardToBackend(loadBoard(BOARD_ID) as any);

    assert.equal(outcome, 'ok');
    assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, 0, '没有真实改动就不该发请求');
    assert.equal(boardStore.isDirty(BOARD_ID), false, '与基线一致即不是未同步，标记必须收敛');
  });

  test('载入 404（服务端无此行）→ 本机草稿原样保留，基线不动', async () => {
    seedLocalUnsynced();
    getScripts.set(BOARD_ID, [{ status: 404, body: { error: 'not found' } }]);

    const loaded = await fetchBoardFromServer(BOARD_ID);

    assert.equal(loaded, null);
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes.map((n) => n.id), ['n-local']);
    assert.ok(boardOps.readBase(BOARD_ID)?.nodes['n-local'], '基线不得被清/被重置');
  });
});
