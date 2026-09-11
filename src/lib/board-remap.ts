/**
 * Spec M2 — 画板 id 重映射（JSON 导入与分享克隆共用）。
 *
 * 服务端 nodes.id / edges.id 是全局主键，saveCanvas 先按 canvas_id 清表再按 id
 * 批量插入。任何「把既有画板复制成新画板」的路径都必须重映射 id，否则会与源画板
 * 的行撞主键导致整板保存失败。
 *
 * 纯函数：不依赖 zod / DOM / 网络，id 可注入。刻意不含 zod，避免克隆路径把校验库
 * 拉进主包（M1 导入侧按需懒加载 zod）。
 */
import type { Node, Edge } from '@xyflow/react';
import { uuidv7 } from './uuid.js';

export interface RemapOptions {
  /** 注入 id 生成器（测试注入计数器；默认 uuidv7） */
  generateId?: () => string;
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
  const boardId = generateId();

  // 第一遍：节点按原 id 去重（保留首个），随后逐一分配新 id，建立完整 old→new 映射
  const nodeByOldId = new Map<string, Node>();
  for (const node of nodes || []) {
    if (!node || !node.id || nodeByOldId.has(node.id)) continue;
    nodeByOldId.set(node.id, node);
  }
  const oldToNew = new Map<string, string>();
  for (const oldId of nodeByOldId.keys()) oldToNew.set(oldId, generateId());

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
    mappedEdges.push({ ...edge, id: generateId(), source, target });
  }

  return { boardId, nodes: mappedNodes, edges: mappedEdges, droppedEdges };
}
