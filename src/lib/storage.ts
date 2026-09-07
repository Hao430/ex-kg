/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Node, Edge } from '@xyflow/react';
import { DeepDiveBoardMeta, ChatNodeData } from '../types';
import { enqueue, setSyncExecutor } from './sync-queue';

const STORAGE_BOARDS_INDEX_KEY = 'deepdive_boards_index_v1';
const LEGACY_STORAGE_BOARDS_INDEX_KEY = 'rabbithole_boards_index_v1';
const STORAGE_BOARD_PREFIX = 'deepdive_board_';
const LEGACY_STORAGE_BOARD_PREFIX = 'rabbithole_board_';

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
 * - 409 冲突：派发 deepdive:canvas-save-conflict 事件（App 层 toast 提示），不静默覆盖
 */
export async function syncBoardToBackend(board: StoredBoard): Promise<'ok' | 'conflict' | 'fail'> {
  try {
    const res = await fetch(`/api/canvases/${encodeURIComponent(board.id)}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        title: board.name,
        viewport: board.viewport,
        nodes: board.nodes,
        edges: board.edges,
        expectedUpdatedAt: board.serverUpdatedAt,
      }),
    });

    if (res.status === 409) {
      const body = await res.json().catch(() => null) as any;
      window.dispatchEvent(
        new CustomEvent('deepdive:canvas-save-conflict', {
          detail: {
            boardId: board.id,
            message: body?.error || '画板已在其他窗口被修改',
            latestUpdatedAt: body?.latest_updated_at,
          },
        })
      );
      return 'conflict';
    }

    // 401 会话失效（如改密/重置密码后被踢下线）：重试无意义——提示重新登录并停止重试
    if (res.status === 401) {
      window.dispatchEvent(
        new CustomEvent('deepdive:canvas-save-conflict', {
          detail: {
            boardId: board.id,
            message: '登录状态已失效，请重新登录后再保存画板',
          },
        })
      );
      return 'conflict';
    }

    // 配额/权限类 403 为永久失败，重试无意义——直接提示（Spec B1/B4）
    if (res.status === 403) {
      const body = await res.json().catch(() => null) as any;
      window.dispatchEvent(
        new CustomEvent('deepdive:canvas-save-conflict', {
          detail: {
            boardId: board.id,
            message: body?.error || '画板保存被拒绝',
          },
        })
      );
      return 'conflict';
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
  } catch (e) {
    return 'fail';
  }
}

/** 仅更新本地记录的 serverUpdatedAt（不触发再次入队） */
function persistServerUpdatedAt(boardId: string, serverUpdatedAt: string): void {
  try {
    const board = loadBoard(boardId);
    if (!board) return;
    board.serverUpdatedAt = serverUpdatedAt;
    localStorage.setItem(`${STORAGE_BOARD_PREFIX}${boardId}`, JSON.stringify(board));
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
  if (outcome === 'ok') {
    const latest = loadBoard(boardId);
    if (latest && latest.updatedAt !== localVersion) {
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
 * Fetch database connection status from backend
 */
export async function fetchDbStatus(): Promise<{
  connected: boolean;
  type: 'postgresql' | 'in-memory-fallback';
  message: string;
  canvasCount: number;
  nodeCount: number;
  databaseUrlConfigured: boolean;
} | null> {
  try {
    const res = await fetch('/api/db/status');
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
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
