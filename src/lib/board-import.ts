/**
 * Spec M1 — JSON 备份导入（纯函数核心）；Spec M2 起 id 重映射复用 board-remap。
 *
 * 导出的 `StoredBoard` 携带原始 id，而服务端 nodes.id / edges.id 是全局主键
 * （schema.ts），saveCanvas 先按 canvas_id 清表再按 id 插入——原样导入会与原
 * 画板撞主键。故本模块对不可信文件做校验与内容归一化后，交给 `remapBoardIds`
 * 完成全量 id 重映射。
 *
 * 纯输入输出：不触碰 localStorage / 网络；id 与时钟可注入以保证测试确定性。
 */
import { z } from 'zod';
import type { Node, Edge } from '@xyflow/react';
import type { StoredBoard } from './storage.js';
import { uuidv7 } from './uuid.js';
import { remapBoardIds } from './board-remap.js';

/** 文件体积上限（UI 读文件前用 File.size 预检；解析器不感知字节数） */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_NODES = 300;
export const MAX_IMPORT_EDGES = 600;
export const DEFAULT_IMPORT_BOARD_NAME = '导入的画板';
/** 单边原 id 上限：仅用于去重映射，无需与主键长度严格一致 */
const RAW_ID_MAX = 200;
const BOARD_NAME_MAX = 120;

export type ImportErrorCode =
  | 'FILE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_SHAPE'
  | 'EMPTY'
  | 'TOO_MANY_NODES'
  | 'TOO_MANY_EDGES';

export interface ImportOk {
  ok: true;
  board: StoredBoard;
  stats: { nodes: number; edges: number; droppedEdges: number };
}
export interface ImportErr {
  ok: false;
  code: ImportErrorCode;
  error: string;
}
export type ImportResult = ImportOk | ImportErr;

export interface ParseOptions {
  /** 注入 id 生成器（测试注入计数器；默认 uuidv7） */
  generateId?: () => string;
  /** 注入时钟（默认 Date.now） */
  now?: () => number;
}

const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

const RawNodeSchema = z.object({
  id: z.string().min(1).max(RAW_ID_MAX),
  type: z.string().optional(),
  position: PositionSchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const RawEdgeSchema = z.object({
  id: z.string().min(1).max(RAW_ID_MAX),
  source: z.string().min(1).max(RAW_ID_MAX),
  target: z.string().min(1).max(RAW_ID_MAX),
  type: z.string().optional(),
  animated: z.boolean().optional(),
  style: z.unknown().optional(),
  markerEnd: z.unknown().optional(),
  label: z.string().optional(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});

const ViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite(),
});

type NormalizedType = 'chat' | 'note';

function err(code: ImportErrorCode, error: string): ImportErr {
  return { ok: false, code, error };
}

/** 未知节点类型向前兼容地归一为 chat；note 原样保留 */
function normalizeType(type: string | undefined): NormalizedType {
  return type === 'note' ? 'note' : 'chat';
}

/** 清洗 messages：剔除 content 非字符串的条目，补齐 id/timestamp，role 归一 */
function sanitizeMessages(
  raw: unknown,
  generateId: () => string,
  now: () => number
): Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = [];
  for (const item of raw) {
    const m = item as Record<string, unknown> | null;
    if (!m || typeof m.content !== 'string') continue;
    out.push({
      id: typeof m.id === 'string' && m.id ? m.id : generateId(),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      timestamp:
        typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)
          ? m.timestamp
          : now(),
    });
  }
  return out;
}

/**
 * 节点 data 归一：清瞬时生成态/只读标记，清洗 messages。
 * parentId 不在本函数处理——由 remapBoardIds 按映射统一改写/剔除。
 */
function sanitizeNodeData(
  raw: unknown,
  type: NormalizedType,
  generateId: () => string,
  now: () => number
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...((raw as Record<string, unknown>) || {}) };
  delete data.readOnly;

  if (data.status === 'generating') {
    data.status = 'idle';
    delete data.errorMessage;
  }

  if (type === 'chat') {
    if (data.status !== 'suggested' && data.status !== 'idle' && data.status !== 'error') {
      data.status = 'idle';
    }
    if (Array.isArray(data.messages)) {
      data.messages = sanitizeMessages(data.messages, generateId, now);
    } else {
      // 非数组的畸形 messages 必须剔除，否则卡片渲染时会抛错
      delete data.messages;
    }
  } else {
    // 便签：标题/正文强制为字符串
    if (typeof data.title !== 'string') data.title = '';
    if (typeof data.content !== 'string') data.content = '';
  }

  return data;
}

