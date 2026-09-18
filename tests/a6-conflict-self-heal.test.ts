/**
 * Spec A6 — 保存失败分流（确定性拒绝 vs 可重试）与跨板 id 自愈（stub localStorage/fetch，模式同 a2）
 *
 * 语义演进：
 * - 2026-09-11：409 不再「本地版胜出」。
 * - 2026-09-18（ADR-0025）：**冲突副本机制整条删除**，载入一律以服务端为准。409 只剩防御意义——
 *   v2 客户端走节点级合并，服务端刻意不校验画板级乐观锁（ADR-0017），正常永远到不了这里；
 *   能到这里的只有旧协议客户端/服务端配置不一致，重发不会变好，故按确定性拒绝处理。
 *
 * 覆盖：
 * - 409 → rejected：不重发、不发额外 GET、**不建任何副本**、提示用户刷新
 * - keepalive（页面卸载补传）遇 409 → fail，不做决策
 * - 400 结构性拒绝（NODE_PARENT_CYCLE）→ rejected 且告知用户；其余 400 → fail 退避
 * - 400 NODE_CANVAS_MISMATCH → 就地重映射本板 id 后重试一次（存量坏数据与跨板搬节点的唯一出路）
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
/** 按「方法 + 画板 id」分流出队：未脚本化的请求给一个安全默认值 */
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

const { syncBoardToBackend, fetchBoardFromServer, saveBoard, loadBoard, loadBoardList } =
  await import('../src/lib/storage.ts');
const { flush, resetForTest, setBackoffBaseForTest } = await import('../src/lib/sync-queue.ts');
const boardStore = await import('../src/lib/board-store.js');
const boardOps = await import('../src/lib/board-ops.ts');

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

