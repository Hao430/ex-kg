/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 画板本地持久化 + 服务端同步（2026-09-12 云优先：服务端是唯一真相，本地只留未确认缓冲）。
 * - 列表真相在 board-store（服务端快照 + 本地未确认缓冲 − 墓碑）
 * - 同步队列升级为持久化的上传/删除意图队列
 * - 删除改乐观 + 墓碑，游客/纯本地草稿无需服务端
 */
import { Node, Edge } from '@xyflow/react';
import { DeepDiveBoardMeta, ChatNodeData } from '../types';
import { enqueue, dequeue, enqueueDelete, enqueueMeta, setSyncExecutor, setDeleteExecutor, setMetaExecutor } from './sync-queue';
import type { SyncExecOpts, SyncOutcome } from './sync-queue';
import * as boardScope from './board-scope';
import * as boardStore from './board-store';
import * as boardOps from './board-ops';
import * as quotaStore from './quota-store';
import { trackEvent } from './analytics';
import { remapBoardIds } from './board-remap';

const STORAGE_BOARD_PREFIX = boardScope.BOARD_BLOB_PREFIX;
const LEGACY_STORAGE_BOARD_PREFIX = boardScope.LEGACY_BOARD_BLOB_PREFIX;
/** serverUpdatedAt 独立小键：保存成功后免整板 JSON parse/stringify（性能优化） */
const SERVER_TS_PREFIX = boardScope.SERVER_TS_PREFIX;

export interface StoredBoard {
  id: string;
  name: string;
  updatedAt: number;
  nodes: Node[];
  edges: Edge[];
  viewport?: { x: number; y: number; zoom: number };
  /** 服务端最近一次保存的 updatedAt，用作乐观锁的 expectedUpdatedAt（Spec A4） */
  serverUpdatedAt?: string;
}

/** 本地列表：以 board-store 为准（已合并服务端快照/本地草稿/墓碑） */
export function loadBoardList(): DeepDiveBoardMeta[] {
  return boardStore.getBoardList();
}

/** @deprecated 兼容入口：直接写 scoped 索引（正常路径经 board-store） */
export function saveBoardList(boards: DeepDiveBoardMeta[]): void {
  try {
    boardScope.writeScopedIndex(boards);
  } catch (e) {
    console.error('Failed to save boards index:', e);
  }
}

