/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Node, Edge } from '@xyflow/react';

/**
 * 递归收集目标分支节点的所有子孙节点与关联连线，并导出为新画板。
 * 遵循 ADR-0009 与 技术架构文档 §4.1。
 * 维护 visited set 防止循环引用死循环（#0006 follow-up）。
 */
export function extractSubtree(
  rootNodeId: string,
  nodes: Node[],
  edges: Edge[]
): {
  subtreeNodes: Node[];
  subtreeEdges: Edge[];
  remainingNodes: Node[];
  remainingEdges: Edge[];
} {
  const nodeMap = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  if (!nodeMap.has(rootNodeId)) {
    return {
      subtreeNodes: [],
      subtreeEdges: [],
      remainingNodes: [...nodes],
      remainingEdges: [...edges],
    };
  }

  // 沿出边迭代汇聚所有子孙节点 ID（visited set 防环）
  const descendantIds = new Set<string>([rootNodeId]);
  let added = true;

  while (added) {
    added = false;
    for (const edge of edges) {
      if (descendantIds.has(edge.source) && !descendantIds.has(edge.target)) {
        descendantIds.add(edge.target);
        added = true;
      }
    }
  }

  const subtreeNodes = nodes.filter((n) => descendantIds.has(n.id));
  const remainingNodes = nodes.filter((n) => !descendantIds.has(n.id));

  // 连线过滤：两端均属于子树的边归入新画板，其余保留或剔除
  const subtreeEdges = edges.filter(
    (e) => descendantIds.has(e.source) && descendantIds.has(e.target)
  );
  const remainingEdges = edges.filter(
    (e) => !descendantIds.has(e.source) && !descendantIds.has(e.target)
  );

  return { subtreeNodes, subtreeEdges, remainingNodes, remainingEdges };
}

/**
 * 递归收集目标分支节点的所有下游子孙节点 ID（广度优先遍历，带防环保护）。
 */
export function getDescendantNodeIds(
  rootId: string,
  edges: Edge[]
): Set<string> {
  const descendants = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const e of edges) {
      if (e.source === curr && e.target !== rootId && !descendants.has(e.target)) {
        descendants.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return descendants;
}

