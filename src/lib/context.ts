/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Node, Edge } from '@xyflow/react';
import { ChatNodeData, ChatMessage } from '../types';

/**
 * Traverses upwards along DAG edges to construct the ancestor lineage
 * for a target node, formatting it into sequential multi-turn chat messages.
 *
 * Implements Context Pruning:
 * 1. Strictly traces only direct ancestor lineage (never includes siblings or unrelated branches on a 200+ node board).
 * 2. Prunes to a maximum of 8 recent ancestor hops and 12,000 characters to prevent context explosion.
 */
export function buildAncestorContext(
  targetNodeId: string,
  nodes: Node[],
  edges: Edge[],
  maxDepth = 8,
  maxCharLength = 12000
): { role: 'user' | 'assistant'; content: string }[] {
  const nodeMap = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const incomingEdgeMap = new Map<string, Edge>();
  edges.forEach((e) => {
    incomingEdgeMap.set(e.target, e);
  });

  const lineage: Node[] = [];
  let currentId: string | undefined = targetNodeId;
  const visited = new Set<string>();

  // Upward traversal along DAG parent links
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeMap.get(currentId);
    if (node) {
      lineage.unshift(node); // Oldest ancestor first
    }
    const edge = incomingEdgeMap.get(currentId);
    currentId = edge ? edge.source : undefined;
  }

  // Prune depth to the most recent `maxDepth` ancestor nodes
  const prunedLineage = lineage.length > maxDepth ? lineage.slice(lineage.length - maxDepth) : lineage;

  // Flatten messages from lineage
  const flattened: { role: 'user' | 'assistant'; content: string }[] = [];
  prunedLineage.forEach((node) => {
    if (node.type === 'chat') {
      const data = node.data as unknown as ChatNodeData;
      
      // If this is an ancestor node with single Q&A
      if (data.question && data.answer) {
        if (data.branchTriggerPhrase && node.id !== prunedLineage[0]?.id) {
          flattened.push({
            role: 'user',
            content: `[深入探讨分支重点: "${data.branchTriggerPhrase}"]\n${data.question}`,
          });
        } else {
          flattened.push({
            role: 'user',
            content: data.question,
          });
        }
        flattened.push({
          role: 'assistant',
          content: data.answer,
        });
      } else if (data.messages && data.messages.length > 0) {
        // Fallback for nodes with messages array
        if (data.branchTriggerPhrase && node.id !== prunedLineage[0]?.id) {
          flattened.push({
            role: 'user',
            content: `[深入探讨分支重点: "${data.branchTriggerPhrase}"]`,
          });
        }
        data.messages.forEach((msg: ChatMessage) => {
          flattened.push({
            role: msg.role,
            content: msg.content,
          });
        });
      }
    }
  });

  // Prune character length from oldest messages if total context exceeds maxCharLength
  let totalChars = flattened.reduce((sum, m) => sum + m.content.length, 0);
  while (flattened.length > 2 && totalChars > maxCharLength) {
    const removed = flattened.shift();
    if (removed) totalChars -= removed.content.length;
  }

  return flattened;
}
