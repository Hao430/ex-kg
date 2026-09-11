/**
 * 后端核心数据契约：所有持久化记录类型统一定义于此。
 */

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  avatar?: string;
  role: 'user' | 'vip' | 'admin';
  vip_expires_at?: string | null;
  /** Spec D3：邮箱验证状态与一次性验证令牌（24h 有效） */
  email_verified: boolean;
  verify_token?: string | null;
  verify_expires_at?: string | null;
  /** Spec F1：找回密码一次性令牌（1h 有效） */
  reset_token?: string | null;
  reset_expires_at?: string | null;
  /** Spec F4：注销软删除时间戳（非空 = 已注销，30 天冷却期内可恢复） */
  deleted_at?: string | null;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackRecord {
  id: string;
  user_id?: string;
  user_email?: string;
  type: string;
  rating: number;
  content: string;
  contact_info?: string;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

export interface OrderRecord {
  id: string;
  order_no: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  duration_days: number;
  payment_method: string;
  created_at: string;
  paid_at?: string | null;
  user_email?: string;
}

export interface AiRequestLogRecord {
  id: string;
  user_id?: string | null;
  canvas_id?: string | null;
  node_id?: string | null;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  status: 'success' | 'error';
  error_message?: string | null;
  grounding_chunks_count: number;
  /** Spec I 可观测扩列：provider 与推演链路明细（内存分支与 PG 同款默认值，双模对齐） */
  provider: string;
  web_search_calls: number;
  raw_sources_count: number;
  sources_truncated: boolean;
  ttft_ms: number;
  aborted: boolean;
  fallback_used: boolean;
  reset_count: number;
  candidate_failures: number;
  created_at: string;
}

/** Spec I：业务事件埋点（event_logs 双模映射） */
export interface EventLogRecord {
  id: string;
  category: string;
  event: string;
  entity_type?: string | null;
  entity_id?: string | null;
  user_id?: string | null;
  num1?: number | null;
  num2?: number | null;
  details?: any;
  created_at: string;
}

export interface CanvasRecord {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  viewport: { x: number; y: number; zoom: number };
  defaultModel: string;
  enableWebSearch: boolean;
  /** Spec L1 / ADR-0015：画板库管理偏好（列已存在，读取统一 COALESCE 归一为布尔） */
  isFavorite?: boolean;
  isArchived?: boolean;
  /** Spec L1：单层分组归属（null = 未分组；分组删除时置 null） */
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
  nodeCount?: number;
  edgeCount?: number;
  nodes?: any[];
  edges?: any[];
  /** 画布软删除时间戳（非空 = 已删除；与 F4 用户注销 deleted_at 口径一致） */
  deleted_at?: string | null;
  /** ADR-0017：本次写入走的路径（协议分流），回执给客户端便于排障与埋点 */
  saveMode?: 'replace' | 'merge';
  /** 合并写入回执：被墓碑守卫拒绝的节点 id（删除胜出，陈旧设备不得复活） */
  ignoredNodeIds?: string[];
  /** 合并写入回执：父节点不可达、parentId 被置空的节点 id */
  repairedNodeIds?: string[];
}

/** Spec L1 / ADR-0015：单层画板分组（folders 双模映射） */
export interface FolderRecord {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Spec K1：快照式只读分享记录（canvas_shares 双模映射） */
export interface ShareRecord {
  id: string;
  canvas_id: string;
  share_code: string;
  /** 创建时刻的全量画布快照（不可变，后续画布编辑不传播） */
  snapshot: { title: string; nodes: any[]; edges: any[] } | null;
  views_count: number;
  /** 软撤销时间戳（非空 = 分享已失效） */
  revoked_at?: string | null;
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  user_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  details?: any;
  created_at: string;
}

/** 注册邮箱验证码（验证先行才建号；6 位数字 10 分钟有效，连错 5 次作废；email 唯一，一邮箱一码） */
export interface EmailCodeRecord {
  email: string;
  code: string;
  attempts: number;
  expires_at: string;
  updated_at: string;
}

export interface DbStatus {
  connected: boolean;
  type: 'postgresql' | 'in-memory-fallback';
  message: string;
  userCount: number;
  canvasCount: number;
  nodeCount: number;
  databaseUrlConfigured: boolean;
  /** Spec J1：最近 60s 内出现过 PG 故障（生产配置了 DATABASE_URL 且故障中恒为 true），供部署层探活告警 */
  degraded?: boolean;
}

export interface AiModelConfig {
  provider: 'gemini' | 'openai';
  openai_base_url: string;
  openai_api_key: string;
  openai_model: string;
  gemini_model: string;
  temperature: number;
  max_tokens: number;
  custom_system_prompt?: string;
  /** Spec I：强制联网（tool_choice:'required'）。默认 true（溯源有据是产品定位）；关闭回落模型自主决策 */
  force_web_search?: boolean;
  /** Spec E4：仅 VIP/Admin 可调用的模型白名单（体验版/过期 VIP 请求命中 → 403 MODEL_VIP_ONLY） */
  vip_only_models?: string[];
  /** 技术债 #0020：Gemini 容灾链（preferredModel 失败后依次尝试）。管理员后台配置即时生效，
   *  不再依赖 chat.ts 硬编码；未配置时回落代码内 bootstrap 默认链 */
  gemini_fallback_models?: string[];
  updated_at?: string;
  updated_by?: string;
}

export const DEFAULT_AI_MODEL_CONFIG: AiModelConfig = {
  provider: 'gemini',
  openai_base_url: 'https://api.openai.com/v1',
  openai_api_key: '',
  openai_model: 'deepseek-chat',
  gemini_model: 'gemini-3.8-flash',
  temperature: 0.7,
  max_tokens: 4096,
  custom_system_prompt: '',
  force_web_search: true,
};
