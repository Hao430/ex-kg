-- ==============================================================================
-- 枝想 Arborize 企业级生产数据库全量建表与索引脚本 (PostgreSQL 14+)
-- 架构版本: v3.3.0-production (AI 练习模式：quiz_attempts)
-- 表总数: 22 张 (其中 8 张为一期预留空壳，二期激活；算力点数体系已废弃移除)
--          ⚠️ `server/core/schema.ts` 实为 24 张——本设计稿尚未收录 `event_logs`
--          （Spec I 业务埋点）与 `oauth_identities`（ADR-0022 第三方登录身份），
--          两者**以 schema.ts 为准**。
-- 支持特性: 强制登录多租户、多轮推演画布、服务端配额校验、订阅订单 (Mock 支付)、
--          邮箱验证与找回密码、注销软删除 30 天冷却、全链路审计与 GIN 全文检索、
--          主题出题 + 作答判卷 + 掌握情况统计 (Spec R1，画布外独立功能)
-- 事实源声明: 运行时建表以 server/core/schema.ts 为准（启动时自动执行含增量迁移），
--          本文档为同源设计稿；两者如有出入以 schema.ts 为准。
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
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) DEFAULT '' NOT NULL,
  avatar TEXT DEFAULT '',
  role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
  vip_expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  failed_attempts INT DEFAULT 0 NOT NULL,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  email_verified BOOLEAN DEFAULT FALSE NOT NULL, -- 邮箱验证状态（未验证禁 AI 推理）
  verify_token VARCHAR(64),      -- 邮箱验证一次性令牌（24h 有效）
  verify_expires_at TIMESTAMPTZ,
  reset_token VARCHAR(64),       -- 找回密码一次性令牌（1h 有效）
  reset_expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ, -- 软删除标识 (注销 30 天冷却期，期内可恢复)
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

