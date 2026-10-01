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
 *
 * 顺序锚定（防分支互换）：dagre 的 crossing-reduction 不参考旧坐标，AI 推演完成新增
 * suggested 子节点后全图重算时，同层既有分支的上下序可能被重排（互换）。这里在喂入
 * dagre 前按「当前视觉序」（y 升序）排序节点与边，使初始序与既有布局一致——树形图
 * 无交叉边可优化，迭代基本保持该序，既有分支不再互换；未放置的新节点（占位 0,0）
 * 锚定父节点序插入。
 */

export interface LayoutOptions {
  resetManualPositions?: boolean;
}

export function estimateNodeSize(node: Node): { width: number; height: number } {
  const data = node.data as any;
  const isSuggested = data?.status === 'suggested';
  const isCollapsed = Boolean(data?.isCollapsed);
  const width = node.type === 'note' ? 320 : isSuggested ? 290 : 460;

  if (isCollapsed) {
    return { width, height: 60 };
  }
  if (isSuggested) {
    return { width, height: 140 };
  }
  if (node.type === 'note') {
    const noteLines = typeof data?.content === 'string' ? data.content.split('\n').length : 1;
    return { width, height: Math.max(240, Math.min(600, 160 + noteLines * 22)) };
  }

  // Active / Idle Chat card dynamic content estimation
  const answer = typeof data?.answer === 'string' ? data.answer : '';
  const question = typeof data?.question === 'string' ? data.question : '';
  const answerLines = (answer.match(/\n/g) || []).length + 1;
  const charLines = Math.ceil(answer.length / 26);
  const totalEffectiveLines = Math.max(answerLines, charLines) + (question.length > 50 ? 2 : 1);
  const sourcesCount = Array.isArray(data?.grounding?.sources) ? data.grounding.sources.length : 0;
  const sourcesAllowance = sourcesCount > 0 ? 35 : 0;
  const dynamicHeight = Math.max(380, Math.min(1800, 180 + totalEffectiveLines * 24 + sourcesAllowance));
  return { width, height: dynamicHeight };
}

export function resolveNodeSize(node: Node): { width: number; height: number } {
  const est = estimateNodeSize(node);
  return {
    width: node.measured?.width || est.width,
    height: Math.max(node.measured?.height || 0, est.height),
  };
}

function computeLayoutSignature(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB',
  resetManualPositions = false
): string {
  const nodeParts = nodes
    .map((n) => {
      const d = n.data as any;
      const { width, height } = resolveNodeSize(n);
      const manualTag =
        !resetManualPositions && d?.isManualPosition
          ? `M(${Math.round(n.position.x)},${Math.round(n.position.y)})`
          : 'A';
      return `${n.id}|${n.type ?? ''}|${d?.status ?? ''}|${d?.isCollapsed ? 1 : 0}|${Math.round(width)}x${Math.round(height)}|${manualTag}`;
    })
    .sort();
  const edgeParts = edges.map((e) => `${e.source}->${e.target}`).sort();
  return `${direction}#${resetManualPositions ? 'R' : 'K'}#${nodeParts.join(';')}#${edgeParts.join(';')}`;
}

interface CachedLayout {
  signature: string;
  positions: Map<string, { x: number; y: number }>;
}
let layoutCache: CachedLayout | null = null;

/**
 * Computes optimal hierarchical tree layout for nodes and edges
 * Zero-drag architecture with manual positioning retention & subtree linkage support.
 */
