-- ==============================================================================
-- DeepDive.ai 企业级生产数据库全量建表与索引脚本 (PostgreSQL 14+)
-- 架构版本: v2.5.0-production
-- 支持特性: 混合多租户、多轮推演画布、节点级版本控制、BYOK 自带密钥加密、
--          多模态附件存储、动态模型路由配置、全链路审计与向量/GIN全文检索
-- ==============================================================================

-- 1. 基础扩展初始化
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- 提供 gen_random_uuid()、对称加密及哈希函数
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- 提供通用 UUID 函数
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- 混合 GIN 复合索引支持

-- 通用更新时间触发器函数
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==============================================================================
-- 模块一：用户、鉴权与安全体系 (Users, Sessions & Security)
-- ==============================================================================

-- 1.1 核心用户与权限表 (Users)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) DEFAULT '' NOT NULL,
  avatar TEXT DEFAULT '',
  phone VARCHAR(32) DEFAULT '',
  role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
  credits_balance BIGINT DEFAULT 50000 NOT NULL CHECK (credits_balance >= 0),
  vip_expires_at TIMESTAMPTZ,
  invite_code VARCHAR(32) UNIQUE,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  failed_attempts INT DEFAULT 0 NOT NULL,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_login_ip VARCHAR(45) DEFAULT '',
  deleted_at TIMESTAMPTZ, -- 软删除标识 (GDPR合规与注销冷却期)
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 1.2 用户安全会话表 (Sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(45) DEFAULT '',
  user_agent TEXT DEFAULT '',
  device_type VARCHAR(32) DEFAULT 'desktop', -- 'desktop', 'mobile', 'tablet'
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 1.3 用户自带密钥表 (User API Keys - BYOK 架构)
CREATE TABLE IF NOT EXISTS user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL, -- 'gemini', 'openai', 'anthropic', 'deepseek'
  encrypted_key TEXT NOT NULL,   -- AES-256-GCM 高度密文
  key_label VARCHAR(64) DEFAULT '',
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE(user_id, provider)
);

-- 1.4 安全合规操作审计日志表 (User Audit Logs)
CREATE TABLE IF NOT EXISTS user_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(64) NOT NULL, -- 'login', 'logout', 'change_password', 'export_canvas', 'create_share', 'recharge'
  target_type VARCHAR(32),     -- 'user', 'canvas', 'order', 'api_key'
  target_id VARCHAR(64),
  ip_address VARCHAR(45) DEFAULT '',
  user_agent TEXT DEFAULT '',
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ==============================================================================
-- 模块二：画布、节点与图关系体系 (Canvases, Nodes & Edges)
-- ==============================================================================