export function deduplicateNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  return (nodes || []).filter((n) => {
    if (!n || !n.id || seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

export function deduplicateEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  return (edges || []).filter((e) => {
    if (!e || !e.id || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

export function loadBoard(boardId: string): StoredBoard | null {
  try {
    const raw =
      localStorage.getItem(`${STORAGE_BOARD_PREFIX}${boardId}`) ||
      localStorage.getItem(`${LEGACY_STORAGE_BOARD_PREFIX}${boardId}`);
    if (!raw) return null;
    const parsed: StoredBoard = JSON.parse(raw);
    if (parsed) {
      parsed.nodes = deduplicateNodes(parsed.nodes);
      parsed.edges = deduplicateEdges(parsed.edges);
      // 独立小键为权威来源（旧数据回退 blob 内嵌值）
      const serverTs = localStorage.getItem(`${SERVER_TS_PREFIX}${boardId}`);
      if (serverTs) parsed.serverUpdatedAt = serverTs;
    }
    return parsed;
  } catch (e) {
    console.error(`Failed to load board ${boardId}:`, e);
    return null;
  }
}

export function saveBoard(board: StoredBoard): void {
  try {
    const cleanedBoard: StoredBoard = {
      ...board,
      nodes: deduplicateNodes(board.nodes),
      edges: deduplicateEdges(board.edges),
    };
    persistBoard(cleanedBoard, { dirty: true });
    // Asynchronously sync to backend (PostgreSQL) via retry queue (Spec A5)
    enqueueBoardSync(cleanedBoard.id);
  } catch (e) {
    // 本地 blob 写失败 = 这次编辑没保住，必须让用户看见（不能只打日志）
    boardScope.reportPersistFailure('board-blob', e);
  }
}

/** 纯本地持久化（写画布记录 + 通知 board-store），可指定是否为未同步改动 */
function persistBoard(cleanedBoard: StoredBoard, opts?: { dirty?: boolean }): void {
  // 兜底合并：调用点构造的 StoredBoard 不携带 serverUpdatedAt 时，从权威小键读回注入，
  // 防止覆写 blob 抹掉内嵌版本号（App 层各 saveBoard 调用点均不传该字段）
  if (!cleanedBoard.serverUpdatedAt) {
    try {
      const serverTs = localStorage.getItem(`${SERVER_TS_PREFIX}${cleanedBoard.id}`);
      if (serverTs) cleanedBoard.serverUpdatedAt = serverTs;
    } catch { /* ignore */ }
  }
  localStorage.setItem(
    `${STORAGE_BOARD_PREFIX}${cleanedBoard.id}`,
    JSON.stringify(cleanedBoard)
  );
  const meta = {
    id: cleanedBoard.id,
    name: cleanedBoard.name,
    updatedAt: cleanedBoard.updatedAt,
    nodeCount: cleanedBoard.nodes.length,
  };
  // dirty:false 的调用点只有两处，内容来源都是服务端（fetch 落盘 / 冲突后采用服务端版），
  // 属于「已确认」而非未确认缓冲——必须显式区分，不能靠版本小键猜（见 upsertServerMeta 注释）。
  if (opts?.dirty === false) boardStore.upsertServerMeta(meta);
  else boardStore.upsertLocal(meta, { dirty: true });
}

/**
 * Sync board to backend API（三态：ok / conflict / fail，供重试队列判定）
 * - 携带 serverUpdatedAt 作为乐观锁版本（Spec A4）；合并路径下服务端**刻意不校验**它（ADR-0017）。
 * - 只上行本设备改过的节点/边（`computeOps` 差分），服务端节点级合并、墓碑胜出。
 * - 409 仅作防御：v2 客户端正常走不到（见分支注释）；**任何情况下都不再建冲突副本**（ADR-0025）。
 * - 403/404 带 code：BOARD_LIMIT_REACHED/VIP_EXPIRED 保留草稿待升级；NOT_FOUND 收敛幽灵板。
 */

/**
 * keepalive 请求体上限：浏览器对 keepalive/sendBeacon 有 ~64KB 限制，超限会直接抛错。
 * 大画板（长对话、多节点）超限时不发这次请求，留在持久化队列里下次启动续跑，不冒险丢。
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * 服务端**确定性拒绝**的保存错误码：拒绝理由是内容的**结构性属性**（节点 id 归属、父子环），
 * 不是尺寸/权限/网络——同一份内容重发一万次结果一致。命中即停止重试并告知用户
 *（`SyncOutcome = 'rejected'`）。
 *
 * 刻意保持窄：只放「确定重试无用」的码，其余 400 仍走退避重试——用户把内容改了可能就过了。
 * 收紧的代价是用户需改内容或刷新页面才恢复自动重试；放宽的代价是静默无限重试
 *（2026-09-14 线上事故就是这么来的）。
 */
const PERMANENT_SAVE_REJECTION_CODES = new Set(['NODE_CANVAS_MISMATCH', 'NODE_PARENT_CYCLE']);

/**
 * 载入路径的「在途保存作废」纪元（per board）。
 *
 * 载入采用服务端内容后，若该板有一个**更早发出**的保存请求随后才返回，它会用旧快照
 * `advanceBase` + `confirmServerSave`，把刚重置成服务端状态的基线打回旧值——之后所有差分
 * 都是错的。故采用时把纪元 +1；保存请求在 `res.ok` 前比对出发时捕获的纪元，不一致即丢弃结果。
 */
const contentEpoch = new Map<string, number>();

function currentContentEpoch(boardId: string): number {
  return contentEpoch.get(boardId) ?? 0;
}

function bumpContentEpoch(boardId: string): void {
  contentEpoch.set(boardId, currentContentEpoch(boardId) + 1);
}

/** keepalive 体积按真实 UTF-8 字节数判断（中文正文下 字符数 与 字节数 差 3 倍） */
const utf8 = new TextEncoder();

/** 冲突/失败提示事件统一派发（detail 带可选 code，供 UI 分流处理） */
function dispatchConflictEvent(
  boardId: string,
  message?: string,
  latestUpdatedAt?: string,
  code?: string
): void {
  window.dispatchEvent(
    new CustomEvent('deepdive:canvas-save-conflict', {
      detail: {
        boardId,
        message,
        latestUpdatedAt,
        code,
      },
    })
  );
}

/**
 * 画板节点/边 id 被**就地重映射**后的通知：内存里的画布（React state / currentNodesRef）
 * 还攥着旧 id，必须让 UI 重新播种。不通知的话，下一次防抖保存会带着旧 id 打回来，
 * 再撞一次跨板拦截 → 又重映射一次，变成「重映射—保存」死循环。
 */
function dispatchIdsRemappedEvent(boardId: string): void {
  window.dispatchEvent(
    new CustomEvent('deepdive:board-ids-remapped', { detail: { boardId } })
  );
}

export async function syncBoardToBackend(
  board: StoredBoard,
  opts?: SyncExecOpts
): Promise<SyncOutcome> {
  return syncBoardToBackendInner(board, opts, false);
}

/**
 * @param idsRemapped 本次调用是否已经是「重映射后再试」的那一次。自愈只允许做一轮：
 *   重映射产出的是全新 uuidv7，不可能再撞同一块画板；这个守卫防的是「万一还撞」时
 *   重映射—重试互相递归下去。
 */
async function syncBoardToBackendInner(
  board: StoredBoard,
  opts: SyncExecOpts | undefined,
  idsRemapped: boolean
): Promise<SyncOutcome> {
  const keepalive = opts?.keepalive === true;

  // 差分基线 = 本设备已知与服务端一致的那份内容。缺失时补一次（升级到本版、或基线键被清）
  const hadBase = boardOps.readBase(board.id) !== null;
  let base = boardOps.readBase(board.id);
  if (!base) {
    // 页面卸载补传不做额外 GET；此刻也**绝不能**退化成整板 upsert——那正是
    // 「挂机设备覆盖他人改动」的机理。留在持久化队列里下次启动续跑。
    if (keepalive) return 'fail';
    base = await boardOps.seedBaseFromServer(board.id);
  }
  const ops = boardOps.computeOps(base, board);
  // 基线是刚补拉的服务端全量时，**本次请求不得携带墓碑**：本地 blob 可能落后于服务端，
  // 那样「基线里有、本地没有」的 id 全是服务端独有节点，报删除等于反过来删别人的内容。
  // 缺基线的补拉路径见 `seedBaseFromServer`（ADR-0025）。
  if (!hadBase) {
    ops.deletedNodeIds = [];
    ops.deletedEdgeIds = [];
  }
  if (boardOps.isEmptyOps(ops)) {
    // 没有任何会被持久化的字段真的变了 → 不发请求。
    // 打开画板时 React Flow 会给每个节点发一次 dimensions（不进投影），旧实现在这里会平白
    // 整板重传一次——「别人正在编辑，我这边一打开就把他覆盖掉」的成因之一。
    // 顺带收敛提示：不发请求即与基线一致，不该再留着「未同步」标记。
    boardStore.markDirty(board.id, false);
    return 'ok';
  }
  // 载入采用服务端内容会把本板的基线重置；若本次请求在那之后才返回，其回包属于旧纪元。
  const epochAtSend = currentContentEpoch(board.id);

  const payload = JSON.stringify({
    // ADR-0017 协议分流：**必须显式给版本号**。旧客户端的整板 payload 与本客户端的
    // 「本次改动」结构上无法区分，且空数组在两边语义相反（清空 vs 无删除）。
    protocolVersion: 2,
    // 缺省 = 本次没改（服务端 COALESCE 保留原值）。整字段 LWW 只在真的改了时才上行，
    // 否则挂机设备一保存就把别处的改名/视口冲回旧值。
    title: ops.title,
    viewport: ops.viewport,
    nodes: ops.nodes,
    edges: ops.edges,
    deletedNodeIds: ops.deletedNodeIds,
    deletedEdgeIds: ops.deletedEdgeIds,
    // 合并模式下服务端**刻意不校验**这个画板级乐观锁（挂机设备改一个节点照样得能保存），
    // 保留在请求里只是为了协议字段不缩水，将来若要做节点级 CAS 可直接复用。
    expectedUpdatedAt: board.serverUpdatedAt,
  });
  // keepalive 有体积上限：超限时跳过本次补传，留给持久化队列下次续跑（不冒险发注定失败的请求）
  if (keepalive && utf8.encode(payload).length > KEEPALIVE_MAX_BYTES) {
    return 'fail';
  }
  let res: Response;
  try {
    res = await fetch(`/api/canvases/${encodeURIComponent(board.id)}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive,
      body: payload,
    });
  } catch (e) {
    return 'fail'; // 网络失败：交回 sync-queue 退避重试
  }

  // 401 会话失效（如改密/重置密码后被踢下线）：重试无意义——提示重新登录并停止重试
  if (res.status === 401) {
    dispatchConflictEvent(board.id, '登录状态已失效，请重新登录后再保存画板', undefined, 'UNAUTHORIZED');
    return 'conflict';
  }

  // 配额/权限类 403 为永久失败，重试无意义——弹升级窗/提示并保留草稿（Spec B1/B4）
  if (res.status === 403) {
    const body = await res.json().catch(() => null) as any;
    dispatchConflictEvent(board.id, body?.error || '画板保存被拒绝', undefined, body?.code || 'FORBIDDEN');
    return 'conflict';
  }

  // 404：画板已在其他设备软删/不存在——收敛幽灵板，停止重试风暴
  if (res.status === 404) {
    const body = await res.json().catch(() => null) as any;
    boardStore.reconcileRemoteDeletion(board.id);
    quotaStore.unmarkPendingCreate(board.id);
    dispatchConflictEvent(board.id, body?.error || '画板已在其他设备被删除', undefined, 'NOT_FOUND');
    return 'conflict';
  }

  // 409 仅作防御：v2 客户端走节点级合并，服务端**刻意不校验**画板级乐观锁（ADR-0017），
  // 正常永远到不了这里。能到这里的只有旧协议客户端 / 服务端配置不一致，重发同样的内容
  // 不会变好，故按确定性拒绝处理：提示刷新并停止重试——**绝不建冲突副本**（ADR-0025）。
  if (res.status === 409) {
    if (keepalive) return 'fail'; // 页面正在消失：不改本地状态，留给下次启动的正常链路
    const body = await res.json().catch(() => null) as any;
    dispatchConflictEvent(
      board.id,
      body?.error || '画板已在其他窗口被修改，请刷新页面后重试',
      undefined,
      'CLIENT_OUTDATED'
    );
    return 'rejected';
  }

  // 400：payload 被服务端校验拒绝。**不是所有 400 都永久**——用户把内容改了可能就过了，
  // 故只把结构性、改内容也救不回来的码判为 rejected（见 PERMANENT_SAVE_REJECTION_CODES），
  // 其余照旧交退避重试。
  if (res.status === 400) {
    const body = await res.json().catch(() => null) as any;
    const code = typeof body?.code === 'string' ? body.code : 'VALIDATION_ERROR';
    if (!PERMANENT_SAVE_REJECTION_CODES.has(code)) return 'fail';

    // 自愈：跨板撞 id 是**本板自己能救的**——把本板节点/边的 id 全部重映射，重试一次即可。
    // 画板 id 不变：用户看到的还是同一块板、同一份内容，只是内部标识换了一套。
    //
    // 这是给「已经困在本机的存量坏副本」准备的。源头的复制路径已在 `07ecef0` 修好，但那时
    // 已经产生的副本救不回来——它的内容就带着源画板的节点 id，不重映射就永远传不上去，
    // 只能等用户换设备/清缓存时丢掉（2026-09-14 线上事故）。
    //
    // 只做一轮（idsRemapped 守卫）；页面卸载前的补传不做这个决策，留给下次正常链路
    //（与 409 分支同一条理由）。
    if (code === 'NODE_CANVAS_MISMATCH' && !idsRemapped && !keepalive) {
      const remapped = remapBoardIds(board.nodes, board.edges, { boardId: board.id });
      const next: StoredBoard = { ...board, nodes: remapped.nodes, edges: remapped.edges };
      try {
        persistBoard(next, { dirty: true });
      } catch (e) {
        // 落盘失败就不能重试：队列与内存还指着旧 id，硬发只会再撞一次
        boardScope.reportPersistFailure('id-remap', e);
        dispatchConflictEvent(
          board.id,
          body?.error || '画板内容与另一块画板标识冲突，未能保存到云端',
          undefined,
          code
        );
        return 'rejected';
      }
      // 基线不清理：让差分把旧 id 当成本次删除上行，服务端按 canvas 作用域给它们落墓碑。
      // 旧 id 属于**别的**画板时那些墓碑无行可更（作用域是本板），不会伤到对方——
      // 跨板搬节点本就被 WHERE canvas_id = EXCLUDED.canvas_id 挡死。
      dispatchIdsRemappedEvent(board.id);
      return syncBoardToBackendInner(next, opts, true);
    }

    // 与 403/404 同一条口径：永久失败不该被静默重试。toast 让用户知道这次没存上，
    // 顶栏转 'error'（文案「同步失败，已停止自动重试」）；本地改动仍在 blob 里，没丢。
    dispatchConflictEvent(board.id, body?.error || '画板内容被服务端拒绝，未能保存到云端', undefined, code);
    return 'rejected';
  }

  if (res.ok) {
    const body = await res.json().catch(() => null) as any;
    // 载入已在本次请求之后采用过服务端内容：本次回包属于旧纪元，它的快照不能再推进基线
    // （否则会把刚重置成服务端状态的基线打回旧值，之后所有差分都是错的）。
    // 请求本身已发出无法撤回，但结果按「已作废」处理即可。
    if (currentContentEpoch(board.id) !== epochAtSend) return 'ok';
    if (body?.canvas?.updatedAt) {
      board.serverUpdatedAt = body.canvas.updatedAt;
      persistServerUpdatedAt(board.id, body.canvas.updatedAt);
    }
    // 基线推进为**本次已上行的那份快照**（不是当前画面）：飞行期间用户又改的那些，
    // 与基线仍然不同，会被下一轮保存照常上行。反过来用当前画面推基线就会漏掉它们。
    boardOps.advanceBase(board.id, board);
    // 服务端已确认：列表条目按**服务端回包**落定（云优先——本地投影只代表「我以为的」，
    // 拿它顶替服务端条目会让「他端改名 + 本端保存」把列表名永久停在旧值上）。
    boardStore.confirmServerSave(board.id, {
      title: body?.canvas?.title,
      nodeCount: body?.canvas?.nodeCount,
      updatedAt: body?.canvas?.updatedAt,
    });
    // 墓碑守卫拒绝的 id（删除胜出）：本次不算冲突，但要让观测看得见
    const ignored = Array.isArray(body?.canvas?.ignoredNodeIds) ? body.canvas.ignoredNodeIds.length : 0;
    if (ignored > 0) trackEvent('canvas_merge_ignored', { count: ignored });
    return 'ok';
  }
  return 'fail';
}

/** 仅更新本地记录的 serverUpdatedAt（不触发再次入队）；写独立小键，避免整板重读重写 */
function persistServerUpdatedAt(boardId: string, serverUpdatedAt: string): void {
  try {
    localStorage.setItem(`${SERVER_TS_PREFIX}${boardId}`, serverUpdatedAt);
  } catch (e) {
    console.error('Failed to persist serverUpdatedAt:', e);
  }
}

// ---- 重试队列接线（Spec A5）----
setSyncExecutor(async (boardId, opts) => {
  if (boardStore.getState().tombstones.has(boardId)) return 'ok'; // 已删除，勿复活
  const board = loadBoard(boardId);
  if (!board) return 'ok'; // 本地已无该画布，视为完成
  const localVersion = board.updatedAt;
  const outcome = await syncBoardToBackend(board, opts); // 成功路径内部已按服务端回包确认条目
  if (outcome === 'ok') {
    quotaStore.confirmCreate(boardId);
    // 同步期间本地又被编辑过：以新数据重新入队，避免"标记已同步但云端是旧数据"。
    // 比的是**本地内容版本**（blob 的 updatedAt），不是列表 meta——列表 meta 现在拿服务端时间，
    // 与本地版本不同源，拿它比会每次保存都误判成「飞行期间又被改过」而空转重入队。
    const latestVersion = loadBoard(boardId)?.updatedAt;
    if (latestVersion !== undefined && latestVersion !== localVersion) {
      enqueue(boardId);
    }
  }
  return outcome;
});

// ---- 删除执行器：乐观本地删除 + 后台确认，防复活 ----
setDeleteExecutor(async (boardId, opts) => {
  // 纯本地草稿 / 从未同步：无需请求服务端
  if (!boardScope.hasServerVersion(boardId)) {
    boardStore.confirmServerDelete(boardId);
    return 'ok';
  }
  let res: Response;
  try {
    res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}`, {
      method: 'DELETE',
      credentials: 'include',
      keepalive: opts?.keepalive === true,
    });
  } catch {
    return 'fail'; // 网络失败：保留墓碑，稍后重试
  }
  if (res.ok || res.status === 404) {
    boardStore.confirmServerDelete(boardId);
    quotaStore.confirmDelete();
    quotaStore.unmarkPendingCreate(boardId);
    return 'ok';
  }
  if (res.status === 401) {
    boardStore.restoreFromTombstone(boardId); // 回滚，画板重新可见
    dispatchConflictEvent(boardId, '登录状态已失效，请重新登录后再删除画板', undefined, 'UNAUTHORIZED');
    return 'conflict';
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null) as any;
    boardStore.restoreFromTombstone(boardId);
    dispatchConflictEvent(boardId, body?.error || '无权删除此画板', undefined, body?.code || 'CANVAS_FORBIDDEN');
    return 'conflict';
  }
  return 'fail';
});

// ---- 元数据执行器（Spec L1）：收藏/归档走轻量 PATCH，不与内容上传耦合 ----
setMetaExecutor(async (boardId, opts) => {
  if (boardStore.getState().tombstones.has(boardId)) return 'ok'; // 已删除，勿同步
  const meta = boardStore.getBoardList().find((b) => b.id === boardId);
  if (!meta) return 'ok'; // 本地已无该画板
  // 纯本地草稿 / 从未同步：服务端无行可 PATCH，元数据保留在本地索引
  if (!boardStore.getState().serverIds.has(boardId) && !boardScope.hasServerVersion(boardId)) {
    return 'ok';
  }

  let res: Response;
  try {
    res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: opts?.keepalive === true,
      body: JSON.stringify({
        title: meta.name,
        isFavorite: meta.isFavorite ?? false,
        isArchived: meta.isArchived ?? false,
        // Spec Q1：画板级灵感开关随 meta 通道同步（本地只作离线缓存/绘制，服务端为准）
        suggestionsEnabled: meta.suggestionsEnabled ?? true,
        folderId: meta.folderId ?? null,
      }),
    });
  } catch {
    return 'fail'; // 网络失败：交队列退避重试
  }

  if (res.ok) {
    const body = await res.json().catch(() => null) as any;
    // 服务端回包收敛权威字段；updatedAt（触发器推进）写回版本小键，供内容保存推进乐观锁
    boardStore.confirmServerMeta(boardId, body?.canvas || {});
    if (body?.canvas?.updatedAt) persistServerUpdatedAt(boardId, body.canvas.updatedAt);
    return 'ok';
  }
  if (res.status === 404) {
    const body = await res.json().catch(() => null) as any;
    boardStore.reconcileRemoteDeletion(boardId);
    dispatchConflictEvent(boardId, body?.error || '画板已在其他设备被删除', undefined, 'NOT_FOUND');
    return 'conflict';
  }
  if (res.status === 401) {
    dispatchConflictEvent(boardId, '登录状态已失效，请重新登录后再同步画板设置', undefined, 'UNAUTHORIZED');
    return 'conflict';
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null) as any;
    dispatchConflictEvent(boardId, body?.error || '画板设置同步被拒绝', undefined, body?.code || 'CANVAS_FORBIDDEN');
    return 'conflict';
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null) as any;
    // 分组已不存在/不属于属主（他端删除的竞态）：清本地陈旧归属，作永久冲突不再重试
    if (body?.code === 'FOLDER_INVALID') {
      boardStore.updateMetaLocal(boardId, { folderId: null });
    }
    dispatchConflictEvent(boardId, body?.error || '画板设置无效', undefined, body?.code || 'VALIDATION_ERROR');
    return 'conflict';
  }
  return 'fail';
});

