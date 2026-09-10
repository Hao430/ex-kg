/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export interface NodeActionsContextValue {
  sendMessage: (nodeId: string, question: string, options?: { model?: string; enableWebSearch?: boolean }) => void;
  followUpInquiry: (sourceNodeId: string, question: string, options?: { model?: string; enableWebSearch?: boolean }) => void;
  activateSuggestion: (nodeId: string) => void;
  branch: (sourceNodeId: string, triggerPhrase?: string) => void;
  branchFromNote: (sourceNoteId: string, premiseText: string) => void;
  deleteNode: (nodeId: string) => void;
  toggleCollapse: (nodeId: string) => void;
  updateTitle: (nodeId: string, title: string) => void;
  updateNote: (nodeId: string, content: string, title?: string) => void;
  retry: (nodeId: string, options?: { model?: string; enableWebSearch?: boolean }) => void;
  exportSubBranch?: (nodeId: string) => void;
  branchNewNote?: (sourceNoteId: string) => void;
}

export const NodeActionsContext = createContext<NodeActionsContextValue | null>(null);

export const useNodeActions = () => {
  return useContext(NodeActionsContext);
};

/** 只读画布桩（分享页/示例画布）：真实节点组件复用，但所有动作 no-op——交互控件另由 data.readOnly 隐藏 */
export const readOnlyNodeActions: NodeActionsContextValue = {
  sendMessage: () => {},
  followUpInquiry: () => {},
  activateSuggestion: () => {},
  branch: () => {},
  branchFromNote: () => {},
  deleteNode: () => {},
  toggleCollapse: () => {},
  updateTitle: () => {},
  updateNote: () => {},
  retry: () => {},
};
