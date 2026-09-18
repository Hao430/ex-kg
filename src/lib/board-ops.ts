/**
 * 画板差分（ADR-0017，protocolVersion 2）。
 *
 * 为什么客户端必须算差分，而不是「整板当 diff 传」：
 * 合并写入的语义是「没带 = 不动」。若把整块板都当成本次改动传上去，服务端会把每个节点
 * 都 upsert 一遍，挂机两小时的设备照样能覆盖另一台设备这期间对**它根本没碰过**的节点的
 * 修改——用户原话的场景（「半天不上传，改完被云端的覆盖掉了」）就没修好。载荷变小是副产品，
 * 正确性才是主因。
 *
 * 基线（base）：
 * 「本设备已知与服务端一致」的那份内容，按画板存 id → 投影哈希，**必须落盘**。
 * 只放内存的话，「离线删了节点 → 刷新」会让该节点既不在 upserts 也不在 deletedNodeIds 里，
 * 服务端上它静默复活。落盘后：基线里有、当前板里没有 = 本地删除，正是墓碑要表达的。
 *
 * 基线只从两处推进（都是「已与服务端一致」的时刻）：
 * 1. 保存成功 → 推进为**本次已上行的那份快照**（不是当前画面：飞行期间的编辑要留在下一轮）
 * 2. 从服务端取回画板 → 推进为服务端那份内容
 * 因此基线里的 id 必然是「本设备见过的」，不会凭空生成删除指令。
 *
 * ⚠️ 唯一的例外是「基线缺失时补拉」：`seedBaseFromServer` 把基线设成**服务端当前全量**，
 * 而本地 blob 可能落后于服务端——此时「基线里有、本地没有」的 id 全是他端新节点，按差分
 * 会报成本地删除。故保存路径在走过补拉时**必须清空本次请求的墓碑**（storage.ts，ADR-0025）。
 *
 * 投影（nodeHash/edgeHash）：
 * 哈希只覆盖**会被持久化的字段**，React Flow 的易变字段（selected / dragging / measured /
 * dimensions / positionAbsolute）一律不进哈希——否则挂载时每个节点发一次 dimensions 就等于
 * 每次打开画板都整板标脏。同时按服务端读列时的默认值补齐（见 normalizeData），使「客户端
 * 造出来的节点形状」与「服务端回包形状」同哈希，避免升级后首次保存整板重传。
 */
import type { Node, Edge } from '@xyflow/react';
import * as scope from './board-scope';

/** 每个画板一份「已知与服务端一致」的基线 */
export interface BoardOpsBase {
  /** 节点 id → 投影哈希 */
  nodes: Record<string, string>;
  edges: Record<string, string>;
  /** 已同步的画板名（undefined = 无记录，下次保存照常上行一次） */
  title?: string;
  /** 已同步的视口语义串 */
  viewport?: string;
  /**
   * 服务端画布级默认模型。节点模型列存的是 `data.model || 画布默认模型`，
   * 读取时同样兜底，所以投影必须用同一个兜底值，否则该列非空时每个节点哈希都对不上，
   * 变成每次保存整板重传。客户端从不发 defaultModel，实践中该列恒为空，但这不该靠运气。
   */
  defaultModel?: string;
}

export interface BoardSnapshot {
  nodes: Node[];
  edges: Edge[];
  name?: string;
  viewport?: { x: number; y: number; zoom: number };
}

/** 本次要上行的东西（缺省字段 = 本次没改，服务端保留原值） */
export interface BoardOps {
  /** 新增或内容有变化的节点（未变动的节点不得出现在这里） */
  nodes: Node[];
  edges: Edge[];
  /** 本地已删除的节点 id（墓碑） */
  deletedNodeIds: string[];
  /** 本地已删除的边 id（墓碑） */
  deletedEdgeIds: string[];
  /** 仅在真的改了画板名时给出 */
  title?: string;
  /** 仅在真的改了视口时给出 */
  viewport?: { x: number; y: number; zoom: number };
}

export const EMPTY_BASE: BoardOpsBase = { nodes: {}, edges: {} };

/**
 * 服务端 `buildNodeRow`（server/repositories/canvas.repository.ts）解构掉的已知字段：
 * 这些字段各占一列，**其余字段一律进 custom_data 原样往返**。
 * 两边必须逐字一致——arch-tests/board-ops-projection.test.mjs 会拦住漂移。
 */
export const KNOWN_DATA_KEYS: readonly string[] = [
  'title',
  'question',
  'answer',
  'content',
  'noteContent',
  'note',
  'messages',
  'status',
  'isCollapsed',
  'branchTriggerPhrase',
  'enableWebSearch',
  'color',
  'depth',
  'model',
  'grounding',
  'parentId',
];

/**
 * 规范化 JSON：键排序 + 丢弃 undefined。
 * 同一份内容在不同代码路径下构造出的对象键序可能不同（新造的节点 vs 服务端回包），
 * 不排序会产生伪差异 → 每次保存都重传同一个节点。undefined 与「键不存在」等价
 * （与 JSON.stringify 落库口径一致）。
 */