/**
 * 乐观删除：本地立即隐藏（墓碑）并后台确认。
 * - 游客/纯本地草稿：直接清理，不请求服务端（修「未登录无法删板」）
 * - 服务端画板：入删除队列，2xx/404 后清理；403/401 回滚
 */
export function deleteBoardLocally(boardId: string): { needsServer: boolean } {
  dequeue(boardId); // 取消待上传，防删除后被保存写回
  quotaStore.unmarkPendingCreate(boardId);
  if (!boardScope.hasServerVersion(boardId)) {
    boardStore.confirmServerDelete(boardId);
    return { needsServer: false };
  }
  boardStore.addTombstone(boardId);
  enqueueDelete(boardId);
  return { needsServer: true };
}

/** 画布保存入队：断网/失败自动退避重试，恢复网络立即补传 */
export function enqueueBoardSync(boardId: string): void {
  enqueue(boardId);
}

/**
 * Spec L1：本地更新画板库元数据（收藏/归档/改名）并后台 PATCH 同步。
 * 只动列表索引，不写内容 blob、不入 upload 队列——避免元数据变更触发整板上传。
 */
export function updateBoardMetaLocally(
  boardId: string,
  patch: { name?: string; isFavorite?: boolean; isArchived?: boolean; suggestionsEnabled?: boolean; folderId?: string | null }
): void {
  boardStore.updateMetaLocal(boardId, patch);
  enqueueMeta(boardId);
}

