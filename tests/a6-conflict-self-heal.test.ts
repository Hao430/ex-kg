/**
 * Spec A6 — 画布保存版本冲突收敛（stub localStorage/fetch，模式同 a2）
 *
 * 2026-09-11 语义反转：409 **不再「本地版胜出」**。
 * 旧行为是拿响应的 latest_updated_at 写回版本号、再用同一份本地内容重发——版本号一刷新
 * 服务端就收下，本地版照样覆盖云端。叠加服务端的整板替换，结果就是「最后同步的设备赢」
 * 而不是「最后编辑的赢」：挂机两小时的设备随手改一个字，就能抹掉另一台设备这期间的改动。
 *
 * 新行为：服务端为准。
 * - 本地未同步版另存为一块「(冲突副本)」画板（用户的改动不丢）
 * - 原画板采用服务端当前内容、基线对齐（不再尝试用本地内容覆盖）
 * - 同一轮冲突复用同一块副本；保存成功后清空复用表，下一次冲突才另起一块
 *
 * 覆盖：
 * - 409 → 另存副本 + 采用服务端版，仅 1 次 save（不再重发）、1 次取服务端内容
 * - 取服务端内容失败 → fail，本地内容与脏状态原样保留（未采用就不建副本，避免制造重复）
 * - keepalive（页面卸载补传）不做冲突决策：不建副本、不发额外 GET
 * - adoptServerVersion 区分「本地领先（等上传）」与「真冲突（采用服务端版）」
 * - fetchBoardFromServer 成功同步小键 / persistBoard 兜底注入（行为不变）
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
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

interface MockRes {
  status: number;
  body?: any;
  jsonThrow?: boolean;
  networkError?: boolean;
}
interface FetchCall {
  url: string;
  method: string;
  body: any;
}

let fetchCalls: FetchCall[] = [];
/**
 * 按「方法 + 画板 id」分流出队：冲突副本的后台上传会并发跑，用单一队列会吃掉
 * 主流程脚本，断言随之失真。未脚本化的请求给一个安全默认值。
 */
let saveScripts = new Map<string, MockRes[]>();
let getScripts = new Map<string, MockRes[]>();

const DEFAULT_SAVE: MockRes = { status: 200, body: { canvas: { updatedAt: '2026-09-06T12:00:00.000Z' } } };

function scriptSave(boardId: string, res: MockRes[]): void {
  saveScripts.set(boardId, [...res]);
}
function scriptGet(boardId: string, res: MockRes[]): void {
  getScripts.set(boardId, [...res]);
}