function canon(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const src = v as Record<string, unknown>;
  const keys = Object.keys(src).filter((k) => src[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(src[k])}`).join(',')}}`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/**
 * data 归一化：镜像服务端读列时的默认值补齐。
 * 例：客户端新造节点 `data.parentId` 可能是 undefined，服务端回包给的是 null；
 * 不补齐就会把「同一个节点」判成两个不同的哈希。
 */
function normalizeData(data: unknown, type: string, defaultModel: string): Record<string, unknown> {
  const src = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  const custom: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (KNOWN_DATA_KEYS.includes(k)) continue;
    if (src[k] === undefined) continue;
    custom[k] = src[k];
  }
  const answer = typeof src.answer === 'string' ? src.answer : '';
  // 服务端 noteText = content || noteContent || note，且 content/noteContent 都存成它
  const noteText = src.content || src.noteContent || src.note || '';
  return {
    title: src.title || src.question || (type === 'note' ? '便签' : '思考节点'),
    depth: typeof src.depth === 'number' ? src.depth : 0,
    question: src.question || '',
    answer,
    content: noteText,
    noteContent: noteText,
    messages: Array.isArray(src.messages) ? src.messages : [],
    status: src.status || (answer ? 'idle' : 'suggested'),
    model: src.model || defaultModel,
    parentId: src.parentId ?? null,
    grounding: isEmptyValue(src.grounding) ? null : src.grounding,
    isCollapsed: src.isCollapsed ?? false,
    branchTriggerPhrase: src.branchTriggerPhrase || '',
    enableWebSearch: src.enableWebSearch !== false,
    color: src.color || '',
    ...custom,
  };
}

/** 节点的持久化投影哈希（只覆盖会被写库的字段） */
export function nodeHash(node: Node, defaultModel = ''): string {
  const type = (node as any)?.type || 'chat';
  const pos = (node as any)?.position || { x: 0, y: 0 };
  return canon({
    id: (node as any)?.id ?? '',
    type,
    x: num(pos.x),
    y: num(pos.y),
    data: normalizeData((node as any)?.data, type, defaultModel),
  });
}

/** 边的持久化投影哈希（字段集合同服务端 buildEdgeRow） */
export function edgeHash(edge: Edge): string {
  const e = (edge || {}) as any;
  return canon({
    id: e.id ?? '',
    source: e.source ?? '',
    target: e.target ?? '',
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    label: e.label ?? null,
    animated: Boolean(e.animated),
    type: e.type ?? null,
    style: e.style ?? null,
    markerEnd: e.markerEnd ?? null,
  });
}

function viewportKey(vp?: { x: number; y: number; zoom: number } | null): string | undefined {
  if (!vp) return undefined;
  return canon({ x: num(vp.x), y: num(vp.y), zoom: num(vp.zoom) });
}

function hashEntries<T>(items: T[] | undefined, hash: (item: T) => string, idOf: (item: T) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items || []) {
    const id = idOf(item);
    if (!id) continue;
    out[id] = hash(item);
  }
  return out;
}

/** 由一份「已与服务端一致」的快照构造基线 */
export function baseFromSnapshot(snapshot: BoardSnapshot, defaultModel = ''): BoardOpsBase {
  const base: BoardOpsBase = {
    nodes: hashEntries(snapshot.nodes, (n) => nodeHash(n, defaultModel), (n: any) => n?.id),
    edges: hashEntries(snapshot.edges, edgeHash, (e: any) => e?.id),
    defaultModel,
  };
  if (snapshot.name !== undefined) base.title = snapshot.name;
  const vp = viewportKey(snapshot.viewport);
  if (vp !== undefined) base.viewport = vp;
  return base;
}

/** 由服务端 GET /api/canvases/:id 的回包构造基线（回包里的 nodes/edges 即服务端当前状态） */
export function baseFromServerPayload(payload: any): BoardOpsBase {
  const base = baseFromSnapshot(
    {
      nodes: Array.isArray(payload?.nodes) ? payload.nodes : [],
      edges: Array.isArray(payload?.edges) ? payload.edges : [],
    },
    typeof payload?.defaultModel === 'string' ? payload.defaultModel : ''
  );
  if (typeof payload?.title === 'string') base.title = payload.title;
  const vp = payload?.viewport;
  if (vp && typeof vp === 'object') {
    const key = viewportKey({ x: vp.x, y: vp.y, zoom: vp.zoom });
    if (key !== undefined) base.viewport = key;
  }
  return base;
}

/**
 * 算本次要上行什么。**与基线比对是唯一真相**——React Flow 的变更事件不是：
 * 画布里有大量程序化 `setNodes(...)`（AI 回答落库、导入、克隆、starter 板）根本不发变更事件，
 * 依赖事件收集改动集会把「AI 回答」这类核心内容漏掉。全量比对虽然多花一次序列化，
 * 但比现有实现（每次保存把整块板 stringify 两遍）还便宜，而且不会漏。
 */
