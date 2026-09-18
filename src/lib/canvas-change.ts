/**
 * 画布变更分类（纯函数，供 `DeepDiveCanvas` 的自动保存调度使用）。
 *
 * 自动保存有两条通道（见 ADR-0025 的「缩短未上传窗口」配套）：
 * - **防抖**（600ms）：内容类变更——打字、AI 流式回答的逐帧追加。没必要每个字都发一次；
 * - **立即**：结构操作与提交点——新增/删除节点或边、连边、拖拽结束、失焦提交。
 *   这些是离散动作，没有「还在输入」的中间态，压着不发只是白留未上传窗口；而在
 *   「载入以服务端为准」的语义下，窗口里的内容会被丢弃，窗口越短越好。
 *
 * 结构变更的判据刻意选「节点/边 **id 集合**是否变化」而不是数量或内容哈希：
 * - 改内容 / 拖位置 / 折叠：id 集合不变 → 防抖（这类操作往往连续发生）；
 * - 新增或删除：id 集合变化 → 立即（一次点击就是一次提交）；
 * - 仅顺序变化：集合比较忽略顺序 → 不误判为结构变更。
 *
 * 上一份快照为 null（首次上报，通常是挂载后 React Flow 发量测）→ 不算结构变更。
 */
import type { Node, Edge } from '@xyflow/react';

export interface CanvasStructure {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}

export function snapshotStructure(
  nodes: readonly Node[] | undefined,
  edges: readonly Edge[] | undefined
): CanvasStructure {
  return {
    nodeIds: new Set((nodes || []).map((n) => n?.id).filter((id): id is string => !!id)),
    edgeIds: new Set((edges || []).map((e) => e?.id).filter((id): id is string => !!id)),
  };
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** 本次快照相对上一份是否发生了结构变更（有 id 被新增或删除） */
export function isStructuralChange(
  prev: CanvasStructure | null | undefined,
  next: CanvasStructure
): boolean {
  if (!prev) return false;
  return !sameIdSet(prev.nodeIds, next.nodeIds) || !sameIdSet(prev.edgeIds, next.edgeIds);
}
