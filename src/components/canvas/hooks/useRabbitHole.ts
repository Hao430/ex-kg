import { useState, useEffect, useCallback } from 'react';
import type { TextSelectionPayload } from '../../../types';

/**
 * 兔子洞（Rabbit Hole）划词探索 Hook
 * 监听画布节点内的划选文本，生成浮动胶囊坐标与上下文负载
 */
export function useRabbitHole() {
  const [selectionPayload, setSelectionPayload] = useState<TextSelectionPayload | null>(null);

  const clearSelection = useCallback(() => {
    setSelectionPayload(null);
  }, []);

  useEffect(() => {
    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setSelectionPayload(null);
        return;
      }

      const selectedText = selection.toString().trim();
      if (selectedText.length < 2) {
        setSelectionPayload(null);
        return;
      }

      // Check if selection is within a node
      let anchorElem: HTMLElement | null = selection.anchorNode as HTMLElement;
      if (anchorElem && anchorElem.nodeType === window.Node.TEXT_NODE) {
        anchorElem = anchorElem.parentElement;
      }

      const nodeContainer = anchorElem?.closest('.react-flow__node');
      if (!nodeContainer) {
        setSelectionPayload(null);
        return;
      }

      const nodeId = nodeContainer.getAttribute('data-id');
      if (!nodeId) return;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      setSelectionPayload({
        nodeId,
        text: selectedText,
        clientRect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
      });
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return {
    selectionPayload,
    setSelectionPayload,
    clearSelection,
  };
}
