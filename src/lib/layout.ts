/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import dagre from 'dagre';
import { Node, Edge } from '@xyflow/react';

/**
 * Zero-drag 自动布局（dagre 层次布局）。
 *
 * 性能设计：
 * 1. 结构签名缓存——节点集（id/类型/状态/折叠/测量尺寸）+ 边集 + 方向均未变化时，
 *    直接复用上次布局坐标，跳过 dagre 全图重算（折叠/删除后的 setTimeout 布局链受益最大）。
 * 2. 输出引用保持——位置未变化的节点返回原对象（不重建），配合 React Flow v12
 *    的 NodeWrapper memo，未动节点跳过重渲染。
 * 3. 估算尺寸与组件真实宽度对齐（chat w-[460px]、note w-[320px]、suggested w-[290px]），
 *    measured 未就绪时避免布局缝隙不均。
 */

function estimateNodeSize(node: Node): { width: number; height: number } {
  const data = node.data as any;
  const isSuggested = data?.status === 'suggested';
  const isCollapsed = Boolean(data?.isCollapsed);
  const width = node.type === 'note' ? 320 : isSuggested ? 290 : 460;
  const height = isCollapsed ? 60 : isSuggested ? 140 : node.type === 'note' ? 240 : 380;
  return { width, height };
}

function resolveNodeSize(node: Node): { width: number; height: number } {
  const est = estimateNodeSize(node);
  return {
    width: node.measured?.width || est.width,
    height: node.measured?.height || est.height,
  };
}

function computeLayoutSignature(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB'): string {
  const nodeParts = nodes
    .map((n) => {
      const d = n.data as any;
      const { width, height } = resolveNodeSize(n);
      return `${n.id}|${n.type ?? ''}|${d?.status ?? ''}|${d?.isCollapsed ? 1 : 0}|${Math.round(width)}x${Math.round(height)}`;
    })
    .sort();
  const edgeParts = edges.map((e) => `${e.source}->${e.target}`).sort();
  return `${direction}#${nodeParts.join(';')}#${edgeParts.join(';')}`;
}

interface CachedLayout {
  signature: string;
  positions: Map<string, { x: number; y: number }>;
}
let layoutCache: CachedLayout | null = null;

/**
 * Computes optimal hierarchical tree layout for nodes and edges
 * Zero-drag architecture: automatically organizes coordinates so users never need to drag
 */
export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR'
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) {
    return { nodes, edges };
  }

  const signature = computeLayoutSignature(nodes, edges, direction);
  let positions: Map<string, { x: number; y: number }> | null =
    layoutCache && layoutCache.signature === signature ? layoutCache.positions : null;

  if (!positions) {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    dagreGraph.setGraph({
      rankdir: direction,
      nodesep: 50,  // Vertical gap between sibling branches
      ranksep: 140, // Horizontal gap between depth levels
      marginx: 80,
      marginy: 80,
    });

    nodes.forEach((node) => {
      const { width, height } = resolveNodeSize(node);
      dagreGraph.setNode(node.id, { width, height });
    });

    edges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    positions = new Map();
    nodes.forEach((node) => {
      const pos = dagreGraph.node(node.id);
      const { width, height } = resolveNodeSize(node);
      if (pos) positions!.set(node.id, { x: pos.x - width / 2, y: pos.y - height / 2 });
    });
    layoutCache = { signature, positions };
  }

  // 只重建位置真正变化的节点：未变化节点保持引用（含 draggable 归一化仅对便签生效）
  let anyChanged = false;
  const newNodes = nodes.map((node) => {
    const needsDraggableFix = node.type === 'note' && node.draggable !== true;
    const pos = positions!.get(node.id);
    const target = pos ?? node.position;
    if (
      !needsDraggableFix &&
      Math.abs(target.x - node.position.x) < 0.5 &&
      Math.abs(target.y - node.position.y) < 0.5
    ) {
      return node;
    }
    anyChanged = true;
    return {
      ...node,
      draggable: node.type === 'note',
      position: target,
    };
  });

  return { nodes: anyChanged ? newNodes : nodes, edges };
}
