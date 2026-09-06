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

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: 'user' | 'vip' | 'admin';
  credits_balance: number;
  vip_expires_at?: string | null;
  is_active?: boolean;
  failed_attempts?: number;
  locked_until?: string | null;
  last_login_at?: string | null;
  created_at?: string;
  canvas_count?: number;
  total_tokens_used?: number;
  /** 服务端权益（Spec B1/B3）：plan 区分体验版/VIP/Admin，vipExpired + 宽限剩余天数供横幅 */
  entitlements?: {
    plan: 'trial' | 'vip' | 'admin';
    vipExpired: boolean;
    vipGraceDaysRemaining?: number;
    boardLimit: number | null;
    nodeLimit: number | null;
  };
}

export type FeedbackType = 'suggestion' | 'bug' | 'ux' | 'other';

export interface FeedbackPayload {
  type: FeedbackType;
  rating: number;
  content: string;
  contactInfo?: string;
}

export type SubscriptionPlanId = 'weekly' | 'monthly' | 'yearly';

export interface SubscriptionPlan {
  id: SubscriptionPlanId;
  name: string;
  durationDays: number;
  price: string;
  popular?: boolean;
  desc: string;
  badge?: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  user_email?: string;
  canvas_id: string | null;
  model_name: string;
  tokens_consumed: number;
  balance_after: number;
  action_type: string;
  created_at: string;
}

export interface AdminOverview {
  totalUsers: number;
  activeUsers7d: number;
  vipUsers: number;
  totalCanvases: number;
  todayTokens: number;
  monthlyTokens: number;
  modelDistribution: Record<string, number>;
}

export interface AiModelConfig {
  provider: 'gemini' | 'openai';
  openai_base_url: string;
  openai_api_key?: string;
  has_openai_key?: boolean;
  openai_model: string;
  gemini_model: string;
  temperature: number;
  max_tokens: number;
  custom_system_prompt?: string;
  updated_at?: string;
  updated_by?: string;
}