/** 父子链环检测（含自指）；parentOf 的键值均为节点 id */
function hasParentCycle(parentOf: Map<string, string>): boolean {
  const done = new Set<string>();
  for (const start of parentOf.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | undefined = start;
    while (cur && !done.has(cur)) {
      if (onPath.has(cur)) return true;
      onPath.add(cur);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    for (const p of path) done.add(p);
  }
  return false;
}

/**
 * 解析并归一化备份文本。
 * 成功返回可直接交给 saveBoard 的 StoredBoard（全新 id、无 serverUpdatedAt）。
 */
export function parseBoardBackup(raw: string, opts?: ParseOptions): ImportResult {
  const generateId = opts?.generateId ?? uuidv7;
  const now = opts?.now ?? Date.now;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err('INVALID_JSON', '文件不是合法的 JSON 备份');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err('INVALID_SHAPE', '备份文件结构不正确');
  }
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.nodes)) {
    return err('INVALID_SHAPE', '备份缺少节点列表');
  }
  if (obj.edges !== undefined && !Array.isArray(obj.edges)) {
    return err('INVALID_SHAPE', '备份的连线列表格式不正确');
  }
  const rawNodes = obj.nodes as unknown[];
  const rawEdges = (obj.edges as unknown[] | undefined) ?? [];

  if (rawNodes.length > MAX_IMPORT_NODES) {
    return err('TOO_MANY_NODES', `单次最多导入 ${MAX_IMPORT_NODES} 个节点`);
  }
  if (rawEdges.length > MAX_IMPORT_EDGES) {
    return err('TOO_MANY_EDGES', `单次最多导入 ${MAX_IMPORT_EDGES} 条连线`);
  }
  if (rawNodes.length === 0) {
    return err('EMPTY', '备份中没有可导入的节点');
  }

  // 逐节点校验 + 去重（同 id 保留首个），暂保留原 id 供 remap 建立映射
  const parsedNodes: Array<{ oldId: string; type: NormalizedType; position: { x: number; y: number }; data: unknown }> = [];
  const seenNodeId = new Set<string>();
  for (const rawNode of rawNodes) {
    const node = RawNodeSchema.safeParse(rawNode);
    if (!node.success) {
      return err('INVALID_SHAPE', '备份中存在格式不正确的节点');
    }
    if (seenNodeId.has(node.data.id)) continue;
    seenNodeId.add(node.data.id);
    parsedNodes.push({
      oldId: node.data.id,
      type: normalizeType(node.data.type),
      position: node.data.position ?? { x: 0, y: 0 },
      data: node.data.data,
    });
  }

  const intermediateNodes: Node[] = parsedNodes.map((p) => ({
    id: p.oldId,
    type: p.type,
    position: p.position,
    data: sanitizeNodeData(p.data, p.type, generateId, now),
  }));

  // 逐边校验，暂保留原 id 与端点；去重/悬挂丢弃交给 remapBoardIds
  const intermediateEdges: Edge[] = [];
  for (const rawEdge of rawEdges) {
    const parsedEdge = RawEdgeSchema.safeParse(rawEdge);
    if (!parsedEdge.success) {
      return err('INVALID_SHAPE', '备份中存在格式不正确的连线');
    }
    const e = parsedEdge.data;
    const next: Edge = { id: e.id, source: e.source, target: e.target, type: e.type ?? 'smoothstep' };
    if (e.animated !== undefined) next.animated = e.animated;
    if (e.style !== undefined) next.style = e.style as Edge['style'];
    if (e.markerEnd !== undefined) next.markerEnd = e.markerEnd as Edge['markerEnd'];
    if (e.label !== undefined) next.label = e.label;
    if (e.sourceHandle !== undefined) next.sourceHandle = e.sourceHandle;
    if (e.targetHandle !== undefined) next.targetHandle = e.targetHandle;
    intermediateEdges.push(next);
  }

  // Spec M2：全量 id 重映射（board/node/edge）由公共模块完成
  const remap = remapBoardIds(intermediateNodes, intermediateEdges, { generateId });
  const nodes = remap.nodes;
  const edges = remap.edges;

  // 父子环校验（服务端 assertAcyclicParentChain 亦会 400，前端提前拦截避免幽灵板）
  const parentOf = new Map<string, string>();
  for (const node of nodes) {
    const pid = (node.data as Record<string, unknown>)?.parentId;
    if (typeof pid === 'string' && pid) parentOf.set(node.id, pid);
  }
  if (hasParentCycle(parentOf)) {
    return err('INVALID_SHAPE', '节点父子关系存在循环，无法导入');
  }

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim().slice(0, BOARD_NAME_MAX)
      : DEFAULT_IMPORT_BOARD_NAME;
  const viewportParsed = ViewportSchema.safeParse(obj.viewport);
  const viewport = viewportParsed.success
    ? viewportParsed.data
    : { x: 0, y: 0, zoom: 1 };

  const board: StoredBoard = {
    id: remap.boardId,
    name,
    updatedAt: now(),
    nodes,
    edges,
    viewport,
  };

  return { ok: true, board, stats: { nodes: nodes.length, edges: edges.length, droppedEdges: remap.droppedEdges } };
}
