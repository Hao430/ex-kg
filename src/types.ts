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
  /** 自动命名：手动改过标题后永不被 LLM 命名覆盖；autoTitled = 已消耗唯一一次自动命名机会 */
  titleManual?: boolean;
  autoTitled?: boolean;
  /** 只读模式（分享页/示例画布）：隐藏交互控件，仅保留展示 */
  readOnly?: boolean;
  /** 手动拖拽定位：标定该节点已被用户拖拽移动过，自动布局保留其相对坐标 */
  isManualPosition?: boolean;
}

export interface NoteNodeData {
  title: string;
  content: string;
  color?: string;
  /** 只读模式（分享页/示例画布）：隐藏交互控件，仅保留展示 */
  readOnly?: boolean;
}

export interface DeepDiveBoardMeta {
  id: string;
  name: string;
  updatedAt: number;
  nodeCount: number;
  /** Spec L1 / ADR-0015：画板库管理偏好（可选，兼容旧 localStorage 索引条目） */
  isFavorite?: boolean;
  isArchived?: boolean;
  /** Spec L1：单层分组归属（null/undefined = 未分组） */
  folderId?: string | null;
  /**
   * Spec Q1：本画板是否保留「探索灵感」占位节点（画板级属性，服务端唯一真源）。
   * 关闭 = 清理本板占位且本板不再生成；写入走 PATCH /api/canvases/:id/meta，
   * 客户端**不得**用 localStorage 之类的本地偏好自行裁决（本仓云优先口径，#0082）。
   */
  suggestionsEnabled?: boolean;
  /**
   * ADR-0018：服务端判定的「共享」标记（仅列表接口回传，见 `CanvasRecord.isShared`）。
   * legacy 模式下旧的全局共享默认板为 true → 不给收藏/归档/分组入口；private 模式下恒为
   * false（它就是认领者自己的普通画板）。**客户端不得再按公开 id 集合自行判断**——
   * 模式是服务端 env，客户端无从得知。与禁删无关：公开 id 两种模式下都禁删。
   */
  isShared?: boolean;
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
  vip_expires_at?: string | null;
  /** Spec D3：邮箱验证状态 */
  email_verified?: boolean;
  is_active?: boolean;
  failed_attempts?: number;
  locked_until?: string | null;
  last_login_at?: string | null;
  created_at?: string;
  /** 服务端派生的账号构成标记：账号是否设了口令。注册路径只有「邮箱 + 密码」，
   *  故恒为 true；保留为服务端字段的消费口，供将来出现无口令账号时降级展示（见
   *  UserProfileModal 安全页的防御性分支）。2026-09-16 撤销微信登录入口后，
   *  `email_placeholder` / `wechat_bound` / `wechat_nickname` 已不再被前端消费，故移除。 */
  has_password?: boolean;
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
  /** Spec R1：功能开关随 /me 下发（后端 env 为权威，前端据此隐藏入口） */
  features?: {
    quiz?: boolean;
  };
}

export type FeedbackType = 'suggestion' | 'bug' | 'ux' | 'other';

export interface FeedbackPayload {
  type: FeedbackType;
  rating: number;
  content: string;
  contactInfo?: string;
}

/**
 * 我的反馈（Spec P1 用户自查视图，9 键白名单）。
 * 服务端刻意不回 resolved_by（内部操作者）、contact_info/user_email/user_id，
 * 前端不要据此推断后端字段。
 */
export interface MyFeedback {
  id: string;
  type: FeedbackType;
  rating: number;
  content: string;
  status: 'pending' | 'processing' | 'resolved' | 'rejected';
  admin_reply: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SubscriptionPlanId = 'weekly' | 'monthly';

export interface SubscriptionPlan {
  id: SubscriptionPlanId;
  name: string;
  durationDays: number;
  price: string;
  popular?: boolean;
  desc: string;
  badge?: string;
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
  /** Spec I：强制联网（tool_choice:'required'），默认 true；关闭回落模型自主决策 */
  force_web_search?: boolean;
  updated_at?: string;
  updated_by?: string;
}

