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
import type { SyncExecOpts } from './sync-queue';
import * as boardScope from './board-scope';
import * as boardStore from './board-store';
import * as boardOps from './board-ops';
import * as quotaStore from './quota-store';
import { trackEvent } from './analytics';
import { uuidv7 } from './uuid';

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
 * - 携带 serverUpdatedAt 作为乐观锁版本（Spec A4）
 * - 409 冲突**不再自愈**：服务端本就正确检测到了冲突，是客户端在否决它。
 *   旧行为（本地版胜出）的机理与代价见 `preserveLocalAsConflictCopy` 注释。
 * - 403/404 带 code：BOARD_LIMIT_REACHED/VIP_EXPIRED 保留草稿待升级；NOT_FOUND 收敛幽灵板。
 */

/**
 * keepalive 请求体上限：浏览器对 keepalive/sendBeacon 有 ~64KB 限制，超限会直接抛错。
 * 大画板（长对话、多节点）超限时不发这次请求，留在持久化队列里下次启动续跑，不冒险丢。
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/** 冲突副本命名后缀 */
const CONFLICT_COPY_SUFFIX = ' (冲突副本)';

/** 冲突副本复用表键：源画板 id → 副本 id（持久化，防重试/刷新后重复堆积副本） */
function conflictCopyKey(boardId: string): string {
  return `deepdive_conflict_copy_${boardId}`;
}

function readConflictCopyId(boardId: string): string | null {
  try {
    return localStorage.getItem(conflictCopyKey(boardId));
  } catch {
    return null;
  }
}

function rememberConflictCopy(boardId: string, copyId: string | null): void {
  try {
    if (copyId) localStorage.setItem(conflictCopyKey(boardId), copyId);
    else localStorage.removeItem(conflictCopyKey(boardId));
  } catch {
    /* ignore */
  }
}

/**
 * 冲突收敛之一：把本地未同步版另存为一块新画板「(冲突副本)」，用户的改动不丢。
 *
 * 同一轮冲突复用同一个副本 id（重试期间的编辑刷新副本内容），不重复堆积新画板；
 * 源画板保存成功后清空复用表，下一次冲突才另起一块。
 *
 * @returns 副本 id；本地无内容或落盘失败返回 null
 */
function preserveLocalAsConflictCopy(boardId: string): string | null {
  const local = loadBoard(boardId);
  if (!local) return null;
  const copyId = readConflictCopyId(boardId) ?? uuidv7();
  const copy: StoredBoard = {
    id: copyId,
    name: `${local.name}${CONFLICT_COPY_SUFFIX}`,
    updatedAt: Date.now(),
    nodes: local.nodes,
    edges: local.edges,
    viewport: local.viewport,
    // 刻意不继承 serverUpdatedAt：副本是全新画板，首次上传走新建
    //（带上源画板的版本号会被服务端判 409）
  };
  try {
    persistBoard(copy, { dirty: true });
  } catch (e) {
    boardScope.reportPersistFailure('conflict-copy', e);
    return null;
  }
  rememberConflictCopy(boardId, copyId);
  enqueue(copyId); // 后台补传，失败走退避重试
  return copyId;
}

export interface AdoptResult {
  /** true = 调用方可以拿服务端内容覆盖画面 */
  adopt: boolean;
  /** 本轮把本地未同步版另存了副本时给出副本 id，供上层明确告知用户（不要静默挪走改动） */
  conflictCopyId?: string;
}

/**
 * 采用服务端版本前的冲突裁决（页面加载/切换路径用）。
 *
 * 本地 dirty 有两种成因，必须区分开：
 * - **本地领先**：只是还没传上去（服务端 updatedAt 仍等于本地记录的基线）→ 保留本地等上传。
 *   此时拿服务端内容覆盖，会直接抹掉用户刚做的改动。
 * - **真冲突**：服务端已被他端推进（基线对不上）→ 本地版另存冲突副本，再采用服务端版。
 *
 * @param opts.force 已知服务端刚以 409 否决了本地基线，不必再比对基线（保存路径用）
 */
export function adoptServerVersion(
  serverBoard: StoredBoard,
  opts?: { force?: boolean }
): AdoptResult {
  const id = serverBoard.id;
  if (!boardStore.isDirty(id) && !opts?.force) return { adopt: true }; // 无未同步改动，已由 fetchBoardFromServer 落盘
  if (!opts?.force) {
    const base = loadBoard(id)?.serverUpdatedAt;
    // 从未同步过（纯本地草稿）或基线一致：本地领先，保留本地等上传
    if (!base || base === serverBoard.serverUpdatedAt) return { adopt: false };
  }
  const conflictCopyId = preserveLocalAsConflictCopy(id) ?? undefined; // 必须先于覆盖——读的是本地未同步内容
  try {
    persistBoard(serverBoard, { dirty: false });
    if (serverBoard.serverUpdatedAt) persistServerUpdatedAt(id, serverBoard.serverUpdatedAt);
  } catch (e) {
    // 落盘失败则本地副本仍是旧内容，此时采用服务端版会让下次保存把旧内容推上去覆盖云端 → 不采用
    boardScope.reportPersistFailure('board-adopt', e);
    return { adopt: false, conflictCopyId };
  }
  boardStore.markDirty(id, false);
  // 本地画面此刻就是服务端这份内容，基线跟着对齐（不变量：基线 = 本地画面继承的那份状态）。
  // 不对齐的话，下次保存会把「服务端这段时间的改动」整批当成本设备改动重推一遍。
  boardOps.advanceBase(id, serverBoard);
  return { adopt: true, conflictCopyId };
}

