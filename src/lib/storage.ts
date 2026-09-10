/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 画板本地持久化 + 服务端同步（2026-09-10 重构为 local-first）。
 * - 列表真相移交 board-store（服务端快照 ∪ 本地草稿 − 墓碑）
 * - 同步队列升级为持久化的上传/删除意图队列
 * - 删除改乐观 + 墓碑，游客/纯本地草稿无需服务端
 */
import { Node, Edge } from '@xyflow/react';
import { DeepDiveBoardMeta, ChatNodeData } from '../types';
import { enqueue, dequeue, enqueueDelete, setSyncExecutor, setDeleteExecutor } from './sync-queue';
import * as boardScope from './board-scope';
import * as boardStore from './board-store';
import * as quotaStore from './quota-store';
import { trackEvent } from './analytics';

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
    console.error(`Failed to save board ${board.id}:`, e);
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
  boardStore.upsertLocal(
    {
      id: cleanedBoard.id,
      name: cleanedBoard.name,
      updatedAt: cleanedBoard.updatedAt,
      nodeCount: cleanedBoard.nodes.length,
    },
    { dirty: opts?.dirty !== false }
  );
}

/**
 * Sync board to backend API（三态：ok / conflict / fail，供重试队列判定）
 * - 携带 serverUpdatedAt 作为乐观锁版本（Spec A4）
 * - 409 冲突静默自愈：用响应的 latest_updated_at 推进版本号、原样重发本地内容
 *   （本地版胜出、覆盖服务端，用户无感知）；上限 MAX_CONFLICT_ATTEMPTS 次，
 *   耗尽或响应异常才派发 deepdive:canvas-save-conflict 事件（App 层 toast/弹窗）。
 * - 403/404 带 code：BOARD_LIMIT_REACHED/VIP_EXPIRED 保留草稿待升级；NOT_FOUND 收敛幽灵板。
 */
/** 409 静默自愈的总尝试次数（含首次） */
const MAX_CONFLICT_ATTEMPTS = 3;

/** 冲突/失败提示事件统一派发（detail 向后兼容，新增 code 字段） */
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

export async function syncBoardToBackend(board: StoredBoard): Promise<'ok' | 'conflict' | 'fail'> {
  let expected = board.serverUpdatedAt;
  for (let attempt = 1; attempt <= MAX_CONFLICT_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api/canvases/${encodeURIComponent(board.id)}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: board.name,
          viewport: board.viewport,
          nodes: board.nodes,
          edges: board.edges,
          expectedUpdatedAt: expected,
        }),
      });
    } catch (e) {
      // 网络失败（含自愈重试中途）：交回 sync-queue 退避重试
      return 'fail';
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

    // 409 冲突：静默自愈（本地版胜出）
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as any;
      const latest = body?.latest_updated_at;
      // 降级 1：latest 缺失/非法 → 退回提示路径，不重试
      if (typeof latest !== 'string' || !latest) {
        dispatchConflictEvent(board.id, body?.error || '画板已在其他窗口被修改', undefined, 'CANVAS_SAVE_CONFLICT');
        return 'conflict';
      }
      // 立即落服务端事实版本：即使本轮重试失败，下轮 executor 重跑也已带新鲜版本
      board.serverUpdatedAt = latest;
      persistServerUpdatedAt(board.id, latest);
      // 降级 2：重试耗尽 → 退回提示路径
      if (attempt === MAX_CONFLICT_ATTEMPTS) {
        dispatchConflictEvent(board.id, body?.error || '画板已在其他窗口被修改', latest, 'CANVAS_SAVE_CONFLICT');
        return 'conflict';
      }
      console.warn(
        `[canvas-sync] 409 conflict, retrying with latest server version (${attempt}/${MAX_CONFLICT_ATTEMPTS}) for ${board.id}`
      );
      expected = latest; // 内容不变（本地版胜出），仅推进版本号重发
      continue;
    }

    if (res.ok) {
      const body = await res.json().catch(() => null) as any;
      if (body?.canvas?.updatedAt) {
        board.serverUpdatedAt = body.canvas.updatedAt;
        persistServerUpdatedAt(board.id, body.canvas.updatedAt);
      }
      // 冲突自愈成功埋点（K4 扩展事件，attempt 为冲突发生次数，纯计数无 PII）
      if (attempt > 1) {
        trackEvent('conflict_healed', { attempt });
      }
      return 'ok';
    }
    return 'fail';
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
setSyncExecutor(async (boardId) => {
  if (boardStore.getState().tombstones.has(boardId)) return 'ok'; // 已删除，勿复活
  const board = loadBoard(boardId);
  if (!board) return 'ok'; // 本地已无该画布，视为完成
  const localVersion = board.updatedAt;
  const outcome = await syncBoardToBackend(board);
  if (outcome === 'ok') {
    boardStore.confirmServerSave(boardId);
    quotaStore.confirmCreate(boardId);
    // 同步期间本地又被编辑过：以新数据重新入队，避免"标记已同步但云端是旧数据"
    const meta = boardStore.getBoardList().find((b) => b.id === boardId);
    const latestVersion = meta ? meta.updatedAt : loadBoard(boardId)?.updatedAt;
    if (latestVersion !== undefined && latestVersion !== localVersion) {
      enqueue(boardId);
    }
  }
  return outcome;
});

// ---- 删除执行器：乐观本地删除 + 后台确认，防复活 ----
setDeleteExecutor(async (boardId) => {
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
      persistBoard(board, { dirty: false });
      persistServerUpdatedAt(board.id, board.serverUpdatedAt!);
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
