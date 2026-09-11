/**
 * H3 — 客户端差分（ADR-0017，protocolVersion 2）
 *
 * 这层要证明的核心只有一句：**「没带」= 不动**，所以客户端必须只发送本设备真正改过的节点。
 * 只要有一个未改动的节点被当成「本次改动」上行，服务端就会把它 upsert 一遍，挂机设备照样
 * 能覆盖另一台设备这期间对**它根本没碰过**的节点的修改——用户原话的场景
 *（「半天不上传，改完被云端的覆盖掉了」）就没修好。
 *
 * 另一半是差分基线的安全性：
 * - 删除只从「基线里有、当前板里没有」推导 → 别人新建、本设备还不知道的节点**不可能**被误删
 * - 基线落盘 → 离线删了节点再刷新，依然能发出墓碑（只放内存就会静默复活）
 * - 无基线时先补拉一次服务端状态；补拉不到就退化为「全部新增、绝不上报删除」
 *
 * 还有一条容易被忽略的：投影必须只覆盖**会落库的字段**。React Flow 打开画板时给每个节点
 * 发一次 dimensions（nodes 数组被换新），旧实现据此触发一次整板重传——「别人正在编辑，
 * 我这边一打开就把他覆盖掉」。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- window / localStorage 最小 stub（须在 import 前就位；ESM import 提升，用动态 import 解决）----
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

interface FetchCall {
  url: string;
  method: string;
  body: any;
  keepalive?: boolean;
}
let fetchCalls: FetchCall[] = [];
let getResponse: { status: number; body?: any; networkError?: boolean } = { status: 404 };
let saveResponse: { status: number; body?: any; networkError?: boolean } = {
  status: 200,
  body: { canvas: { updatedAt: '2026-09-11T10:00:00.000Z' } },
};

(globalThis as any).fetch = async (url: string, init?: any) => {
  const method = String(init?.method || 'GET').toUpperCase();
  fetchCalls.push({
    url: String(url),
    method,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    keepalive: init?.keepalive,
  });
  const script = method === 'POST' ? saveResponse : getResponse;
  if (script.networkError) throw new Error('network down');
  return {
    ok: script.status < 400,
    status: script.status,
    json: async () => script.body,
  } as any;
};

const boardOps = await import('../src/lib/board-ops.ts');
const { syncBoardToBackend } = await import('../src/lib/storage.ts');

const BOARD_ID = 'h3-board';
const SERVER_TS = `deepdive_board_server_ts_${BOARD_ID}`;

/** 客户端形状的节点（只给用得到的字段，其余交给投影补默认值） */
const node = (id: string, data: Record<string, any> = {}, extra: Record<string, any> = {}) => ({
  id,
  type: 'chat',
  position: { x: 0, y: 0 },
  data: { title: `标题-${id}`, question: `问题-${id}`, answer: '', ...data },
  ...extra,
});

const edge = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
  type: 'smoothstep',
});

const board = (nodes: any[], edges: any[] = [], extra: Record<string, any> = {}) => ({
  id: BOARD_ID,
  name: '差分画板',
  updatedAt: Date.now(),
  nodes,
  edges,
  ...extra,
});

const saves = () => fetchCalls.filter((c) => c.method === 'POST');
const gets = () => fetchCalls.filter((c) => c.method === 'GET');
const opsOf = (base: any, snapshot: any) => boardOps.computeOps(base, snapshot);
/** 基线带画板名：真实路径上基线总是记录了名字（服务端回包/上次保存），不记就会每次上行 title */
const baseOf = (nodes: any[], edges: any[] = []) =>
  boardOps.baseFromSnapshot({ nodes, edges, name: '差分画板' });