/**
 * 画布载入的唯一入口：**以服务端为准，取到就一律采用**（ADR-0025）。
 *
 * 三种结果：
 * - GET 2xx → 覆盖本地内容（含未上行的本机改动，这是明确接受的代价）、把差分基线重置成
 *   服务端状态、清未同步标记，并作废在途保存（`bumpContentEpoch`）。
 * - GET 404 → 返回 null，调用方**保留本地**：服务端没有这一行（纯本地草稿 / 首次保存还没
 *   落库的新板），本机就是唯一副本，不能拿「空」去覆盖。
 * - 非 2xx / 网络失败 → 返回 null，调用方保留本地画面；拿不到服务端内容就无从采用。
 */
export async function fetchBoardFromServer(boardId: string): Promise<StoredBoard | null> {
  let branch: 'adopt' | 'notfound' | 'offline' = 'offline';
  try {
    const res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      branch = res.status === 404 ? 'notfound' : 'offline';
      trackEvent('canvas_load', { branch });
      return null;
    }
    const data = await res.json() as any;
    if (!data?.id) {
      trackEvent('canvas_load', { branch: 'offline' });
      return null;
    }

    const board: StoredBoard = {
      id: data.id,
      name: data.title || '未命名思维探索',
      updatedAt: Date.parse(data.updatedAt) || Date.now(),
      viewport: data.viewport || { x: 0, y: 0, zoom: 1 },
      nodes: deduplicateNodes(data.nodes || []),
      edges: deduplicateEdges(data.edges || []),
      serverUpdatedAt: data.updatedAt,
    };
    try {
      persistBoard(board, { dirty: false });
      persistServerUpdatedAt(board.id, board.serverUpdatedAt!);
      // 基线重置为服务端刚回的这份内容。不变式：基线必须是「本地画面所继承的那份状态」——
      // 本设备未知的他端节点此刻都进了本地，下次保存才不会把它们算成「本地删除」。
      boardOps.writeBase(board.id, boardOps.baseFromServerPayload(data));
      boardStore.markDirty(board.id, false);
      // 作废在途保存：它带着采用之前的旧快照，回包会把基线打回旧值（见 contentEpoch 注释）。
      bumpContentEpoch(board.id);
    } catch (e) {
      // 服务端内容已取到，只是离线副本写不下去（配额/隐私模式）：不阻断本次打开，但要上报
      boardScope.reportPersistFailure('board-hydrate', e);
    }
    branch = 'adopt';
    trackEvent('canvas_load', { branch });
    return board;
  } catch (e) {
    trackEvent('canvas_load', { branch });
    return null;
  }
}

