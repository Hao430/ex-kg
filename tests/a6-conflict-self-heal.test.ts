/**
 * Spec A6 — 画布保存版本冲突静默自愈（stub localStorage/fetch，模式同 a2）
 *
 * 覆盖：
 * - 409 冲突用 latest_updated_at 推进版本号原样重发本地内容（本地版胜出，用户无感知）
 * - 重试上限 MAX_CONFLICT_ATTEMPTS=3，耗尽/响应异常才降级派发 deepdive:canvas-save-conflict
 * - 409 收到合法 latest 即落权威小键 deepdive_board_server_ts_<id>（下轮队列重跑带新鲜版本）
 * - fetchBoardFromServer 成功同步小键（斩断「刷新后仍冲突」死锁）
 * - persistBoard 对未携带 serverUpdatedAt 的 board 从小键兜底注入
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- window / localStorage 最小 stub（须在 import storage 前就位；ESM import 提升，用动态 import 解决） ----
const store = new Map<string, string>();
const dispatchedEvents: Array<{ type: string; detail?: any }> = [];
(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: (evt: any) => {
    dispatchedEvents.push({ type: evt.type, detail: evt.detail });
    return true;
  },
};
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
// Node <19 无 CustomEvent，条件补桩
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

// ---- fetch 分发桩：按脚本逐次出队响应，记录全部请求 ----
interface MockRes {
  status: number;
  body?: any;
  jsonThrow?: boolean;
  networkError?: boolean;
}
let fetchCalls: Array<{ url: string; body: any }> = [];
let fetchScript: MockRes[] = [];
(globalThis as any).fetch = async (_url: string, init?: any) => {
  const script = fetchScript.shift() ?? { status: 500 };
  if (script.networkError) throw new Error('network down');
  const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  fetchCalls.push({ url: _url, body: rawBody });
  return {
    ok: script.status < 400,
    status: script.status,
    json: async () => {
      if (script.jsonThrow) throw new Error('parse-failed');
      return script.body;
    },
  } as any;
};

const { syncBoardToBackend, fetchBoardFromServer, saveBoard, loadBoard, loadBoardList } =
  await import('../src/lib/storage.ts');
const { flush, resetForTest } = await import('../src/lib/sync-queue.ts');

const BOARD_ID = 'conflict-board-1';
const SMALL_KEY = `deepdive_board_server_ts_${BOARD_ID}`;
const BLOB_KEY = `deepdive_board_${BOARD_ID}`;

const makeBoard = (serverUpdatedAt?: string) => ({
  id: BOARD_ID,
  name: '冲突画板',
  updatedAt: Date.now(),
  nodes: [],
  edges: [],
  ...(serverUpdatedAt ? { serverUpdatedAt } : {}),
});

describe('A6 版本冲突静默自愈', () => {
  beforeEach(() => {
    store.clear();
    dispatchedEvents.length = 0;
    fetchCalls = [];
    fetchScript = [];
    resetForTest();
  });

  test('409 一次 + 重发成功 → 第二次请求携带 latest_updated_at，返回 ok，小键落最终版本', async () => {
    fetchScript = [
      { status: 409, body: { error: '画板已被其他窗口修改', code: 'CANVAS_SAVE_CONFLICT', latest_updated_at: '2026-09-06T10:00:00.000Z' } },
      { status: 200, body: { canvas: { updatedAt: '2026-09-06T10:00:01.000Z' } } },
    ];
    const board = makeBoard('2026-09-06T09:00:00.000Z');
    const outcome = await syncBoardToBackend(board as any);

    assert.equal(outcome, 'ok');
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].body.expectedUpdatedAt, '2026-09-06T09:00:00.000Z');
    assert.equal(fetchCalls[1].body.expectedUpdatedAt, '2026-09-06T10:00:00.000Z');
    // 内容不变（本地版胜出）
    assert.deepEqual(fetchCalls[1].body.nodes, []);
    assert.equal(store.get(SMALL_KEY), '2026-09-06T10:00:01.000Z');
    assert.equal(board.serverUpdatedAt, '2026-09-06T10:00:01.000Z');
    // 用户无感知：不派发冲突事件
    assert.equal(dispatchedEvents.length, 0);
  });

  test('连续 409 耗尽 3 次 → 派发冲突事件、返回 conflict，小键含最后一次 latest', async () => {
    fetchScript = [
      { status: 409, body: { latest_updated_at: '2026-09-06T10:00:00.000Z' } },
      { status: 409, body: { latest_updated_at: '2026-09-06T10:01:00.000Z' } },
      { status: 409, body: { latest_updated_at: '2026-09-06T10:02:00.000Z' } },
    ];
    const outcome = await syncBoardToBackend(makeBoard('2026-09-06T09:00:00.000Z') as any);

    assert.equal(outcome, 'conflict');
    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[2].body.expectedUpdatedAt, '2026-09-06T10:01:00.000Z');
    assert.equal(store.get(SMALL_KEY), '2026-09-06T10:02:00.000Z');
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'deepdive:canvas-save-conflict');
    assert.equal(dispatchedEvents[0].detail.boardId, BOARD_ID);
    assert.equal(dispatchedEvents[0].detail.latestUpdatedAt, '2026-09-06T10:02:00.000Z');
  });

  test('409 响应体解析失败 → 立即降级派发事件，仅 1 次请求', async () => {
    fetchScript = [{ status: 409, jsonThrow: true }];
    const outcome = await syncBoardToBackend(makeBoard('2026-09-06T09:00:00.000Z') as any);

    assert.equal(outcome, 'conflict');
    assert.equal(fetchCalls.length, 1);
    assert.equal(dispatchedEvents.length, 1);
    // 小键未被污染
    assert.equal(store.has(SMALL_KEY), false);
  });

  test('409 但 latest_updated_at 缺失 → 降级派发事件，不重发', async () => {
    fetchScript = [{ status: 409, body: { error: '画板已被其他窗口修改' } }];
    const outcome = await syncBoardToBackend(makeBoard('2026-09-06T09:00:00.000Z') as any);

    assert.equal(outcome, 'conflict');
    assert.equal(fetchCalls.length, 1);
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].detail.message, '画板已被其他窗口修改');
    assert.equal(store.has(SMALL_KEY), false);
  });

  test('重试第 2 轮遇 401 → 派发登录失效事件返回 conflict，不再重发', async () => {
    fetchScript = [
      { status: 409, body: { latest_updated_at: '2026-09-06T10:00:00.000Z' } },
      { status: 401 },
    ];
    const outcome = await syncBoardToBackend(makeBoard('2026-09-06T09:00:00.000Z') as any);

    assert.equal(outcome, 'conflict');
    assert.equal(fetchCalls.length, 2);
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].detail.message, '登录状态已失效，请重新登录后再保存画板');
    // 首次 409 落下的新鲜版本保留（重新登录后可直接续传）
    assert.equal(store.get(SMALL_KEY), '2026-09-06T10:00:00.000Z');
  });

  test('重试第 2 轮网络异常 → 返回 fail，小键保留首次 409 落下的版本', async () => {
    fetchScript = [
      { status: 409, body: { latest_updated_at: '2026-09-06T10:00:00.000Z' } },
      { status: 0, networkError: true } as any,
    ];
    const outcome = await syncBoardToBackend(makeBoard('2026-09-06T09:00:00.000Z') as any);

    assert.equal(outcome, 'fail');
    assert.equal(fetchCalls.length, 1);
    assert.equal(dispatchedEvents.length, 0);
    assert.equal(store.get(SMALL_KEY), '2026-09-06T10:00:00.000Z');
  });

  test('fetchBoardFromServer 成功 → 权威小键同步写入服务端版本', async () => {
    fetchScript = [
      {
        status: 200,
        body: {
          id: 'srv-board-1',
          title: '服务端画板',
          updatedAt: '2026-09-06T09:30:00.000Z',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        },
      },
    ];
    const board = await fetchBoardFromServer('srv-board-1');
    assert.ok(board);
    assert.equal(board!.serverUpdatedAt, '2026-09-06T09:30:00.000Z');
    assert.equal(store.get('deepdive_board_server_ts_srv-board-1'), '2026-09-06T09:30:00.000Z');
  });

  test('persistBoard 兜底合并：不带 serverUpdatedAt 的保存从小键注入（blob 内嵌 + 请求体双断言）', async () => {
    store.set(SMALL_KEY, '2026-09-06T09:00:00.000Z');
    fetchScript = [{ status: 200, body: { canvas: { updatedAt: '2026-09-06T10:00:00.000Z' } } }];

    saveBoard(makeBoard() as any); // 不携带 serverUpdatedAt
    await flush();

    // blob 内嵌值被注入（不再被覆写抹掉）
    const blob = JSON.parse(store.get(BLOB_KEY)!);
    assert.equal(blob.serverUpdatedAt, '2026-09-06T09:00:00.000Z');
    // 保存请求携带注入后的版本号
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].body.expectedUpdatedAt, '2026-09-06T09:00:00.000Z');
    // 保存成功后小键推进
    assert.equal(store.get(SMALL_KEY), '2026-09-06T10:00:00.000Z');
  });

  test('新画板（无小键）→ expectedUpdatedAt 缺省直写，成功后新建小键', async () => {
    fetchScript = [{ status: 200, body: { canvas: { updatedAt: '2026-09-06T10:00:00.000Z' } } }];

    saveBoard(makeBoard() as any);
    await flush();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].body.expectedUpdatedAt, undefined);
    assert.equal(store.get(SMALL_KEY), '2026-09-06T10:00:00.000Z');
    // 本地读回版本一致
    assert.equal(loadBoard(BOARD_ID)?.serverUpdatedAt, '2026-09-06T10:00:00.000Z');
    assert.ok(loadBoardList().some((b) => b.id === BOARD_ID));
  });
});
