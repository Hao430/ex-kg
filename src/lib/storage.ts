/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Node, Edge } from '@xyflow/react';
import { DeepDiveBoardMeta, ChatNodeData } from '../types';

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
    localStorage.setItem(
      `${STORAGE_BOARD_PREFIX}${board.id}`,
      JSON.stringify(cleanedBoard)
    );
    // Update index
    const list = loadBoardList();
    const existingIndex = list.findIndex((b) => b.id === board.id);
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

    // Asynchronously sync to backend (PostgreSQL)
    syncBoardToBackend(cleanedBoard).catch((err) => {
      console.warn('Background backend sync skipped or failed:', err?.message || err);
    });
  } catch (e) {
    console.error(`Failed to save board ${board.id}:`, e);
  }
}

/**
 * Sync board to backend API
 * - 携带 serverUpdatedAt 作为乐观锁版本（Spec A4）
 * - 409 冲突：派发 deepdive:canvas-save-conflict 事件（App 层 toast 提示），不静默覆盖
 */
export async function syncBoardToBackend(board: StoredBoard): Promise<boolean> {
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
      return false;
    }

    if (res.ok) {
      const body = await res.json().catch(() => null) as any;
      if (body?.canvas?.updatedAt) {
        board.serverUpdatedAt = body.canvas.updatedAt;
      }
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
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