/**
 * Spec A2：从服务端拉取画板列表（跨设备登录后恢复画板清单）并水合 board-store。失败 → null。
 */
export async function fetchBoardListFromServer(): Promise<DeepDiveBoardMeta[] | null> {
  try {
    const res = await fetch('/api/canvases', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    if (!Array.isArray(data)) return null;
    const list: DeepDiveBoardMeta[] = data.map((c) => ({
      id: c.id,
      name: c.title || '未命名思维探索',
      updatedAt: Date.parse(c.updatedAt) || 0,
      nodeCount: c.nodeCount || 0,
      isFavorite: Boolean(c.isFavorite),
      isArchived: Boolean(c.isArchived),
      // Spec Q1：服务端缺省视为「开」（列 DEFAULT TRUE），与仓储的 ?? true 同口径
      suggestionsEnabled: c.suggestionsEnabled !== false,
      folderId: c.folderId ?? null,
      // 授权口径以服务端为准（ADR-0018）：缺字段（旧服务端）即按「非共享」处理，
      // 与 private 模式同向——比反过来把用户的私有板当成共享板、锁掉收藏入口要安全。
      isShared: Boolean(c.isShared),
    }));
    boardStore.hydrateFromServer(list); // 写通本地索引（修列表缩水）
    return list;
  } catch (e) {
    return null;
  }
}

export function exportBoardToJson(board: StoredBoard): void {
  const jsonStr = JSON.stringify(board, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${board.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.deepdive.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportBoardToMarkdown(board: StoredBoard): void {
  let md = `# ${board.name}\n\n*导出时间: ${new Date(board.updatedAt).toLocaleString()}*\n\n---\n\n`;

  board.nodes.forEach((node, index) => {
    if (node.type === 'chat') {
      const data = node.data as unknown as ChatNodeData;
      const depth = data.depth || 0;
      const heading = '#'.repeat(Math.min(depth + 2, 6));
      md += `${heading} 节点 ${index + 1}: ${data.title}\n\n`;
      if (data.branchTriggerPhrase) {
        md += `> 🌿 深入切入点: *"${data.branchTriggerPhrase}"*\n\n`;
      }
      data.messages.forEach((msg) => {
        md += `**[${msg.role === 'user' ? '提问 (User)' : '思考 (AI)'}]**\n\n${msg.content}\n\n`;
      });
      md += '\n---\n\n';
    }
  });

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${board.name.replace(/\s+/g, '_')}_outline.md`;
  a.click();
  URL.revokeObjectURL(url);
}