/** keepalive 体积按真实 UTF-8 字节数判断（中文正文下 字符数 与 字节数 差 3 倍） */
const utf8 = new TextEncoder();

/** 冲突/失败提示事件统一派发（detail 向后兼容，新增 code / conflictCopyId 字段） */
function dispatchConflictEvent(
  boardId: string,
  message?: string,
  latestUpdatedAt?: string,
  code?: string,
  conflictCopyId?: string
): void {
  window.dispatchEvent(
    new CustomEvent('deepdive:canvas-save-conflict', {
      detail: {
        boardId,
        message,
        latestUpdatedAt,
        code,
        conflictCopyId,
      },
    })
  );
}

export async function syncBoardToBackend(
  board: StoredBoard,
  opts?: SyncExecOpts
): Promise<'ok' | 'conflict' | 'fail'> {
  const keepalive = opts?.keepalive === true;

  // 差分基线 = 本设备已知与服务端一致的那份内容。缺失时补一次（升级到本版、或基线键被清）
  let base = boardOps.readBase(board.id);
  if (!base) {
    // 页面卸载补传不做额外 GET；此刻也**绝不能**退化成整板 upsert——那正是
    // 「挂机设备覆盖他人改动」的机理。留在持久化队列里下次启动续跑。
    if (keepalive) return 'fail';
    base = await boardOps.seedBaseFromServer(board.id);
  }
  const ops = boardOps.computeOps(base, board);
  if (boardOps.isEmptyOps(ops)) {
    // 没有任何会被持久化的字段真的变了 → 不发请求。
    // 打开画板时 React Flow 会给每个节点发一次 dimensions（不进投影），旧实现在这里会平白
    // 整板重传一次——「别人正在编辑，我这边一打开就把他覆盖掉」的成因之一。
    return 'ok';
  }

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

  // 409 冲突：服务端为准。本地未同步版另存「(冲突副本)」，原画板采用服务端当前内容。
  if (res.status === 409) {
    // 卸载前的补传不做决策：这里要再发一次 GET 取服务端内容，而页面正在消失——
    // keepalive 请求有体积上限，此刻也不该改本地状态。留给下次启动的正常链路。
    if (keepalive) return 'fail';
    const body = await res.json().catch(() => null) as any;
    const latest = typeof body?.latest_updated_at === 'string' && body.latest_updated_at
      ? body.latest_updated_at
      : undefined;
    const serverBoard = await fetchBoardFromServer(board.id);
    // force：服务端刚以 409 否决了本地基线，这一定是真冲突，不必再比对基线
    const adopted = serverBoard ? adoptServerVersion(serverBoard, { force: true }) : null;
    // 副本 id 由 adoptServerVersion 直接给出（force 路径必定尝试另存），失败时为 undefined
    const copyId = adopted?.adopt ? adopted.conflictCopyId ?? readConflictCopyId(board.id) : null;
    trackEvent('canvas_save_conflict', { adopted: adopted?.adopt ? 1 : 0 });
    dispatchConflictEvent(
      board.id,
      body?.error || '画板已在其他窗口被修改',
      latest,
      'CANVAS_SAVE_CONFLICT',
      copyId ?? undefined
    );
    // 采用失败（多为取不到服务端内容）→ 保留本地脏状态交退避重试，副本按源画板复用不会堆积
    return adopted?.adopt ? 'conflict' : 'fail';
  }

  if (res.ok) {
    const body = await res.json().catch(() => null) as any;
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
    rememberConflictCopy(board.id, null); // 保存成功：本次冲突了结，下次冲突另起一块副本
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
  patch: { name?: string; isFavorite?: boolean; isArchived?: boolean; folderId?: string | null }
): void {
  boardStore.updateMetaLocal(boardId, patch);
  enqueueMeta(boardId);
}

/**
 * Spec A2：画布加载走服务端（服务端为真源）。
 * GET /api/canvases/:id 成功 → 映射为 StoredBoard 并写本地缓存/索引；404（从未同步）或网络失败 → null（调用方回退本地）。
 */
export async function fetchBoardFromServer(boardId: string): Promise<StoredBoard | null> {
  try {
    const res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data?.id) return null;

    const board: StoredBoard = {
      id: data.id,
      name: data.title || '未命名思维探索',
      updatedAt: Date.parse(data.updatedAt) || Date.now(),
      viewport: data.viewport || { x: 0, y: 0, zoom: 1 },
      nodes: deduplicateNodes(data.nodes || []),
      edges: deduplicateEdges(data.edges || []),
      serverUpdatedAt: data.updatedAt,
    };
    // 本地有未同步改动时不覆盖内容（本地版胜出，避免抹掉离线编辑）
    if (!boardStore.isDirty(board.id)) {
      try {
        persistBoard(board, { dirty: false });
        persistServerUpdatedAt(board.id, board.serverUpdatedAt!);
        // 基线 = 服务端刚回的这份内容。**只在真的采用它时才推进**，这是一条不变式：
        // 基线必须是「本地画面所继承的那份状态」。本地有未同步改动而此处不采用时，本地
        // 画面继承的是更早那份基线，此刻把基线换成服务端版本，本设备缺的那些他端节点就会
        // 在下次保存时被算成「本地删除」，反手把他人的内容删掉。
        // （采用服务端版本的路径由 adoptServerVersion 推进基线。）
        boardOps.writeBase(board.id, boardOps.baseFromServerPayload(data));
      } catch (e) {
        // 服务端内容已取到，只是离线副本写不下去（配额/隐私模式）：不阻断本次打开，但要上报
        boardScope.reportPersistFailure('board-hydrate', e);
      }
    }
    return board;
  } catch (e) {
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
      folderId: c.folderId ?? null,
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
