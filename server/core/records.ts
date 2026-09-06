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
  createdAt: string;
  updatedAt: string;
  nodeCount?: number;
  edgeCount?: number;
  nodes?: any[];
  edges?: any[];
}

export interface DbStatus {
  connected: boolean;
  type: 'postgresql' | 'in-memory-fallback';
  message: string;
  userCount: number;
  canvasCount: number;
  nodeCount: number;
  databaseUrlConfigured: boolean;
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
  /** Spec E4：仅 VIP/Admin 可调用的模型白名单（体验版/过期 VIP 请求命中 → 403 MODEL_VIP_ONLY） */
  vip_only_models?: string[];
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
};