-- 1.5 注册邮箱验证码表 (Email Verification Codes - 验证码先行注册，2026-09 重设计)
-- 验证先行才建号：sign-up 校验通过（消费成功即删行）后账号出生即 email_verified=true。
-- email 主键 = 一邮箱一码；连错 5 次（attempts）作废；10 分钟过期；重新发送覆盖旧码并归零 attempts。
CREATE TABLE IF NOT EXISTS email_verification_codes (
  email VARCHAR(255) PRIMARY KEY,
  code VARCHAR(6) NOT NULL,
  attempts INT DEFAULT 0 NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
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
  default_model VARCHAR(64) DEFAULT '' NOT NULL, -- 默认模型由管理后台配置（ai_model_config），存列仅作画布级元数据
  enable_web_search BOOLEAN DEFAULT TRUE NOT NULL,
  cover_image TEXT DEFAULT '',
  viewport_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  viewport_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  viewport_zoom DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
  is_favorite BOOLEAN DEFAULT FALSE NOT NULL,
  is_archived BOOLEAN DEFAULT FALSE NOT NULL,
  -- Spec Q1：本画板是否保留「探索灵感」占位节点（关闭 = 清理本板占位且本板不再生成）。
  -- 画板级属性而非个人偏好，故与 is_favorite/is_archived 同处 canvases 行上，
  -- 由 PATCH /api/canvases/:id/meta 读写（服务端唯一真源，客户端不得本地裁决）。
  suggestions_enabled BOOLEAN DEFAULT TRUE NOT NULL,
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
  model_used VARCHAR(64) DEFAULT '', -- 默认模型由管理后台配置（ai_model_config），存列仅作节点级元数据
  grounding JSONB DEFAULT '[]'::jsonb,
  is_collapsed BOOLEAN DEFAULT FALSE NOT NULL,
  is_pinned BOOLEAN DEFAULT FALSE NOT NULL,
  branch_trigger_phrase TEXT DEFAULT '',
  enable_web_search BOOLEAN DEFAULT TRUE NOT NULL,
  color VARCHAR(32) DEFAULT '',
  tokens_used INT DEFAULT 0 NOT NULL,
  custom_data JSONB DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ, -- 节点级软删除 / 墓碑（ADR-0017：删除胜出，读路径一律带 deleted_at IS NULL）
  rev BIGINT DEFAULT 1 NOT NULL, -- 节点级合并的行级定序判据（ADR-0017）：写入瞬间 rev = rev + 1
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
  style JSONB,                       -- React Flow 边样式（stroke/strokeWidth/strokeDasharray 等，2026-09-10 与 schema.ts 对齐）
  marker_end JSONB,                  -- React Flow 箭头 markerEnd（2026-09-10：分享快照与属主画布渲染一致）
  type VARCHAR(32) DEFAULT 'smoothstep',
  deleted_at TIMESTAMPTZ,            -- 边墓碑（ADR-0017）：与节点同语义，删除胜出
  rev BIGINT DEFAULT 1 NOT NULL,     -- 边级合并的行级定序判据（ADR-0017）
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
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

-- 2.8b 画板单层分组 (Spec L1 / ADR-0015：无 parent_id；删除分组只解除画板归属)
CREATE TABLE IF NOT EXISTS folders (
  id VARCHAR(64) PRIMARY KEY,                 -- 客户端 UUIDv7
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  sort_order INT DEFAULT 0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE canvases
  ADD COLUMN IF NOT EXISTS folder_id VARCHAR(64) REFERENCES folders(id) ON DELETE SET NULL;

-- 存量库增量迁移（与 server/core/schema.ts 的 ALTER 段同源；旧行取默认 TRUE ⇒ 行为不变）
ALTER TABLE canvases
  ADD COLUMN IF NOT EXISTS suggestions_enabled BOOLEAN DEFAULT TRUE;

-- ==============================================================================
-- 模块三：订阅订单体系 (Billing & Orders)
-- ==============================================================================

-- 3.1 充值与订阅订单表 (Orders)
-- 一期不接真实支付：PaymentProvider 抽象 + MockProvider 跑通订单全生命周期
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no VARCHAR(64) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id VARCHAR(32) NOT NULL, -- 'weekly', 'monthly'（yearly 已于 2026-09-10 下架：支付宝渠道单笔限额 ¥50，存量行保留）
  plan_name VARCHAR(64) NOT NULL,
  amount_cents INT NOT NULL,
  currency VARCHAR(10) DEFAULT 'CNY' NOT NULL,
  status VARCHAR(32) DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  duration_days INT NOT NULL,
  payment_method VARCHAR(32) DEFAULT 'online_pay' NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
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
  latency_ms INT DEFAULT 0 NOT NULL,
  status VARCHAR(32) DEFAULT 'success' NOT NULL, -- 'success', 'error', 'timeout'
  error_message TEXT,
  grounding_chunks_count INT DEFAULT 0 NOT NULL,
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
  type VARCHAR(32) DEFAULT 'system' NOT NULL, -- 'system', 'vip_renewal', 'feedback_reply'
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

-- 5.4 AI 练习记录表 (Quiz Attempts - Spec R1，2026-10-03)
-- ⚠️ **单表而非三表**：一期全部查询只有「历史列表 / 单次详情 / 统计」三种，
--    在本表里都是单表 SQL（无跨表 JOIN）。原设计的三张表（sessions/questions/answers）
--    在评审中被合为一张，省约 250 行与一整套 F4/RLS/双模/PG 测试面。
-- ⚠️ questions 内联 JSONB 而非独立行：题目是「一次生成的固定内容」，无需独立生命周期；
--    二期做间隔重复(SRS)时才迁到行表（ALTER TABLE ADD COLUMN，幂等增量迁移）。
-- ⚠️ **questions 含正确答案与解析，服务端独占**。任何列表查询都**不得 SELECT 该列**；
--    题量请用 jsonb_array_length(questions) 取（内存分支同款），否则列表会显示「0 题」。
--    「答案不下发」由接口层的投影 DTO 保证（不依赖表形状）。
-- ⛔ 本表归 RLS 直归属（user_id = app.user_id），策略由 schema.ts 的 initDbSchema() 生成
--    并以 ENABLE（非 FORCE）方式启用；本设计稿不写策略，与全文其他表一致。
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(200) NOT NULL,                                -- 用户输入的练习主题（自然语言）
  difficulty VARCHAR(16) NOT NULL
    CHECK (difficulty IN ('beginner','intermediate','advanced')),  -- 入门/进阶/困难
  status VARCHAR(16) NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','completed')),
    -- 题目（含 correct/explanation，服务端独占；单选 options 已在落库前洗牌并重编号标签）
    -- 结构：[{ id, type: 'single'|'true_false', stem, options: [{label,text}]|null,
    --          correct, explanation, knowledge_point }]
  questions JSONB NOT NULL,
  -- 作答与判卷结果；NULL = 未提交。结构：
  -- [{ question_id, choice, is_correct, elapsed_ms, low_confidence }]
  -- ⚠️ low_confidence 的 3s 阈值**仅**适用于判断题（猜对概率 50%），单选不适用
  answers JSONB,
  -- 出题自审摘要（学科判定/难度匹配/误区设计/模型名/是否解析失败），供面板透明展示
  review JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  completed_at TIMESTAMPTZ
);

-- ==============================================================================
-- 模块六：高性能生产索引集群 (Indexes & GIN Full-Text Search)
-- ==============================================================================

-- 用户与鉴权索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;
-- 存量库迁移：若旧版曾以 users.email 内联 UNIQUE 建表，需删除该全行唯一约束
-- （它会无视 deleted_at 阻断同邮箱重注册，违背 Spec F4）：
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token) WHERE verify_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;
-- sessions.token 已有 UNIQUE 约束自带的唯一索引，不再重复建普通索引
CREATE INDEX IF NOT EXISTS idx_sessions_user_expire ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_audit_user_action ON user_audit_logs(user_id, action, created_at DESC);

