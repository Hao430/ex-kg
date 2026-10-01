import { useState, useRef, useEffect, useCallback } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { getLayoutedElements } from '../../../lib/layout';
import { exportCanvasAsPng } from '../../../lib/canvas-image-export';

export const SEARCH_HIT_CLASS = 'node-search-hit';

export interface UseCanvasLayoutOptions {
  nodesRef: React.MutableRefObject<Node[]>;
  edgesRef: React.MutableRefObject<Edge[]>;
  setNodes: (payload: Node[] | ((prev: Node[]) => Node[])) => void;
  setEdges: (payload: Edge[] | ((prev: Edge[]) => Edge[])) => void;
  reactFlowInstance: {
    fitView: (options?: { padding?: number; duration?: number }) => void;
    setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
  };
  triggerAutoLayoutRef?: React.MutableRefObject<(() => void) | null>;
  triggerFitViewRef?: React.MutableRefObject<(() => void) | null>;
  triggerAddRootRef?: React.MutableRefObject<(() => void) | null>;
  triggerAddNoteRef?: React.MutableRefObject<(() => void) | null>;
  triggerFocusNodeRef?: React.MutableRefObject<((nodeId: string) => void) | null>;
  triggerExportPngRef?: React.MutableRefObject<
    ((title: string) => Promise<{ ok: boolean; error?: string }>) | null
  >;
  handleAddRootNode?: () => void;
  handleAddNoteNode?: () => void;
}

/**
 * 画布布局、高亮定位与导出 Hook
 */
export function useCanvasLayout(options: UseCanvasLayoutOptions) {
  const {
    nodesRef,
    edgesRef,
    setNodes,
    setEdges,
    reactFlowInstance,
    triggerAutoLayoutRef,
    triggerFitViewRef,
    triggerAddRootRef,
    triggerAddNoteRef,
    triggerFocusNodeRef,
    triggerExportPngRef,
    handleAddRootNode,
    handleAddNoteNode,
  } = options;

  const [exportFullRender, setExportFullRender] = useState(false);

  // Search hit focus and highlight timer
  const searchHitTimerRef = useRef<number | null>(null);

  const clearSearchHit = useCallback(() => {
    searchHitTimerRef.current = null;
    if (!nodesRef.current.some((n) => n.className === SEARCH_HIT_CLASS)) return;
    const next = nodesRef.current.map((n) =>
      n.className === SEARCH_HIT_CLASS ? { ...n, className: undefined } : n
    );
    nodesRef.current = next;
    setNodes(next);
  }, [nodesRef, setNodes]);

  useEffect(() => () => {
    if (searchHitTimerRef.current !== null) clearTimeout(searchHitTimerRef.current);
  }, []);

  const focusSearchHit = useCallback(
    (nodeId: string) => {
      if (!nodesRef.current.some((n) => n.id === nodeId)) return;
      const next = nodesRef.current.map((n) => {
        if (n.id === nodeId) return { ...n, className: SEARCH_HIT_CLASS };
        if (n.className === SEARCH_HIT_CLASS) return { ...n, className: undefined };
        return n;
      });
      nodesRef.current = next;
      setNodes(next);
      if (searchHitTimerRef.current !== null) clearTimeout(searchHitTimerRef.current);
      searchHitTimerRef.current = window.setTimeout(clearSearchHit, 2500);

      window.setTimeout(() => {
        const target = nodesRef.current.find((n) => n.id === nodeId);
        if (target) {
          reactFlowInstance.setCenter(target.position.x + 220, target.position.y + 180, {
            zoom: 0.9,
            duration: 600,
          });
        }
      }, 60);
    },
    [nodesRef, reactFlowInstance, setNodes, clearSearchHit]
  );

  // Layout function (Zero-drag automatic tidy tree with manual position retention)
  const applyLayout = useCallback(
    (
      currentNodes = nodesRef.current,
      currentEdges = edgesRef.current,
      options?: { resetManualPositions?: boolean }
    ) => {
      const layouted = getLayoutedElements(currentNodes, currentEdges, 'LR', options);
      if (layouted.nodes !== currentNodes) {
        nodesRef.current = layouted.nodes;
        setNodes(layouted.nodes);
      }
      if (layouted.edges !== currentEdges) {
        edgesRef.current = layouted.edges;
        setEdges(layouted.edges);
      }
      window.requestAnimationFrame(() => {
        reactFlowInstance.fitView({ padding: 0.25, duration: 400 });
      });
    },
    [nodesRef, edgesRef, reactFlowInstance, setNodes, setEdges]
  );

  // Bind external action triggers
  useEffect(() => {
    if (triggerAutoLayoutRef) {
      triggerAutoLayoutRef.current = () =>
        applyLayout(nodesRef.current, edgesRef.current, { resetManualPositions: true });
    }
    if (triggerFitViewRef) {
      triggerFitViewRef.current = () =>
        reactFlowInstance.fitView({ padding: 0.2, duration: 500 });
    }
    if (triggerAddRootRef && handleAddRootNode) triggerAddRootRef.current = handleAddRootNode;
    if (triggerAddNoteRef && handleAddNoteNode) triggerAddNoteRef.current = handleAddNoteNode;
    if (triggerFocusNodeRef) triggerFocusNodeRef.current = focusSearchHit;
    if (triggerExportPngRef) {
      triggerExportPngRef.current = async (title: string) => {
        setExportFullRender(true);
        try {
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          );
          await new Promise<void>((r) => setTimeout(r, 80));
          return await exportCanvasAsPng(nodesRef.current, title);
        } finally {
          setExportFullRender(false);
        }
      };
    }
  }, [
    applyLayout,
    reactFlowInstance,
    handleAddRootNode,
    handleAddNoteNode,
    triggerAutoLayoutRef,
    triggerFitViewRef,
    triggerAddRootRef,
    triggerAddNoteRef,
    triggerFocusNodeRef,
    triggerExportPngRef,
    focusSearchHit,
    nodesRef,
  ]);

  return {
    applyLayout,
    focusSearchHit,
    clearSearchHit,
    exportFullRender,
    setExportFullRender,
  };
}