export function computeOps(base: BoardOpsBase | null, snapshot: BoardSnapshot): BoardOps {
  const b = base ?? EMPTY_BASE;
  const dm = b.defaultModel ?? '';
  const nodes: Node[] = [];
  const curNodeIds = new Set<string>();
  for (const n of snapshot.nodes || []) {
    const id = (n as any)?.id;
    if (!id) continue;
    curNodeIds.add(id);
    if (b.nodes[id] !== nodeHash(n, dm)) nodes.push(n);
  }

  const edges: Edge[] = [];
  const curEdgeIds = new Set<string>();
  for (const e of snapshot.edges || []) {
    const id = (e as any)?.id;
    if (!id) continue;
    curEdgeIds.add(id);
    if (b.edges[id] !== edgeHash(e)) edges.push(e);
  }

  const ops: BoardOps = {
    nodes,
    edges,
    // 基线里有、当前板里没有 = 本地删掉的。基线只记本设备见过的 id，
    // 所以不会把「别人新建、本设备还不知道」的节点误判成删除。
    deletedNodeIds: Object.keys(b.nodes).filter((id) => !curNodeIds.has(id)),
    deletedEdgeIds: Object.keys(b.edges).filter((id) => !curEdgeIds.has(id)),
  };

  // 整字段 LWW：只有真的改了才上行，否则挂机设备会把别处的改名/视口冲回旧值
  if (snapshot.name !== undefined && snapshot.name !== b.title) ops.title = snapshot.name;
  const vpKey = viewportKey(snapshot.viewport);
  if (vpKey !== undefined && vpKey !== b.viewport) ops.viewport = snapshot.viewport;

  return ops;
}

/** 无任何实际改动 → 不该发请求（也顺手免掉「打开画板即整板重传」这类空转写入） */
export function isEmptyOps(ops: BoardOps): boolean {
  return (
    ops.nodes.length === 0 &&
    ops.edges.length === 0 &&
    ops.deletedNodeIds.length === 0 &&
    ops.deletedEdgeIds.length === 0 &&
    ops.title === undefined &&
    ops.viewport === undefined
  );
}

/** 本次实际上行了几个 op（观测用） */
export function opsCount(ops: BoardOps): number {
  return (
    ops.nodes.length +
    ops.edges.length +
    ops.deletedNodeIds.length +
    ops.deletedEdgeIds.length +
    (ops.title !== undefined ? 1 : 0) +
    (ops.viewport !== undefined ? 1 : 0)
  );
}

function baseKey(boardId: string): string {
  return `${scope.BOARD_BASE_PREFIX}${boardId}`;
}

export function readBase(boardId: string): BoardOpsBase | null {
  const raw = scope.readJson<BoardOpsBase | null>(baseKey(boardId), null);
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.nodes || typeof raw.nodes !== 'object' || !raw.edges || typeof raw.edges !== 'object') {
    return null;
  }
  return raw;
}

export function writeBase(boardId: string, base: BoardOpsBase): void {
  try {
    scope.writeJson(baseKey(boardId), base);
  } catch (e) {
    // 落盘失败只影响差分的精度（退化为整板新增），不影响本次保存，不必打断用户；
    // 但下一轮会重试写，所以留日志即可。
    console.warn('[board-ops] 基线落盘失败，本次退化为全量新增：', e);
  }
}

/**
 * 无基线时取一次服务端状态来补基线。
 *
 * 只有「本地有服务端版本号但基线丢了」才值得发这个 GET（升级到本版、或基线键被清）：
 * - 服务端有这一行 → 基线 = 服务端当前状态，于是只有本设备真正改过的才上行
 * - 服务端没有（404）→ 空基线 = 一切都是新增，**绝不上报删除**
 * - 取不到（网络/未登录）→ 返回 null，调用方退化为空基线（同样不报删除）
 *
 * 从未同步过的纯本地草稿不发 GET：必然 404，白跑一趟。
 */
export async function seedBaseFromServer(boardId: string): Promise<BoardOpsBase | null> {
  if (!scope.hasServerVersion(boardId)) {
    return EMPTY_BASE;
  }
  try {
    const res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}`, {
      credentials: 'include',
    });
    if (res.status === 404) {
      writeBase(boardId, EMPTY_BASE);
      return EMPTY_BASE;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const base = baseFromServerPayload(data);
    writeBase(boardId, base);
    return base;
  } catch {
    return null;
  }
}

/** 保存成功后推进基线（传入的必须是**本次已上行的那份快照**，不是当前画面） */
export function advanceBase(boardId: string, snapshot: BoardSnapshot): void {
  // 画布默认模型只在服务端回包里出现过，这里沿用上一份基线里的值（客户端不知道它）
  const prev = readBase(boardId);
  writeBase(boardId, baseFromSnapshot(snapshot, prev?.defaultModel ?? ''));
}