-- 2.1 探索画布表 (Canvases)
CREATE TABLE IF NOT EXISTS canvases (
  id VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) DEFAULT '新建思维画布' NOT NULL,
  description TEXT DEFAULT '',
  default_model VARCHAR(64) DEFAULT 'gemini-2.5-flash' NOT NULL,
  enable_web_search BOOLEAN DEFAULT TRUE NOT NULL,
  cover_image TEXT DEFAULT '',
  viewport_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  viewport_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  viewport_zoom DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
  is_favorite BOOLEAN DEFAULT FALSE NOT NULL,
  is_archived BOOLEAN DEFAULT FALSE NOT NULL,
  view_count INT DEFAULT 0 NOT NULL,
  export_count INT DEFAULT 0 NOT NULL,
  deleted_at TIMESTAMPTZ, -- 软删除，支持回收站30天恢复
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.2 画布节点表 (Nodes - 支持卡片、便签、深度推演与多轮对话)
CREATE TABLE IF NOT EXISTS nodes (
  id VARCHAR(64) PRIMARY KEY,
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  parent_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
  type VARCHAR(32) DEFAULT 'chat' NOT NULL, -- 'chat', 'note', 'root', 'summary'
  title VARCHAR(255) DEFAULT '' NOT NULL,
  question TEXT DEFAULT '' NOT NULL,
  answer TEXT DEFAULT '' NOT NULL,
  note TEXT DEFAULT '' NOT NULL,
  content TEXT DEFAULT '' NOT NULL,
  messages JSONB DEFAULT '[]'::jsonb NOT NULL,
  status VARCHAR(32) DEFAULT 'idle' NOT NULL, -- 'idle', 'loading', 'success', 'error'
  pos_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  pos_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  width INT DEFAULT 380 NOT NULL,
  height INT DEFAULT 320 NOT NULL,
  depth INT DEFAULT 0 NOT NULL,
  model_used VARCHAR(64) DEFAULT 'gemini-2.5-flash',
  grounding JSONB DEFAULT '[]'::jsonb,
  is_collapsed BOOLEAN DEFAULT FALSE NOT NULL,
  is_pinned BOOLEAN DEFAULT FALSE NOT NULL,
  branch_trigger_phrase TEXT DEFAULT '',
  enable_web_search BOOLEAN DEFAULT TRUE NOT NULL,
  color VARCHAR(32) DEFAULT '',
  tokens_used INT DEFAULT 0 NOT NULL,
  custom_data JSONB DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ, -- 节点级软删除
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.3 连线拓扑表 (Edges - 语义依赖与 React Flow 端点关联)
CREATE TABLE IF NOT EXISTS edges (
  id VARCHAR(64) PRIMARY KEY,
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  source_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_handle VARCHAR(64), -- 'out', 'right'
  target_handle VARCHAR(64), -- 'in', 'left'
  label VARCHAR(255) DEFAULT '',
  animated BOOLEAN DEFAULT FALSE,
  style JSONB DEFAULT '{}'::jsonb,
  type VARCHAR(32) DEFAULT 'smoothstep',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.4 节点多模态与参考资料附件表 (Node Attachments)
CREATE TABLE IF NOT EXISTS node_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  storage_url TEXT NOT NULL,
  parsed_text TEXT DEFAULT '', -- 提取后的纯文本向量索引材料
  summary TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.5 画布版本快照与回滚表 (Canvas Snapshots)
CREATE TABLE IF NOT EXISTS canvas_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(255) DEFAULT '',
  snapshot_data JSONB NOT NULL, -- 完整序列化的 nodes, edges 与 viewport
  node_count INT DEFAULT 0 NOT NULL,
  edge_count INT DEFAULT 0 NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.6 官方与精选思维模板库 (Canvas Templates)
CREATE TABLE IF NOT EXISTS canvas_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(64) DEFAULT 'business' NOT NULL, -- 'business', 'tech', 'academic', 'brainstorm', 'writing'
  title VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  cover_image TEXT DEFAULT '',
  initial_data JSONB NOT NULL, -- 预置的 nodes 与 edges
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  usage_count INT DEFAULT 0 NOT NULL,
  is_official BOOLEAN DEFAULT TRUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.7 画布公开分享与协作凭证表 (Canvas Shares)
CREATE TABLE IF NOT EXISTS canvas_shares (
  id VARCHAR(64) PRIMARY KEY,
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  share_code VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  permission VARCHAR(20) DEFAULT 'view' NOT NULL, -- 'view', 'fork', 'comment'
  allow_copy BOOLEAN DEFAULT TRUE NOT NULL,
  views_count INT DEFAULT 0 NOT NULL,
  forks_count INT DEFAULT 0 NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2.8 标签分类字典与关联表 (Tags & Canvas Tags)
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  color VARCHAR(32) DEFAULT 'indigo',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS canvas_tags (
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (canvas_id, tag_id)
);

-- ==============================================================================
-- 模块三：计费、订单与算力流水体系 (Billing, Orders & Credit Ledger)
-- ==============================================================================

-- 3.1 算力消费流水平账表 (Credit Transactions - 保证不可变双向对账)
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canvas_id VARCHAR(64) REFERENCES canvases(id) ON DELETE SET NULL,
  node_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
  model_name VARCHAR(64) NOT NULL,
  tokens_consumed INT NOT NULL,
  amount_credits BIGINT NOT NULL, -- 负数为消耗，正数为充值/赠送
  balance_after BIGINT NOT NULL,
  action_type VARCHAR(32) DEFAULT 'ai_chat' NOT NULL, -- 'ai_chat', 'recharge', 'vip_gift', 'admin_adjust', 'refund'
  remark TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 3.2 充值与订阅订单表 (Orders)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no VARCHAR(64) UNIQUE NOT NULL,
  external_trade_no VARCHAR(128) DEFAULT '', -- 第三方支付流水号 (微信/支付宝/Stripe)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id VARCHAR(32) NOT NULL, -- 'starter', 'pro_monthly', 'pro_annual', 'credits_pack'
  plan_name VARCHAR(64) NOT NULL,
  amount_cents INT NOT NULL,
  currency VARCHAR(10) DEFAULT 'CNY' NOT NULL,
  status VARCHAR(32) DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'closed')),
  duration_days INT DEFAULT 0 NOT NULL,
  credits_awarded BIGINT DEFAULT 0 NOT NULL,
  payment_method VARCHAR(32) DEFAULT 'online_pay' NOT NULL,
  payment_channel VARCHAR(32) DEFAULT 'mock_gateway',
  receipt_url TEXT DEFAULT '',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ==============================================================================
-- 模块四：AI 运行时、动态模型路由与审计 (AI Runtime & Dynamic Models)
-- ==============================================================================

-- 4.1 动态模型路由与定价配置表 (AI Models Config)
CREATE TABLE IF NOT EXISTS ai_models_config (
  id VARCHAR(64) PRIMARY KEY, -- 如 'gemini-2.5-flash', 'gemini-2.5-pro', 'deepseek-r1'
  display_name VARCHAR(128) NOT NULL,
  provider VARCHAR(32) DEFAULT 'google' NOT NULL,
  description TEXT DEFAULT '',
  context_window INT DEFAULT 128000 NOT NULL,
  max_output_tokens INT DEFAULT 8192 NOT NULL,
  credit_cost_per_1k_tokens INT DEFAULT 10 NOT NULL,
  is_vip_only BOOLEAN DEFAULT FALSE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  sort_order INT DEFAULT 0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 4.2 AI 推演请求审计与性能观测日志表 (AI Request Logs)
CREATE TABLE IF NOT EXISTS ai_request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  canvas_id VARCHAR(64) REFERENCES canvases(id) ON DELETE SET NULL,
  node_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
  model_name VARCHAR(64) NOT NULL,
  prompt_tokens INT DEFAULT 0 NOT NULL,
  completion_tokens INT DEFAULT 0 NOT NULL,
  total_tokens INT DEFAULT 0 NOT NULL,
  credits_deducted INT DEFAULT 0 NOT NULL,
  latency_ms INT DEFAULT 0 NOT NULL,
  status VARCHAR(32) DEFAULT 'success' NOT NULL, -- 'success', 'error', 'timeout'
  error_message TEXT,
  grounding_chunks_count INT DEFAULT 0 NOT NULL,
  ip_address VARCHAR(45) DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ==============================================================================
-- 模块五：运营支持、通知与系统设置 (Operations, Feedback & Notifications)
-- ==============================================================================

-- 5.1 用户反馈与客服工单表 (Feedbacks - 具备完整运营闭环)
CREATE TABLE IF NOT EXISTS feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(255) DEFAULT '',
  type VARCHAR(32) DEFAULT 'suggestion' NOT NULL, -- 'suggestion', 'bug', 'billing', 'model_quality', 'other'
  rating INT DEFAULT 5 NOT NULL CHECK (rating >= 1 AND rating <= 5),
  content TEXT NOT NULL,
  contact_info VARCHAR(255) DEFAULT '',
  status VARCHAR(32) DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'processing', 'resolved', 'closed')),
  admin_reply TEXT DEFAULT '',
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 5.2 站内通知与系统公告表 (Notifications)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL 表示全员系统广播
  type VARCHAR(32) DEFAULT 'system' NOT NULL, -- 'system', 'vip_renewal', 'credit_grant', 'feedback_reply'
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  link_url TEXT DEFAULT '',
  is_read BOOLEAN DEFAULT FALSE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 5.3 系统全局运行配置表 (System Settings)
CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  description VARCHAR(255) DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ==============================================================================
-- 模块六：高性能生产索引集群 (Indexes & GIN Full-Text Search)
-- ==============================================================================

-- 用户与鉴权索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expire ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_audit_user_action ON user_audit_logs(user_id, action, created_at DESC);

-- 画布与节点查询性能索引 (覆盖用户最近编辑与层级遍历)
CREATE INDEX IF NOT EXISTS idx_canvases_user_updated ON canvases(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_canvases_user_favorite ON canvases(user_id, is_favorite) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_canvas_id ON nodes(canvas_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_depth ON nodes(canvas_id, depth);
CREATE INDEX IF NOT EXISTS idx_edges_canvas_id ON edges(canvas_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_target ON edges(source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_node_attachments_node ON node_attachments(node_id);

-- 版本、模版与分享索引
CREATE INDEX IF NOT EXISTS idx_canvas_shares_code ON canvas_shares(share_code);
CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas ON canvas_snapshots(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvas_templates_category ON canvas_templates(category, usage_count DESC);

-- 财务与审计索引
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON credit_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_request_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_canvas ON ai_request_logs(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC);

-- GIN 全文检索索引 (支持中英文关键字在毫秒级内搜索节点标题、问题、回答与便签)
CREATE INDEX IF NOT EXISTS idx_nodes_fulltext ON nodes 
  USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(question, '') || ' ' || COALESCE(answer, '') || ' ' || COALESCE(content, '') || ' ' || COALESCE(note, '')));

-- ==============================================================================
-- 模块七：自动更新时间戳触发器挂载 (Auto Update Triggers)
-- ==============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_users') THEN
    CREATE TRIGGER set_timestamp_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_canvases') THEN
    CREATE TRIGGER set_timestamp_canvases BEFORE UPDATE ON canvases FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_nodes') THEN
    CREATE TRIGGER set_timestamp_nodes BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_orders') THEN
    CREATE TRIGGER set_timestamp_orders BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_feedbacks') THEN
    CREATE TRIGGER set_timestamp_feedbacks BEFORE UPDATE ON feedbacks FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_canvas_templates') THEN
    CREATE TRIGGER set_timestamp_canvas_templates BEFORE UPDATE ON canvas_templates FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
END $$;