describe('H3 客户端差分（protocolVersion 2）', () => {
  beforeEach(() => {
    store.clear();
    fetchCalls = [];
    getResponse = { status: 404 };
    saveResponse = { status: 200, body: { canvas: { updatedAt: '2026-09-11T10:00:00.000Z' } } };
  });

  test('核心验收：设备 B 挂两小时后改自己的节点，A 的改动不受影响', () => {
    // 服务端初态（两台设备都拿到这一份）
    const s0 = [node('n1', { answer: '原始1' }), node('n2', { answer: '原始2' })];
    const baseA = boardOps.baseFromSnapshot({ nodes: s0, edges: [], name: '差分画板' });
    const baseB = boardOps.baseFromSnapshot({ nodes: s0, edges: [], name: '差分画板' });

    // 设备 A 改 n1
    const opsA = opsOf(baseA, board([node('n1', { answer: 'A改的' }), s0[1]]));
    assert.deepEqual(opsA.nodes.map((n) => n.id), ['n1']);

    // 设备 B 挂了两小时（内存里还是 s0 的旧内容），只改了 n2
    const opsB = opsOf(baseB, board([s0[0], node('n2', { answer: 'B改的' })]));
    assert.deepEqual(opsB.nodes.map((n) => n.id), ['n2'], 'B 只能上行自己改过的节点');
    assert.deepEqual(opsB.deletedNodeIds, [], 'B 没删任何东西，不得发出删除');
    assert.ok(
      !opsB.nodes.some((n) => n.id === 'n1'),
      'n1 一旦被当成「本次改动」上行，服务端就会把 A 的修改覆盖成 B 内存里的旧内容'
    );
  });

  test('未改动的节点不上行；改了 data 里任一持久化字段才上行', () => {
    const s0 = [node('n1'), node('n2')];
    const base = baseOf(s0);

    assert.ok(boardOps.isEmptyOps(opsOf(base, board(s0))), '完全没动 → 空 ops');

    // 只有 answer 变了（程序化 setNodes 写进来的，压根没有变更事件）
    const mutated = [node('n1', { answer: '新答案' }), node('n2')];
    assert.deepEqual(opsOf(base, board(mutated)).nodes.map((n) => n.id), ['n1']);
  });

  test('React Flow 的易变字段不产生伪差异（打开画板不得触发整板重传）', () => {
    const s0 = [node('n1'), node('n2')];
    const base = baseOf(s0);

    // 挂载后 React Flow 给每个节点补 measured/width/height，并可能带上 selected/dragging
    const afterMount = [
      { ...s0[0], measured: { width: 320, height: 180 }, width: 320, height: 180, selected: true, dragging: true },
      { ...s0[1], measured: { width: 320, height: 180 }, positionAbsolute: { x: 0, y: 0 } },
    ] as any[];

    const ops = opsOf(base, board(afterMount));
    assert.ok(
      boardOps.isEmptyOps(ops),
      '尺寸/选中/拖拽状态不落库，进了哈希就等于每次打开画板都整板重标脏'
    );
  });

  test('形状无关：服务端回包形状（默认值已materialize）与客户端新造形状同哈希', () => {
    const clientShape = node('n1', { answer: '答案' });
    const serverShape = {
      id: 'n1',
      type: 'chat',
      position: { x: 0, y: 0 },
      data: {
        title: '标题-n1',
        depth: 0,
        question: '问题-n1',
        answer: '答案',
        content: '',
        noteContent: '',
        messages: [],
        status: 'idle',
        model: '',
        parentId: null,
        grounding: undefined,
        isCollapsed: false,
        branchTriggerPhrase: '',
        enableWebSearch: true,
        color: '',
      },
    };
    assert.equal(
      boardOps.nodeHash(clientShape as any),
      boardOps.nodeHash(serverShape as any),
      '不同形状同哈希，否则升级后第一次保存会把整块板重传一遍'
    );
  });

  test('形状无关（真函数）：服务端归一化 + JSON 往返后哈希不变', async () => {
    const { normalizeMemoryNode } = await import('../server/repositories/canvas.repository.ts');
    const cases = [
      node('n1'),
      node('n2', { answer: '答案', messages: [{ role: 'user', content: '问' }] }),
      { id: 'n3', type: 'note', position: { x: 3, y: 4 }, data: { title: '便签', content: '正文' } },
      node('n4', { answer: '', status: 'suggested', parentId: 'n1', depth: 1 }),
    ];
    for (const c of cases) {
      // JSON 往返 = 过一遍 localStorage 的真实形态（顺带去掉 undefined 键）
      const roundTripped = normalizeMemoryNode(JSON.parse(JSON.stringify(c)), '');
      assert.equal(
        boardOps.nodeHash(roundTripped as any),
        boardOps.nodeHash(c as any),
        `节点 ${c.id} 从服务端回来一趟后哈希必须不变，否则每次拉取都会把整块板重标脏`
      );
    }
  });

  test('画布默认模型非空时，模型列的兜底值同口径（不产生永久的伪差异）', () => {
    const s0 = [node('n1')];
    const base = boardOps.baseFromSnapshot({ nodes: s0, edges: [], name: '差分画板' }, 'gemini-x');
    // 服务端回包里该节点的 model 已被兜底成画布默认模型
    const fromServer = { ...node('n1'), data: { ...node('n1').data, model: 'gemini-x' } };
    assert.ok(
      boardOps.isEmptyOps(opsOf(base, board([fromServer]))),
      '兜底值不一致会让该节点每次保存都重传一遍'
    );
  });

  test('删除：从基线推导为墓碑；基线的节点自己不能复活', () => {
    const s0 = [node('n1'), node('n2')];
    const base = baseOf(s0);

    const ops = opsOf(base, board([s0[0]]));
    assert.deepEqual(ops.deletedNodeIds, ['n2']);
    assert.deepEqual(ops.nodes.map((n) => n.id), [], '留下的那个节点没变，不该跟着上行');
  });

  test('安全边界：别人新建、本设备没见过的节点绝不能被判成删除', () => {
    // 本设备只知道 n1；服务端上已有 n2（他端新建，本设备尚未拉到）
    const base = baseOf([node('n1')]);
    const localBoard = board([node('n1')]);

    const ops = opsOf(base, localBoard);
    assert.deepEqual(ops.deletedNodeIds, [], '基线里没有的 id 不构成「本地删了它」');
    assert.ok(boardOps.isEmptyOps(ops), '没改动就不该发任何东西');
  });

  test('基线落盘：离线删节点后刷新，仍能发出墓碑（不能静默复活）', async () => {
    const s0 = [node('n1'), node('n2')];
    store.set(SERVER_TS, '2026-09-11T09:00:00.000Z');
    boardOps.advanceBase(BOARD_ID, { nodes: s0, edges: [], name: '差分画板' });

    // 「刷新」：进程内缓存清掉，只剩落盘的基线
    const reloaded = boardOps.readBase(BOARD_ID);
    assert.ok(reloaded, '基线必须落盘，只放内存的话刷新后就丢了');

    const ops = opsOf(reloaded, board([s0[0]]));
    assert.deepEqual(ops.deletedNodeIds, ['n2'], '刷新后依然知道是自己删的，要发墓碑');
  });

  test('边：新增边连到未改动的节点必须上行，且不得把端点节点一起重传', () => {
    const s0 = [node('n1'), node('n2')];
    const base = baseOf(s0);

    const ops = opsOf(base, board(s0, [edge('e1', 'n1', 'n2')]));
    assert.deepEqual(ops.edges.map((e) => e.id), ['e1']);
    assert.deepEqual(ops.nodes, [], '端点没变就不该上行——重传端点就是覆盖他人对端点的修改');
    assert.deepEqual(ops.deletedEdgeIds, []);
  });

  test('边的墓碑：基线里的边在当前板里没了 → deletedEdgeIds', () => {
    const e0 = [edge('e1', 'n1', 'n2')];
    const base = baseOf([node('n1'), node('n2')], e0);
    const ops = opsOf(base, board([node('n1'), node('n2')], []));
    assert.deepEqual(ops.deletedEdgeIds, ['e1']);
  });

  test('画板名/视口：只有真的改了才上行（整字段 LWW 的防覆盖前提）', () => {
    const s0 = [node('n1')];
    const base = boardOps.baseFromSnapshot({
      nodes: s0,
      edges: [],
      name: '原名',
      viewport: { x: 1, y: 2, zoom: 1 },
    });

    const same = opsOf(base, board(s0, [], { name: '原名', viewport: { x: 1, y: 2, zoom: 1 } }));
    assert.equal(same.title, undefined, '没改名就不带 title，否则会把别处的改名冲回旧名');
    assert.equal(same.viewport, undefined);

    const renamed = opsOf(base, board(s0, [], { name: '新名', viewport: { x: 5, y: 6, zoom: 2 } }));
    assert.equal(renamed.title, '新名');
    assert.deepEqual(renamed.viewport, { x: 5, y: 6, zoom: 2 });
  });

  test('保存请求带 protocolVersion 2 与显式墓碑字段', async () => {
    const s0 = [node('n1'), node('n2')];
    boardOps.advanceBase(BOARD_ID, { nodes: s0, edges: [], name: '差分画板' });

    const outcome = await syncBoardToBackend(
      board([node('n1', { answer: '改了' })], [], { serverUpdatedAt: '2026-09-11T09:00:00.000Z' }) as any
    );

    assert.equal(outcome, 'ok');
    assert.equal(saves().length, 1);
    const body = saves()[0].body;
    assert.equal(body.protocolVersion, 2, '缺省会被服务端判成旧客户端的整板替换');
    assert.deepEqual(body.nodes.map((n: any) => n.id), ['n1']);
    assert.deepEqual(body.deletedNodeIds, ['n2'], '没带 = 不动，删除必须显式声明');
    assert.deepEqual(body.deletedEdgeIds, []);
    assert.equal(body.title, undefined, '没改名就不带 title');
    assert.equal(gets().length, 0, '基线已在本地，不该多打一次 GET');
  });

  test('没有任何真实改动 → 不发请求（打开画板的空转写入）', async () => {
    const s0 = [node('n1')];
    boardOps.advanceBase(BOARD_ID, { nodes: s0, edges: [], name: '差分画板' });

    store.set(SERVER_TS, '2026-09-11T09:00:00.000Z');
    const outcome = await syncBoardToBackend(board(s0) as any);

    assert.equal(outcome, 'ok');
    assert.equal(fetchCalls.length, 0, '空 ops 不该产生任何请求');
  });

  test('保存成功后基线推进：同一份内容再存一次变成空 ops', async () => {
    const s0 = [node('n1'), node('n2')];
    boardOps.advanceBase(BOARD_ID, { nodes: s0, edges: [], name: '差分画板' });

    const changed = board([node('n1', { answer: '改' }), s0[1]]);
    assert.equal(await syncBoardToBackend(changed as any), 'ok');
    assert.equal(saves().length, 1);

    fetchCalls = [];
    assert.equal(await syncBoardToBackend(changed as any), 'ok');
    assert.equal(saves().length, 0, '基线推进到「本次已上行的那份」，同样的内容不该再传');
    assert.equal(gets().length, 0);
  });

  test('无基线 + 有服务端版本号：先补拉一次服务端状态再算差分（升级路径）', async () => {
    store.set(SERVER_TS, '2026-09-11T09:00:00.000Z');
    // 服务端上 n1 已被他端改过；本设备内存里还是旧的 n1，且本地只有 n1
    getResponse = {
      status: 200,
      body: {
        id: BOARD_ID,
        title: '差分画板',
        updatedAt: '2026-09-11T09:30:00.000Z',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [node('n1', { answer: '他端改的' })],
        edges: [],
      },
    };

    const outcome = await syncBoardToBackend(board([node('n1', { answer: '旧内容' })]) as any);

    assert.equal(gets().length, 1, '缺基线时必须先看清服务端现状');
    assert.equal(outcome, 'ok');
    assert.equal(saves()[0].body.title, undefined, '服务端版本与本地同名，不该上行 title');
    assert.deepEqual(
      saves()[0].body.nodes.map((n: any) => n.id),
      ['n1'],
      '本地与服务端内容不同 → 本设备这份要上行（这一窗口内的覆盖风险是升级的一次性代价）'
    );
    assert.deepEqual(saves()[0].body.deletedNodeIds, []);
  });

  test('无基线：补拉不到（断网）→ 全部当新增，绝不上报删除', async () => {
    store.set(SERVER_TS, '2026-09-11T09:00:00.000Z');
    getResponse = { status: 0, networkError: true };

    const outcome = await syncBoardToBackend(board([node('n1'), node('n2')]) as any);

    assert.equal(outcome, 'ok');
    assert.deepEqual(saves()[0].body.nodes.map((n: any) => n.id).sort(), ['n1', 'n2']);
    assert.deepEqual(
      saves()[0].body.deletedNodeIds,
      [],
      '看不清服务端现状时宁可不删——乱发墓碑会直接吃掉别人的内容'
    );
  });

  test('纯本地草稿（无服务端版本号）不补拉：必然 404，白跑一趟', async () => {
    const outcome = await syncBoardToBackend(board([node('n1')]) as any);

    assert.equal(gets().length, 0);
    assert.equal(outcome, 'ok');
    assert.deepEqual(saves()[0].body.nodes.map((n: any) => n.id), ['n1']);
  });

  test('keepalive 补传缺基线：不发 GET，也绝不退化成整板 upsert', async () => {
    store.set(SERVER_TS, '2026-09-11T09:00:00.000Z');

    const outcome = await syncBoardToBackend(board([node('n1'), node('n2')]) as any, {
      keepalive: true,
    });

    assert.equal(outcome, 'fail', '留在持久化队列里下次启动续跑');
    assert.equal(gets().length, 0, '页面正在消失，不该再发 GET');
    assert.equal(saves().length, 0, '此刻整板 upsert 正是「挂机设备覆盖他人改动」的机理');
  });

  test('saveMode=merge 时画板级乐观锁不再挡下节点 op（挂机两小时的设备照样能存）', async () => {
    const s0 = [node('n1'), node('n2')];
    boardOps.advanceBase(BOARD_ID, { nodes: s0, edges: [], name: '差分画板' });

    // 服务端接受了（合并模式刻意不校验画板级版本），本地带着过期基线
    const outcome = await syncBoardToBackend(
      board([node('n1', { answer: '挂机后改的' }), s0[1]], [], {
        serverUpdatedAt: '2026-09-11T08:00:00.000Z',
      }) as any
    );

    assert.equal(outcome, 'ok');
    // 基线推进到服务端刚回的新版本，下一页的乐观锁版本跟着走
    assert.equal(store.get(SERVER_TS), '2026-09-11T10:00:00.000Z');
  });
});
