/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Node, Edge } from '@xyflow/react';
import { ChatNodeData, ChatMessage } from '../types';

/**
 * Traverses upwards along DAG edges to construct the full ancestor lineage
 * for a target node, formatting it into sequential multi-turn chat messages.
 */
export function buildAncestorContext(
  targetNodeId: string,
  nodes: Node[],
  edges: Edge[]
): { role: 'user' | 'assistant'; content: string }[] {
  const nodeMap = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const incomingEdgeMap = new Map<string, Edge>();
  edges.forEach((e) => {
    incomingEdgeMap.set(e.target, e);
  });

  const lineage: Node[] = [];
  let currentId: string | undefined = targetNodeId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeMap.get(currentId);
    if (node) {
      lineage.unshift(node); // Oldest ancestor first
    }
    const edge = incomingEdgeMap.get(currentId);
    currentId = edge ? edge.source : undefined;
  }

  // Flatten messages from lineage
  const flattened: { role: 'user' | 'assistant'; content: string }[] = [];
  lineage.forEach((node) => {
    if (node.type === 'chat') {
      const data = node.data as unknown as ChatNodeData;
      
      // If this is an ancestor node with single Q&A
      if (data.question && data.answer) {
        if (data.branchTriggerPhrase && node.id !== lineage[0]?.id) {
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
        if (data.branchTriggerPhrase && node.id !== lineage[0]?.id) {
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

  return flattened;
}
