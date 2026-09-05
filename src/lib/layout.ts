/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import dagre from 'dagre';
import { Node, Edge } from '@xyflow/react';

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
    const isSuggested = (node.data as any)?.status === 'suggested';
    const isCollapsed = (node.data as any)?.isCollapsed;
    const defaultWidth = node.type === 'note' ? 320 : isSuggested ? 380 : 440;
    const defaultHeight = isCollapsed ? 60 : isSuggested ? 140 : node.type === 'note' ? 240 : 380;
    const width = node.measured?.width || defaultWidth;
    const height = node.measured?.height || defaultHeight;
    dagreGraph.setNode(node.id, { width, height });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const width = node.measured?.width || (node.type === 'note' ? 320 : 440);
    const height = node.measured?.height || 360;

    return {
      ...node,
      draggable: node.type === 'note',
      position: {
        x: nodeWithPosition ? nodeWithPosition.x - width / 2 : node.position.x,
        y: nodeWithPosition ? nodeWithPosition.y - height / 2 : node.position.y,
      },
    };
  });

  return { nodes: newNodes, edges };
}
