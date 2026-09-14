/**
 * Spec M2 — 画板 id 重映射（JSON 导入 / 分享克隆 / 冲突副本三条复制路径共用）。
 *
 * 服务端 nodes.id / edges.id 是全局主键。任何「把既有画板复制成新画板」的路径都必须
 * 重映射 id：服务端 `mergeWriteCanvas` 的跨板拦截会拒绝「payload 里的节点 id 已属于
 * 别的画板」，整次保存 400 `NODE_CANVAS_MISMATCH`。漏掉的复制路径**不是保存慢，而是
 * 永远存不上去**——副本只活在本机 localStorage，换设备/清缓存即丢失。
 * 冲突副本曾在 2026-09-14 因此把线上用户的改动困在本机（安全网失效）。
 *
 * 纯函数：不依赖 zod / DOM / 网络，id 可注入。刻意不含 zod，避免克隆路径把校验库
 * 拉进主包（M1 导入侧按需懒加载 zod）。
 */
import type { Node, Edge } from '@xyflow/react';
import { uuidv7 } from './uuid.js';

export interface RemapOptions {
  /**
   * 复用调用方已知的画板 id（冲突副本反复重拍同一块副本时必须保持稳定）；
   * 缺省则由 `generateId()` 新生成——与传入前的行为一致。
   */
  boardId?: string;
  /**
   * 注入 id 生成器（测试注入计数器；默认 uuidv7）。
   *
   * 入参是**旧 id**（节点/边逐个传入；画板 id 不传）。需要「同一旧 id 恒映射到同一新 id」
   * 的调用方（冲突副本复用同一块副本）据此做可重放派生；不关心时忽略入参即可——
   * `uuidv7` 与既有测试里的计数器都是这种，行为与改造前完全一致。
   */
  generateId?: (oldId?: string) => string;
}

export interface RemapResult {
  boardId: string;
  nodes: Node[];
  edges: Edge[];
  droppedEdges: number;
}

/**
 * 为整块画板生成全新 id，并重写节点/边的内部引用。
 * - 节点按原 id 去重（保留首个），两遍扫描以支持 parentId 前向引用
 * - data.parentId 不可达则删除（不保留悬挂父指针）
 * - 边按原 id 去重；端点缺失则丢弃并计入 droppedEdges
 */
export function remapBoardIds(nodes: Node[], edges: Edge[], opts?: RemapOptions): RemapResult {
  const generateId = opts?.generateId ?? uuidv7;
  const boardId = opts?.boardId ?? generateId();

  // 第一遍：节点按原 id 去重（保留首个），随后逐一分配新 id，建立完整 old→new 映射
  const nodeByOldId = new Map<string, Node>();
  for (const node of nodes || []) {
    if (!node || !node.id || nodeByOldId.has(node.id)) continue;
    nodeByOldId.set(node.id, node);
  }
  const oldToNew = new Map<string, string>();
  for (const oldId of nodeByOldId.keys()) oldToNew.set(oldId, generateId(oldId));

  // 第二遍：构造新节点并重写 parentId（此时映射已完整，支持前向引用）
  const mappedNodes: Node[] = [];
  for (const [oldId, node] of nodeByOldId) {
    const newId = oldToNew.get(oldId)!;

    const rawData = node.data;
    if (rawData && typeof rawData === 'object') {
      const data: Record<string, unknown> = { ...(rawData as Record<string, unknown>) };
      const pid = data.parentId;
      const mappedPid = typeof pid === 'string' && pid ? oldToNew.get(pid) : undefined;
      if (mappedPid) data.parentId = mappedPid;
      else delete data.parentId;
      mappedNodes.push({ ...node, id: newId, data });
    } else {
      mappedNodes.push({ ...node, id: newId });
    }
  }

  // 边：按原 id 去重；端点不可达则丢弃
  const seenEdge = new Set<string>();
  const mappedEdges: Edge[] = [];
  let droppedEdges = 0;
  for (const edge of edges || []) {
    if (!edge || !edge.id || seenEdge.has(edge.id)) continue;
    seenEdge.add(edge.id);

    const source = oldToNew.get(edge.source);
    const target = oldToNew.get(edge.target);
    if (!source || !target) {
      droppedEdges++;
      continue;
    }
    mappedEdges.push({ ...edge, id: generateId(edge.id), source, target });
  }

  return { boardId, nodes: mappedNodes, edges: mappedEdges, droppedEdges };
}
