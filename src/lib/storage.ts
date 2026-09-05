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

export function loadBoard(boardId: string): StoredBoard | null {
  try {
    const raw =
      localStorage.getItem(`${STORAGE_BOARD_PREFIX}${boardId}`) ||
      localStorage.getItem(`${LEGACY_STORAGE_BOARD_PREFIX}${boardId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to load board ${boardId}:`, e);
    return null;
  }
}

export function saveBoard(board: StoredBoard): void {
  try {
    localStorage.setItem(
      `${STORAGE_BOARD_PREFIX}${board.id}`,
      JSON.stringify(board)
    );
    // Update index
    const list = loadBoardList();
    const existingIndex = list.findIndex((b) => b.id === board.id);
    const meta: DeepDiveBoardMeta = {
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
      nodeCount: board.nodes.length,
    };
    if (existingIndex >= 0) {
      list[existingIndex] = meta;
    } else {
      list.unshift(meta);
    }
    saveBoardList(list);
  } catch (e) {
    console.error(`Failed to save board ${board.id}:`, e);
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
