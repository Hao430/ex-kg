/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Node, Edge } from '@xyflow/react';
import { DeepDiveBoardMeta, ChatNodeData } from '../types';
import { enqueue, dequeue, setSyncExecutor } from './sync-queue';

const STORAGE_BOARDS_INDEX_KEY = 'deepdive_boards_index_v1';
const LEGACY_STORAGE_BOARDS_INDEX_KEY = 'rabbithole_boards_index_v1';
const STORAGE_BOARD_PREFIX = 'deepdive_board_';
const LEGACY_STORAGE_BOARD_PREFIX = 'rabbithole_board_';
/** serverUpdatedAt 独立小键：保存成功后免整板 JSON parse/stringify（性能优化） */
const SERVER_TS_PREFIX = 'deepdive_board_server_ts_';

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

export function loadBoardList(): DeepDiveBoardMeta[] {
  try {
    const raw = localStorage.getItem(STORAGE_BOARDS_INDEX_KEY) || localStorage.getItem(LEGACY_STORAGE_BOARDS_INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load boards index:', e);
    return [];
  }
}

export function saveBoardList(boards: DeepDiveBoardMeta[]): void {
  try {
    localStorage.setItem(STORAGE_BOARDS_INDEX_KEY, JSON.stringify(boards));
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
    persistBoard(cleanedBoard);
    // Asynchronously sync to backend (PostgreSQL) via retry queue (Spec A5)
    enqueueBoardSync(cleanedBoard.id);
  } catch (e) {
    console.error(`Failed to save board ${board.id}:`, e);
  }
}

/** 纯本地持久化（写画布记录 + 更新索引），不触发服务端入队 */
function persistBoard(cleanedBoard: StoredBoard): void {
  // 兜底合并：调用点构造的 StoredBoard 不携带 serverUpdatedAt 时，从权威小键读回注入，
  // 防止覆写 blob 抹掉内嵌版本号（App 层各 saveBoard 调用点均不传该字段）
  if (!cleanedBoard.serverUpdatedAt) {
    const serverTs = localStorage.getItem(`${SERVER_TS_PREFIX}${cleanedBoard.id}`);
    if (serverTs) cleanedBoard.serverUpdatedAt = serverTs;
  }
  localStorage.setItem(
    `${STORAGE_BOARD_PREFIX}${cleanedBoard.id}`,
    JSON.stringify(cleanedBoard)
  );
  // Update index
  const list = loadBoardList();
  const existingIndex = list.findIndex((b) => b.id === cleanedBoard.id);
  const meta: DeepDiveBoardMeta = {
    id: cleanedBoard.id,
    name: cleanedBoard.name,
    updatedAt: cleanedBoard.updatedAt,
    nodeCount: cleanedBoard.nodes.length,
  };
  if (existingIndex >= 0) {
    list[existingIndex] = meta;
  } else {
    list.unshift(meta);
  }
  saveBoardList(list);
}

/**
 * Sync board to backend API（三态：ok / conflict / fail，供重试队列判定）
 * - 携带 serverUpdatedAt 作为乐观锁版本（Spec A4）
 * - 409 冲突静默自愈：用响应的 latest_updated_at 推进版本号、原样重发本地内容
 *   （本地版胜出、覆盖服务端，用户无感知）；上限 MAX_CONFLICT_ATTEMPTS 次，
 *   耗尽或响应异常（解析失败/缺 latest_updated_at）才派发 deepdive:canvas-save-conflict
 *   事件（App 层 toast 提示）。收到合法 latest 的瞬间即落小键，即使本轮后续失败，
 *   下轮队列重跑也已携带新鲜版本。
 */
/** 409 静默自愈的总尝试次数（含首次） */
const MAX_CONFLICT_ATTEMPTS = 3;

/** 冲突/失败提示事件统一派发（detail 形状向后兼容，App 层只读 message） */
function dispatchConflictEvent(boardId: string, message?: string, latestUpdatedAt?: string): void {
  window.dispatchEvent(
    new CustomEvent('deepdive:canvas-save-conflict', {
      detail: {
        boardId,
        message,
        latestUpdatedAt,
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
      dispatchConflictEvent(board.id, '登录状态已失效，请重新登录后再保存画板');
      return 'conflict';
    }

    // 配额/权限类 403 为永久失败，重试无意义——直接提示（Spec B1/B4）
    if (res.status === 403) {
      const body = await res.json().catch(() => null) as any;
      dispatchConflictEvent(board.id, body?.error || '画板保存被拒绝');
      return 'conflict';
    }

    // 409 冲突：静默自愈（本地版胜出）
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as any;
      const latest = body?.latest_updated_at;
      // 降级 1：latest 缺失/非法 → 退回提示路径，不重试
      if (typeof latest !== 'string' || !latest) {
        dispatchConflictEvent(board.id, body?.error || '画板已在其他窗口被修改');
        return 'conflict';
      }
      // 立即落服务端事实版本：即使本轮重试失败，下轮 executor 重跑也已带新鲜版本
      board.serverUpdatedAt = latest;
      persistServerUpdatedAt(board.id, latest);
      // 降级 2：重试耗尽 → 退回提示路径
      if (attempt === MAX_CONFLICT_ATTEMPTS) {
        dispatchConflictEvent(board.id, body?.error || '画板已在其他窗口被修改', latest);
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
  const board = loadBoard(boardId);
  if (!board) return 'ok'; // 本地已无该画布，视为完成
  const localVersion = board.updatedAt;
  const outcome = await syncBoardToBackend(board);
  // 同步期间本地又被编辑过：以新数据重新入队，避免"标记已同步但云端是旧数据"
  //（走索引元数据比对，免整板 parse；索引缺失的 legacy 板回退整板比对）
  if (outcome === 'ok') {
    const meta = loadBoardList().find((b) => b.id === boardId);
    const latestVersion = meta
      ? meta.updatedAt
      : loadBoard(boardId)?.updatedAt;
    if (latestVersion !== undefined && latestVersion !== localVersion) {
      enqueue(boardId);
    }
  }
  return outcome;
});

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
    persistBoard(board);
    // 同步刷新权威小键：刷新/切板即重置版本源，斩断「冲突 → 小键停留旧值 → 保存再 409」死锁
    persistServerUpdatedAt(board.id, board.serverUpdatedAt!);
    return board;
  } catch (e) {
    return null;
  }
}

/**
 * Spec A2：从服务端拉取画板列表（跨设备登录后恢复画板清单）。失败 → null。
 */
export async function fetchBoardListFromServer(): Promise<DeepDiveBoardMeta[] | null> {
  try {
    const res = await fetch('/api/canvases', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    if (!Array.isArray(data)) return null;
    return data.map((c) => ({
      id: c.id,
      name: c.title || '未命名思维探索',
      updatedAt: Date.parse(c.updatedAt) || 0,
      nodeCount: c.nodeCount || 0,
    }));
  } catch (e) {
    return null;
  }
}

/**
 * 删除画板（H1 竞态修复）：服务端为真源——仅当删除被确认（2xx）或画布从未同步/已不存在（404）
 * 才清理本地缓存、索引并移除待同步任务；403/5xx/断网时保留本地并返回失败，
 * 由调用方提示用户（否则远端画板会在下次拉取列表时「复活」，与「无法撤销」承诺矛盾）。
 */
export async function deleteBoard(boardId: string): Promise<{ ok: boolean; status?: number }> {
  let status = 0;
  let networkFail = false;
  try {
    const res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    status = res.status;
  } catch (e) {
    networkFail = true;
  }
  if (networkFail || (status >= 300 && status !== 404)) {
    return { ok: false, status: networkFail ? 0 : status };
  }
  dequeue(boardId); // 移除待同步任务，杜绝删除后自动保存把画板写回远端
  try {
    localStorage.removeItem(`${STORAGE_BOARD_PREFIX}${boardId}`);
    localStorage.removeItem(`${LEGACY_STORAGE_BOARD_PREFIX}${boardId}`);
    localStorage.removeItem(`${SERVER_TS_PREFIX}${boardId}`);
    saveBoardList(loadBoardList().filter((b) => b.id !== boardId));
  } catch (e) {}
  return { ok: true };
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