export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR',
  options?: LayoutOptions
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) {
    return { nodes, edges };
  }

  const resetManual = Boolean(options?.resetManualPositions);
  const signature = computeLayoutSignature(nodes, edges, direction, resetManual);
  let positions: Map<string, { x: number; y: number }> | null =
    layoutCache && layoutCache.signature === signature ? layoutCache.positions : null;

  if (!positions) {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setGraph({
      rankdir: direction,
      // 间距按「边缘到边缘」计（dagre 加在相邻两层的包围盒之间），故中心距 =
      // ranksep + (父宽 + 子宽)/2，随节点宽度变；同层里较窄的节点视觉空隙会更大。
      // ⚠️ 这两行的横/纵只在 rankdir='LR' 下成立（当前三处调用与默认值都是 LR）。
      nodesep: 50,  // 同层兄弟之间的纵向缝（边缘到边缘）
      ranksep: 250, // 相邻深度层之间的横向缝（边缘到边缘）
      marginx: 80,
      marginy: 80,
    });
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    // 顺序锚定：先给已定位节点记自身 y，占位 0,0 的新节点锚定父节点序（紧随其后，
    // 同父多个新节点靠稳定排序保持声明顺序）
    const yKey = new Map<string, number>();
    nodes.forEach((node) => {
      if (node.position.x !== 0 || node.position.y !== 0) {
        yKey.set(node.id, node.position.y);
      }
    });
    nodes.forEach((node) => {
      if (yKey.has(node.id)) return;
      const parentId = (node.data as any)?.parentId as string | undefined;
      const parentY = parentId != null ? yKey.get(parentId) : undefined;
      yKey.set(node.id, parentY !== undefined ? parentY + 0.5 : node.position.y);
    });

    const orderedNodes = [...nodes].sort(
      (a, b) => (yKey.get(a.id) ?? 0) - (yKey.get(b.id) ?? 0)
    );
    const orderedEdges = [...edges].sort((a, b) => {
      const sa = yKey.get(a.source) ?? 0;
      const sb = yKey.get(b.source) ?? 0;
      if (sa !== sb) return sa - sb;
      return (yKey.get(a.target) ?? 0) - (yKey.get(b.target) ?? 0);
    });

    orderedNodes.forEach((node) => {
      const { width, height } = resolveNodeSize(node);
      dagreGraph.setNode(node.id, { width, height });
    });

    orderedEdges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const canonicalPositions = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => {
      const pos = dagreGraph.node(node.id);
      const { width, height } = resolveNodeSize(node);
      if (pos) canonicalPositions.set(node.id, { x: pos.x - width / 2, y: pos.y - height / 2 });
    });

    if (resetManual) {
      positions = canonicalPositions;
    } else {
      // 保持用户手动拖拽位置与分支相对偏移
      const parentMap = new Map<string, string>();
      edges.forEach((e) => {
        if (!parentMap.has(e.target)) {
          parentMap.set(e.target, e.source);
        }
      });

      const effectivePositions = new Map<string, { x: number; y: number }>();
      const branchOffsets = new Map<string, { dx: number; dy: number }>();
      const visited = new Set<string>();
      const queue: string[] = [];

      nodes.forEach((n) => {
        if (!parentMap.has(n.id)) {
          queue.push(n.id);
        }
      });
      if (queue.length === 0 && nodes.length > 0) {
        queue.push(nodes[0].id);
      }

      while (queue.length > 0) {
        const currId = queue.shift()!;
        if (visited.has(currId)) continue;
        visited.add(currId);

        const node = nodes.find((n) => n.id === currId);
        const canonical = canonicalPositions.get(currId);
        if (!node || !canonical) continue;

        const isManual = Boolean((node.data as any)?.isManualPosition);
        if (isManual) {
          effectivePositions.set(currId, node.position);
          branchOffsets.set(currId, {
            dx: node.position.x - canonical.x,
            dy: node.position.y - canonical.y,
          });
        } else {
          const parentId = parentMap.get(currId);
          const parentOffset = parentId ? branchOffsets.get(parentId) : undefined;
          if (parentOffset) {
            effectivePositions.set(currId, {
              x: canonical.x + parentOffset.dx,
              y: canonical.y + parentOffset.dy,
            });
            branchOffsets.set(currId, parentOffset);
          } else {
            effectivePositions.set(currId, canonical);
          }
        }

        edges.forEach((e) => {
          if (e.source === currId && !visited.has(e.target)) {
            queue.push(e.target);
          }
        });
      }

      nodes.forEach((n) => {
        if (!effectivePositions.has(n.id)) {
          const canonical = canonicalPositions.get(n.id) ?? n.position;
          const isManual = Boolean((n.data as any)?.isManualPosition);
          effectivePositions.set(n.id, isManual ? n.position : canonical);
        }
      });

      positions = effectivePositions;
    }

    layoutCache = { signature, positions };
  }

  // 只重建状态或位置真正变化的节点；AI 节点与便签均设为 draggable: true（占位 suggested 除外）
  let anyChanged = false;
  const newNodes = nodes.map((node) => {
    const isSuggested = (node.data as any)?.status === 'suggested';
    const shouldBeDraggable = !isSuggested;
    const needsDraggableFix = node.draggable !== shouldBeDraggable;

    const isManual = Boolean((node.data as any)?.isManualPosition);
    const needsManualReset = resetManual && isManual;

    const pos = positions!.get(node.id);
    const target = pos ?? node.position;

    const posUnchanged =
      Math.abs(target.x - node.position.x) < 0.5 &&
      Math.abs(target.y - node.position.y) < 0.5;

    if (!needsDraggableFix && !needsManualReset && posUnchanged) {
      return node;
    }

    anyChanged = true;
    let nextData = node.data;
    if (needsManualReset) {
      nextData = { ...(node.data as any), isManualPosition: false };
    }

    return {
      ...node,
      draggable: shouldBeDraggable,
      position: target,
      data: nextData,
    };
  });

  return { nodes: anyChanged ? newNodes : nodes, edges };
}