(globalThis as any).fetch = async (url: string, init?: any) => {
  const method = String(init?.method || 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  fetchCalls.push({ url: String(url), method, body });

  const m = /^\/api\/canvases\/([^/?]+)(\/save)?$/.exec(String(url));
  const boardId = m ? decodeURIComponent(m[1]) : '';
  const queue = method === 'POST' ? saveScripts.get(boardId) : getScripts.get(boardId);
  const script = queue && queue.length > 0 ? queue.shift()! : DEFAULT_SAVE;
  if (script.networkError) throw new Error('network down');
  return {
    ok: script.status < 400,
    status: script.status,
    json: async () => {
      if (script.jsonThrow) throw new Error('parse-failed');
      return script.body;
    },
  } as any;
};

const { syncBoardToBackend, fetchBoardFromServer, saveBoard, loadBoard, loadBoardList, adoptServerVersion } =
  await import('../src/lib/storage.ts');
const { flush, resetForTest, setBackoffBaseForTest } = await import('../src/lib/sync-queue.ts');
const boardStore = await import('../src/lib/board-store.js');

const BOARD_ID = 'conflict-board-1';
const SMALL_KEY = `deepdive_board_server_ts_${BOARD_ID}`;
const BLOB_KEY = `deepdive_board_${BOARD_ID}`;
/** 本地记录的基线（也是发起保存时的 expectedUpdatedAt） */
const LOCAL_BASE = '2026-09-06T09:00:00.000Z';
/** 他端写入后服务端的版本 */
const SERVER_AHEAD = '2026-09-06T10:00:00.000Z';

const LOCAL_NODE = {
  id: 'n-local',
  type: 'chat',
  position: { x: 0, y: 0 },
  data: { question: '本地未同步的问题' },
};
const SERVER_NODE = {
  id: 'n-server',
  type: 'chat',
  position: { x: 10, y: 0 },
  data: { question: '他端写入的问题' },
};
const CONFLICT_SUFFIX = ' (冲突副本)';

const makeBoard = (serverUpdatedAt?: string, nodes: any[] = []) => ({
  id: BOARD_ID,
  name: '冲突画板',
  updatedAt: Date.now(),
  nodes,
  edges: [],
  ...(serverUpdatedAt ? { serverUpdatedAt } : {}),
});

const serverBoardPayload = (updatedAt: string, nodes: any[] = [], id = BOARD_ID) => ({
  id,
  title: '冲突画板',
  updatedAt,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  edges: [],
});

/** 造出「本地有未同步改动」的状态：blob 内嵌基线 + 权威小键 + board-store 标记 dirty */
function seedDirtyLocal(base: string, nodes: any[] = []): void {
  store.set(BLOB_KEY, JSON.stringify(makeBoard(base, nodes)));
  store.set(SMALL_KEY, base);
  boardStore.bindScope('u1');
  boardStore.upsertLocal(
    { id: BOARD_ID, name: '冲突画板', updatedAt: Date.now(), nodeCount: nodes.length },
    { dirty: true }
  );
}

const conflictCopies = () => loadBoardList().filter((b) => b.name.endsWith(CONFLICT_SUFFIX));
const savesFor = (id: string) =>
  fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${id}/save`));

describe('A6 版本冲突收敛（服务端为准）', () => {
  beforeEach(() => {
    store.clear();
    dispatchedEvents.length = 0;
    fetchCalls = [];
    saveScripts = new Map();
    getScripts = new Map();
    resetForTest();
    // 退避基准放大：测试期间定时器不触发，重试全部手动 flush 驱动，保证确定性
    setBackoffBaseForTest(10000);
    boardStore.resetForTest();
  });
  afterEach(() => {
    resetForTest();
    setBackoffBaseForTest(2000);
  });

  test('409 → 本地版另存「(冲突副本)」、原画板采用服务端内容，仅 1 次 save', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 409, body: { error: '画板已被其他窗口修改', latest_updated_at: SERVER_AHEAD } },
    ]);
    scriptGet(BOARD_ID, [{ status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'conflict');
    // 旧行为是刷新版本号后原样重发（本地版胜出）；现在一次都不重发
    assert.equal(savesFor(BOARD_ID).length, 1, '409 后不得再重发本地内容');
    assert.equal(
      fetchCalls.filter((c) => c.method === 'GET').length,
      1,
      '应采用服务端内容（一次 GET），而不是把本地内容再推上去'
    );

    // 副本：内容 = 本地未同步版
    const copies = conflictCopies();
    assert.equal(copies.length, 1, '本地未同步版必须另存副本，不得随采用服务端版一起消失');
    const copyId = copies[0].id;
    assert.deepEqual(loadBoard(copyId)?.nodes, [LOCAL_NODE]);

    // 原画板：内容 = 服务端版，基线对齐
    const original = loadBoard(BOARD_ID);
    assert.deepEqual(original?.nodes, [SERVER_NODE]);
    assert.equal(original?.serverUpdatedAt, SERVER_AHEAD);
    assert.equal(store.get(SMALL_KEY), SERVER_AHEAD);
    assert.equal(boardStore.isDirty(BOARD_ID), false, '采用服务端版后不再是未同步状态');

    // 事件带副本 id：App 据此提示用户并刷新当前画板画面
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'deepdive:canvas-save-conflict');
    assert.equal(dispatchedEvents[0].detail.conflictCopyId, copyId);

    // 副本已入队并会被上传（flush 手动驱动，避免依赖 0ms 定时器）
    await flush();
    assert.ok(savesFor(copyId).length >= 1, '副本必须入队上传，否则改动只活在本地');
  });

  test('同一轮冲突复用同一块副本，不重复堆积', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 409, body: { latest_updated_at: SERVER_AHEAD } },
      { status: 409, body: { latest_updated_at: SERVER_AHEAD } },
    ]);
    scriptGet(BOARD_ID, [
      { status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) },
      { status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) },
    ]);

    await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);
    // 模拟上一轮没收敛干净（例如取服务端内容时断网）：本地仍是脏的旧内容
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(conflictCopies().length, 1, '未了结的冲突必须复用副本，不得每次重试都新建一块画板');
  });

  test('保存成功后清空复用表：下一次冲突另起一块副本', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 409, body: { latest_updated_at: SERVER_AHEAD } },
      { status: 200, body: { canvas: { updatedAt: '2026-09-06T11:00:00.000Z' } } },
      { status: 409, body: { latest_updated_at: '2026-09-06T11:30:00.000Z' } },
    ]);
    scriptGet(BOARD_ID, [
      { status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) },
      { status: 200, body: serverBoardPayload('2026-09-06T11:30:00.000Z', [SERVER_NODE]) },
    ]);

    await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any); // 冲突 #1
    assert.equal(conflictCopies().length, 1);

    // 中间一次正常保存 → 本轮冲突了结
    seedDirtyLocal(SERVER_AHEAD, [SERVER_NODE]);
    const ok = await syncBoardToBackend(makeBoard(SERVER_AHEAD, [SERVER_NODE]) as any);
    assert.equal(ok, 'ok');

    seedDirtyLocal('2026-09-06T11:00:00.000Z', [LOCAL_NODE]);
    await syncBoardToBackend(makeBoard('2026-09-06T11:00:00.000Z', [LOCAL_NODE]) as any); // 冲突 #2

    assert.equal(conflictCopies().length, 2, '了结后的新冲突应另起副本，别把两次冲突的改动混在一块里');
  });

  test('取服务端内容失败 → fail，本地内容与脏状态原样保留（未采用就不建副本）', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [{ status: 409, body: { latest_updated_at: SERVER_AHEAD } }]);
    scriptGet(BOARD_ID, [{ status: 0, networkError: true }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'fail', '取不到服务端内容应交退避重试，而不是当成已收敛');
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes, [LOCAL_NODE], '本地内容不得被清掉');
    assert.equal(boardStore.isDirty(BOARD_ID), true, '仍为未同步状态，等退避重试');
    assert.equal(
      conflictCopies().length,
      0,
      '没采用服务端版就不该建副本——本地内容还在原画板里，复制一份只会制造重复'
    );
  });

  test('409 缺 latest_updated_at 不影响收敛（仍另存副本 + 采用服务端版）', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [{ status: 409, body: { error: '画板已被其他窗口修改' } }]);
    scriptGet(BOARD_ID, [{ status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);
    assert.equal(outcome, 'conflict');
    assert.equal(dispatchedEvents[0].detail.latestUpdatedAt, undefined);
    assert.ok(dispatchedEvents[0].detail.conflictCopyId, '收敛与 latest 是否回传无关');
  });

  test('keepalive 补传遇 409：不做冲突决策，不建副本、不发额外 GET', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [{ status: 409, body: { latest_updated_at: SERVER_AHEAD } }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any, {
      keepalive: true,
    });

    assert.equal(outcome, 'fail');
    assert.equal(fetchCalls.filter((c) => c.method === 'GET').length, 0, '页面正在消失，不该再发 GET');
    assert.equal(conflictCopies().length, 0);
    assert.equal(dispatchedEvents.length, 0);
  });

  test('adoptServerVersion：服务端基线未变（本地领先）→ 保留本地等上传', () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);

    const result = adoptServerVersion({
      ...makeBoard(LOCAL_BASE, []),
      nodes: [SERVER_NODE],
      serverUpdatedAt: LOCAL_BASE,
    } as any);

    assert.equal(result.adopt, false, '基线一致说明期间无人写入，本地只是还没传上去');
    assert.equal(result.conflictCopyId, undefined);
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes, [LOCAL_NODE], '本地未同步改动不得被服务端内容覆盖');
    assert.equal(conflictCopies().length, 0);
  });

  test('adoptServerVersion：无未同步改动 → 直接采用，不建副本', () => {
    store.set(BLOB_KEY, JSON.stringify(makeBoard(LOCAL_BASE)));
    boardStore.bindScope('u1');
    // upsertLocal 默认标脏，这里显式 dirty:false 才是「无未同步改动」
    boardStore.upsertLocal(
      { id: BOARD_ID, name: '冲突画板', updatedAt: Date.now(), nodeCount: 0 },
      { dirty: false }
    );

    const result = adoptServerVersion({
      ...makeBoard(SERVER_AHEAD, [SERVER_NODE]),
      serverUpdatedAt: SERVER_AHEAD,
    } as any);

    assert.equal(result.adopt, true);
    assert.equal(result.conflictCopyId, undefined);
    assert.equal(conflictCopies().length, 0);
  });

  test('adoptServerVersion：真冲突 → 采用服务端版并回传副本 id（页面加载路径靠它提示用户）', () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);

    const result = adoptServerVersion({
      ...makeBoard(SERVER_AHEAD, [SERVER_NODE]),
      serverUpdatedAt: SERVER_AHEAD,
    } as any);

    assert.equal(result.adopt, true);
    // 加载/切换画板时会静默把本地改动挪进副本——必须把 id 交给上层弹提示，
    // 否则用户只会看到列表里莫名多出一块画板
    assert.ok(result.conflictCopyId, '必须回传副本 id 供上层告知用户');
    assert.deepEqual(loadBoard(result.conflictCopyId!)?.nodes, [LOCAL_NODE]);
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes, [SERVER_NODE]);
  });

  test('fetchBoardFromServer 成功 → 权威小键同步写入服务端版本', async () => {
    scriptGet('srv-board-1', [
      { status: 200, body: serverBoardPayload('2026-09-06T09:30:00.000Z', [], 'srv-board-1') },
    ]);
    const board = await fetchBoardFromServer('srv-board-1');
    assert.ok(board);
    assert.equal(board!.serverUpdatedAt, '2026-09-06T09:30:00.000Z');
    assert.equal(store.get('deepdive_board_server_ts_srv-board-1'), '2026-09-06T09:30:00.000Z');
  });

  test('persistBoard 兜底合并：不带 serverUpdatedAt 的保存从小键注入（blob 内嵌 + 请求体双断言）', async () => {
    store.set(SMALL_KEY, LOCAL_BASE);
    scriptSave(BOARD_ID, [{ status: 200, body: { canvas: { updatedAt: SERVER_AHEAD } } }]);

    saveBoard(makeBoard() as any); // 不携带 serverUpdatedAt
    await flush();

    // blob 内嵌值被注入（不再被覆写抹掉）
    const blob = JSON.parse(store.get(BLOB_KEY)!);
    assert.equal(blob.serverUpdatedAt, LOCAL_BASE);
    // 保存请求携带注入后的版本号
    const saves = savesFor(BOARD_ID);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.expectedUpdatedAt, LOCAL_BASE);
    // 保存成功后小键推进
    assert.equal(store.get(SMALL_KEY), SERVER_AHEAD);
  });

  test('新画板（无小键）→ expectedUpdatedAt 缺省直写，成功后新建小键', async () => {
    scriptSave(BOARD_ID, [{ status: 200, body: { canvas: { updatedAt: SERVER_AHEAD } } }]);

    saveBoard(makeBoard() as any);
    await flush();

    const saves = savesFor(BOARD_ID);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.expectedUpdatedAt, undefined);
    assert.equal(store.get(SMALL_KEY), SERVER_AHEAD);
    // 本地读回版本一致
    assert.equal(loadBoard(BOARD_ID)?.serverUpdatedAt, SERVER_AHEAD);
    assert.ok(loadBoardList().some((b) => b.id === BOARD_ID));
  });
});