-- 画布与节点查询性能索引 (覆盖用户最近编辑与层级遍历)
CREATE INDEX IF NOT EXISTS idx_canvases_user_updated ON canvases(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_canvases_user_favorite ON canvases(user_id, is_favorite) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_canvases_folder ON canvases(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_canvas_id ON nodes(canvas_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_depth ON nodes(canvas_id, depth);
CREATE INDEX IF NOT EXISTS idx_edges_canvas_id ON edges(canvas_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_edges_source_target ON edges(source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_node_attachments_node ON node_attachments(node_id);
-- 墓碑 GC 扫描路径（server/jobs/log-cleanup.ts，保留期 CANVAS_TOMBSTONE_RETENTION_DAYS）
CREATE INDEX IF NOT EXISTS idx_nodes_deleted_at ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edges_deleted_at ON edges(deleted_at) WHERE deleted_at IS NOT NULL;

-- 版本、模版与分享索引
-- canvas_shares.share_code 已有 UNIQUE 约束自带的唯一索引，不再重复建普通索引
CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas ON canvas_snapshots(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvas_templates_category ON canvas_templates(category, usage_count DESC);

-- 财务与审计索引
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
-- orders.order_no 已有 UNIQUE 约束自带的唯一索引，不再重复建普通索引
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_request_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_canvas ON ai_request_logs(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC);
-- Spec R1：练习历史列表按用户 + 时间倒序分页（题量用 jsonb_array_length，不另建列）
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id, created_at DESC);

-- BRIN 时间索引：日志表为追加型，供按 created_at 范围的留存清理任务使用，避免全表扫描
CREATE INDEX IF NOT EXISTS idx_ai_logs_created_brin ON ai_request_logs USING BRIN(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created_brin ON user_audit_logs USING BRIN(created_at);

-- GIN 全文检索索引 (支持中英文关键字在毫秒级内搜索节点标题、问题、回答与便签)
CREATE INDEX IF NOT EXISTS idx_nodes_fulltext ON nodes 
  USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(question, '') || ' ' || COALESCE(answer, '') || ' ' || COALESCE(content, '') || ' ' || COALESCE(note, '')));

-- ==============================================================================
-- 模块七：自动更新时间戳触发器挂载 (Auto Update Triggers)
-- ⚠️ 设计稿：`server/core/schema.ts` 的 initDbSchema() **不创建任何触发器**（运行时真源是应用层
--    在每个 UPDATE 里显式 NOW()）。保留本节仅作历史设计记录；若照此建库，会与显式 NOW() 冗余，
--    并重新引入「新旧库行为不一致」的风险。见 ADR-0017。
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
  -- 注意：orders 表无 updated_at 列（订单状态以 paid_at 记录），故不挂载时间戳触发器，
  -- 否则触发器对不存在的 NEW.updated_at 赋值会导致订单更新报错。
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_feedbacks') THEN
    CREATE TRIGGER set_timestamp_feedbacks BEFORE UPDATE ON feedbacks FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_timestamp_canvas_templates') THEN
    CREATE TRIGGER set_timestamp_canvas_templates BEFORE UPDATE ON canvas_templates FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  END IF;
END $$;
