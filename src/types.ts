/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type DeepDiveNodeType = 'chat' | 'note';

export interface GroundingSource {
  index: number;
  title: string;
  uri: string;
  domain: string;
  snippet?: string;
}

export interface GroundingMetadata {
  sources?: GroundingSource[];
  queries?: string[];
  searchEntryPoint?: string;
}

export interface ChatNodeData {
  title: string;
  depth: number;
  question?: string;
  answer?: string;
  messages?: ChatMessage[];
  model: string;
  status: 'suggested' | 'idle' | 'generating' | 'error';
  errorMessage?: string;
  parentId?: string;
  branchTriggerPhrase?: string;
  isCollapsed?: boolean;
  suggestionsSpawned?: boolean;
  enableWebSearch?: boolean;
  grounding?: GroundingMetadata;
  onFollowUpInquiry?: (sourceNodeId: string, question: string, options?: { model?: string; enableWebSearch?: boolean }) => void;
  onActivateSuggestion?: (nodeId: string) => void;
  onSendMessage?: (nodeId: string, content: string, options?: { model?: string; enableWebSearch?: boolean }) => void;
  onBranch?: (nodeId: string, phrase?: string) => void;
  onDelete?: (nodeId: string) => void;
  onToggleCollapse?: (nodeId: string) => void;
  onUpdateTitle?: (nodeId: string, title: string) => void;
  onRetry?: (nodeId: string, options?: { model?: string; enableWebSearch?: boolean }) => void;
}

export interface NoteNodeData {
  title: string;
  content: string;
  color?: string;
  onUpdate?: (nodeId: string, content: string, title?: string) => void;
  onDelete?: (nodeId: string) => void;
  onBranchFromNote?: (nodeId: string, premiseText: string) => void;
}

export interface DeepDiveBoardMeta {
  id: string;
  name: string;
  updatedAt: number;
  nodeCount: number;
}

export interface TextSelectionPayload {
  nodeId: string;
  text: string;
  clientRect: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
}