const makeBoard = (serverUpdatedAt?: string, nodes: any[] = [], edges: any[] = []) => ({
  id: BOARD_ID,
  name: '冲突画板',
  updatedAt: Date.now(),
  nodes,
  edges,
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
function seedDirtyLocal(base: string, nodes: any[] = [], edges: any[] = []): void {
  store.set(BLOB_KEY, JSON.stringify(makeBoard(base, nodes, edges)));
  store.set(SMALL_KEY, base);
  // 有服务端版本号的画板，必然在「上次保存成功」或「上次拉取服务端版」时写过差分基线
  //（ADR-0017）。置空基线 = 板上内容全是本设备新增，正是这些用例要的「本地未同步改动」；
  // 顺带避免保存路径去补拉一次基线（那是 tests/h3-board-ops 的用例）。
  boardOps.writeBase(BOARD_ID, { nodes: {}, edges: {} });
  boardStore.bindScope('u1');
  boardStore.upsertLocal(
    { id: BOARD_ID, name: '冲突画板', updatedAt: Date.now(), nodeCount: nodes.length },
    { dirty: true }
  );
}

/** 断言：节点内容保真、id 已重映射（跨板 id 冲突时唯一的出路就是换一套标识） */
function assertRemappedNodes(actual: any[] | undefined, source: any[], label = '本板'): void {
  assert.ok(actual, `${label}必须落盘`);
  assert.equal(actual!.length, source.length, `${label}节点数量保真`);
  assert.equal(new Set(actual!.map((n) => n.id)).size, actual!.length, `${label}内节点 id 唯一`);
  const sourceIds = new Set(source.map((n) => n.id));
  for (const got of actual!) {
    assert.ok(!sourceIds.has(got.id), `${label}节点 id「${got.id}」与源画板相同，会让整次保存被拒`);
  }
  for (const [i, src] of source.entries()) {
    const got = actual![i];
    assert.deepEqual(got.position, src.position, `${label}第 ${i} 个节点位置保真`);
    assert.equal(got.type, src.type, `${label}第 ${i} 个节点类型保真`);
    // parentId 会被一并改写（留旧值等于指向源画板的节点），故单独比对，其余字段整体比对
    const { parentId: srcPid, ...srcRest } = (src.data ?? {}) as Record<string, unknown>;
    const { parentId: gotPid, ...gotRest } = (got.data ?? {}) as Record<string, unknown>;
    assert.deepEqual(gotRest, srcRest, `${label}第 ${i} 个节点除 parentId 外内容保真`);
    if (srcPid === undefined) assert.equal(gotPid, undefined, `${label}不得凭空生出 parentId`);
    else assert.ok(gotPid && gotPid !== srcPid, `${label}第 ${i} 个节点的 parentId 必须一并改写`);
  }
}
const savesFor = (id: string) =>
  fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${id}/save`));
const copyNamedBoards = () => loadBoardList().filter((b) => b.name.includes('冲突副本'));

describe('A6 保存失败分流与跨板 id 自愈', () => {
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

  test('409 → rejected：不重发、不发额外 GET、不建任何副本', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 409, body: { error: '画板已被其他窗口修改', latest_updated_at: SERVER_AHEAD } },
    ]);
    scriptGet(BOARD_ID, [{ status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    // 重发同一份内容不会变好（v2 合并路径本就不该 409），故按确定性拒绝：停止重试并告知用户
    assert.equal(outcome, 'rejected');
    assert.equal(savesFor(BOARD_ID).length, 1, '409 后不得再重发本地内容');
    assert.equal(
      fetchCalls.filter((c) => c.method === 'GET').length,
      0,
      '不再为「采用服务端版」额外发 GET——提示用户刷新即可（刷新即走载入采用路径）'
    );

    // 本地内容原样保留（没采用就什么都不该动），也不得凭空多出一块画板
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes, [LOCAL_NODE], '本地内容不得被清掉');
    assert.equal(loadBoardList().length, 1, '不得产生任何新画板');
    assert.equal(copyNamedBoards().length, 0, '冲突副本机制已删除（ADR-0025）');

    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'deepdive:canvas-save-conflict');
    assert.equal(dispatchedEvents[0].detail.code, 'CLIENT_OUTDATED');
    assert.equal(dispatchedEvents[0].detail.conflictCopyId, undefined, '事件不得再带副本 id');
  });

  test('409 缺 latest_updated_at 也按 rejected 处理（分流与回传字段无关）', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [{ status: 409, body: { error: '画板已被其他窗口修改' } }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'rejected');
    assert.equal(dispatchedEvents[0].detail.latestUpdatedAt, undefined);
    assert.equal(copyNamedBoards().length, 0);
  });

  test('keepalive 补传遇 409：不做决策，不发 GET、不建副本、不弹提示', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [{ status: 409, body: { latest_updated_at: SERVER_AHEAD } }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any, {
      keepalive: true,
    });

    assert.equal(outcome, 'fail');
    assert.equal(fetchCalls.filter((c) => c.method === 'GET').length, 0, '页面正在消失，不该再发 GET');
    assert.equal(copyNamedBoards().length, 0);
    assert.equal(dispatchedEvents.length, 0);
  });

  // 用 NODE_PARENT_CYCLE 而非 NODE_CANVAS_MISMATCH：后者现在会先走自愈重映射（见下两例），
  // 这条路径要验的是「没有自愈手段的结构性拒绝」——它必须 rejected 且告知用户。
  test('400 NODE_PARENT_CYCLE → rejected：确定性拒绝不得转成无限重试，且必须告知用户', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 400, body: { error: '节点层级关系存在循环引用，已拒绝保存', code: 'NODE_PARENT_CYCLE' } },
    ]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    // 'fail' 会被 sync-queue 一路退避到慢速自愈（每 60s 一次、永不放弃）——那正是线上事故的形态
    assert.equal(outcome, 'rejected', '结构性拒绝必须与「可能自己好起来」的失败区分开');
    assert.equal(savesFor(BOARD_ID).length, 1, '无自愈手段的码不该重试');
    assert.equal(dispatchedEvents.length, 1, '这次没存上必须让用户知道，不能静默');
    assert.equal(dispatchedEvents[0].type, 'deepdive:canvas-save-conflict');
    assert.equal(dispatchedEvents[0].detail.code, 'NODE_PARENT_CYCLE');
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes, [LOCAL_NODE], '本地改动不得被清掉，只是没能上行');
  });

  test('400 其他码 → fail：用户把内容改了可能就过了，仍走退避重试且不打扰用户', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [{ status: 400, body: { error: '字段不合法', code: 'VALIDATION_ERROR' } }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'fail');
    assert.equal(dispatchedEvents.length, 0, '可恢复的失败不该弹提示');
  });

  test('400 NODE_CANVAS_MISMATCH → 自愈：重映射本板 id 后重试一次即通过', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 400, body: { error: '节点不属于当前画板，已拒绝保存', code: 'NODE_CANVAS_MISMATCH' } },
      { status: 200, body: { canvas: { updatedAt: SERVER_AHEAD } } },
    ]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'ok', '重映射后重试应当通过——这是跨板 id 冲突与存量坏数据的唯一出路');
    const saves = savesFor(BOARD_ID);
    assert.equal(saves.length, 2, '只重试一次');

    // 第二次上行的节点 id 已换新
    const sentIds = (saves[1].body.nodes || []).map((n: any) => n.id);
    assert.equal(sentIds.length, 1);
    assert.notEqual(sentIds[0], LOCAL_NODE.id, '重试必须带新 id，否则再撞一次');

    // 本地 blob 同步改写——UI 重新播种读的就是它
    assertRemappedNodes(loadBoard(BOARD_ID)?.nodes, [LOCAL_NODE]);

    // 必须通知 UI 重新播种：内存里的画布还攥着旧 id，不重播种下次防抖保存会打回来
    const remapEvents = dispatchedEvents.filter((e) => e.type === 'deepdive:board-ids-remapped');
    assert.equal(remapEvents.length, 1);
    assert.equal(remapEvents[0].detail.boardId, BOARD_ID);
    assert.equal(
      dispatchedEvents.filter((e) => e.type === 'deepdive:canvas-save-conflict').length,
      0,
      '自愈成功不该弹冲突提示吓用户'
    );
  });

  test('自愈重映射：旧 id 作为删除上行，不在服务端留孤儿', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    // 基线里记着旧 id（这块板此前同步过）。重映射之后旧 id 在本板已不存在，
    // 差分必须把它们当成本次删除上行——合并语义是「没带 = 不动」，不显式墓碑的话
    // 服务端那几行会原地留下成为孤儿，谁也不再引用它们。
    boardOps.writeBase(BOARD_ID, { nodes: { [LOCAL_NODE.id]: 'stale-hash' }, edges: {} });
    scriptSave(BOARD_ID, [
      { status: 400, body: { code: 'NODE_CANVAS_MISMATCH' } },
      { status: 200, body: { canvas: { updatedAt: SERVER_AHEAD } } },
    ]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'ok');
    const retry = savesFor(BOARD_ID)[1];
    assert.deepEqual(retry.body.deletedNodeIds, [LOCAL_NODE.id], '旧 id 必须作为删除上行');
    const sentIds = (retry.body.nodes || []).map((n: any) => n.id);
    assert.equal(sentIds.length, 1);
    assert.notEqual(sentIds[0], LOCAL_NODE.id, '同时要把新 id 带上去');
  });

  test('自愈只做一轮：重映射后仍被拒 → rejected，不递归重映射', async () => {
    seedDirtyLocal(LOCAL_BASE, [LOCAL_NODE]);
    scriptSave(BOARD_ID, [
      { status: 400, body: { code: 'NODE_CANVAS_MISMATCH' } },
      { status: 400, body: { code: 'NODE_CANVAS_MISMATCH' } },
    ]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);

    assert.equal(outcome, 'rejected');
    assert.equal(savesFor(BOARD_ID).length, 2, '只重映射一次；再多就是重映射—重试互相递归');
    assert.equal(dispatchedEvents.filter((e) => e.type === 'deepdive:board-ids-remapped').length, 1);
    assert.equal(
      dispatchedEvents.filter((e) => e.type === 'deepdive:canvas-save-conflict').length,
      1,
      '放弃时必须按 rejected 告知用户，不能静默'
    );
  });

  test('缺基线时补拉服务端基线：本次请求不得携带墓碑（不误删他端节点）', async () => {
    // 本地有内容但**没有**差分基线（升级/基线键被清）：保存路径会先 GET 补基线。
    // 补来的基线是「服务端当前全量」，本地若落后，服务端独有 id 会被差分判成本地删除。
    store.set(BLOB_KEY, JSON.stringify(makeBoard(LOCAL_BASE, [LOCAL_NODE])));
    store.set(SMALL_KEY, LOCAL_BASE);
    boardStore.bindScope('u1');
    boardStore.upsertLocal(
      { id: BOARD_ID, name: '冲突画板', updatedAt: Date.now(), nodeCount: 1 },
      { dirty: true }
    );
    scriptGet(BOARD_ID, [{ status: 200, body: serverBoardPayload(SERVER_AHEAD, [SERVER_NODE]) }]);
    scriptSave(BOARD_ID, [{ status: 200, body: { canvas: { updatedAt: SERVER_AHEAD } } }]);

    const outcome = await syncBoardToBackend(makeBoard(LOCAL_BASE, [LOCAL_NODE]) as any);
    assert.equal(outcome, 'ok');

    const sent = savesFor(BOARD_ID)[0];
    assert.deepEqual(sent.body.deletedNodeIds, [], '缺基线补拉来的服务端节点不得被当成「本地删除」');
    assert.deepEqual(sent.body.deletedEdgeIds, []);
    assert.deepEqual((sent.body.nodes || []).map((n: any) => n.id), [LOCAL_NODE.id]);
  });

  test('flush 语义：saveBoard 同步落盘，紧随其后的出队发的是最新内容（切板/隐藏前 flush 的前提）', async () => {
    // App 在「切换画板 / 删除其他画板 / 页面隐藏」前会先把压在 600ms 防抖里的改动
    // saveBoard 落盘，再 flush。这依赖两个事实：saveBoard 是**同步**写 blob 的，
    // 且出队执行器读的是**当前 blob**。两者任一被改成异步/防抖，那段改动就会丢。
    store.set(SMALL_KEY, LOCAL_BASE);
    boardOps.writeBase(BOARD_ID, { nodes: {}, edges: {} });
    scriptSave(BOARD_ID, [{ status: 200, body: { canvas: { updatedAt: SERVER_AHEAD } } }]);

    saveBoard({ ...makeBoard(LOCAL_BASE, [LOCAL_NODE]), id: BOARD_ID } as any);

    // 同步可读：不需要等任何定时器/微任务
    assert.deepEqual(loadBoard(BOARD_ID)?.nodes.map((n) => n.id), [LOCAL_NODE.id]);

    await flush();
    const saves = savesFor(BOARD_ID);
    assert.equal(saves.length, 1);
    assert.deepEqual(
      (saves[0].body.nodes || []).map((n: any) => n.id),
      [LOCAL_NODE.id],
      '出队必须发最新内容，否则 flush 只是把旧内容又发了一遍'
    );
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
