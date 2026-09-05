-- ==========================================
-- DeepDive PostgreSQL 初始化建表脚本
-- ==========================================

-- 启用 pgcrypto 扩展 (用于 UUID 等加密函数，如有需要)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Users 核心用户表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) DEFAULT '' NOT NULL,
  role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
  credits_balance BIGINT DEFAULT 50000 NOT NULL CHECK (credits_balance >= 0),
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  failed_attempts INT DEFAULT 0 NOT NULL,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2. Sessions 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 3. Canvases 画布表
CREATE TABLE IF NOT EXISTS canvases (
  id VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) DEFAULT '新建思维画布' NOT NULL,
  description TEXT DEFAULT '',
  default_model VARCHAR(64) DEFAULT 'gemini-3.8-flash' NOT NULL,
  viewport_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  viewport_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  viewport_zoom DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 4. Nodes 节点表
CREATE TABLE IF NOT EXISTS nodes (
  id VARCHAR(64) PRIMARY KEY,
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  type VARCHAR(32) DEFAULT 'question' NOT NULL,
  question TEXT DEFAULT '' NOT NULL,
  answer TEXT DEFAULT '' NOT NULL,
  note TEXT DEFAULT '' NOT NULL,
  pos_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  pos_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  depth INT DEFAULT 0 NOT NULL,
  parent_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
  model_used VARCHAR(64) DEFAULT 'gemini-3.8-flash',
  grounding JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 5. Edges 连线表
CREATE TABLE IF NOT EXISTS edges (
  id VARCHAR(64) PRIMARY KEY,
  canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  source_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type VARCHAR(32) DEFAULT 'smoothstep',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 6. Credit transactions 消费流水平账表
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canvas_id VARCHAR(64) REFERENCES canvases(id) ON DELETE SET NULL,
  model_name VARCHAR(64) NOT NULL,
  tokens_consumed INT NOT NULL,
  balance_after BIGINT NOT NULL,
  action_type VARCHAR(32) DEFAULT 'ai_chat',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 7. 索引建立
CREATE INDEX IF NOT EXISTS idx_canvases_user_updated ON canvases(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_canvas_id ON nodes(canvas_id);
CREATE INDEX IF NOT EXISTS idx_edges_canvas_id ON edges(canvas_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON credit_transactions(user_id, created_at DESC);

-- ==========================================
-- (可选) 初始化默认账号 (密码根据您的后端逻辑由 bcrypt/scrypt 等加密后再插入)
-- ==========================================
-- INSERT INTO users (id, email, password_hash, name, role, credits_balance)
-- VALUES 
--  ('00000000-0000-0000-0000-000000000001', 'admin@deepdive.ai', 'YOUR_HASHED_PASSWORD', '系统管理员', 'admin', 200000)
-- ON CONFLICT (email) DO NOTHING;
