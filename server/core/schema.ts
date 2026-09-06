import { getPool } from './pool.js';
import { hashPassword } from '../lib/crypto.js';

let schemaInitialized = false;

/**
 * Initialize PostgreSQL tables and seed default users if not present
 */
export async function initDbSchema(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  if (schemaInitialized) return true;

  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // Enable pgcrypto if possible
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    } catch (extErr) {
      // ignore if unprivileged
    }

    // 1. Users core table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) DEFAULT '' NOT NULL,
        avatar TEXT,
        role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
        credits_balance BIGINT DEFAULT 50000 NOT NULL CHECK (credits_balance >= 0),
        vip_expires_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        failed_attempts INT DEFAULT 0 NOT NULL,
        locked_until TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_expires_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
    `);

    // 2. Safe Sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(255) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 3. Canvases table
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvases (
        id VARCHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) DEFAULT '新建思维画布' NOT NULL,
        description TEXT DEFAULT '',
        default_model VARCHAR(64) DEFAULT 'gemini-3.8-flash' NOT NULL,
        viewport_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
        viewport_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
        viewport_zoom DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
        is_favorite BOOLEAN DEFAULT FALSE,
        is_archived BOOLEAN DEFAULT FALSE,
        cover_image TEXT DEFAULT '',
        view_count INT DEFAULT 0,
        export_count INT DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS cover_image TEXT DEFAULT '';
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS view_count INT DEFAULT 0;
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS export_count INT DEFAULT 0;
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    `);

    // 4. Nodes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS nodes (
        id VARCHAR(64) PRIMARY KEY,
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        type VARCHAR(32) DEFAULT 'chat' NOT NULL,
        title VARCHAR(255) DEFAULT '' NOT NULL,
        question TEXT DEFAULT '' NOT NULL,
        answer TEXT DEFAULT '' NOT NULL,
        note TEXT DEFAULT '' NOT NULL,
        content TEXT DEFAULT '' NOT NULL,
        messages JSONB DEFAULT '[]'::jsonb NOT NULL,
        status VARCHAR(32) DEFAULT 'idle' NOT NULL,
        pos_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
        pos_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
        width INT DEFAULT 380 NOT NULL,
        height INT DEFAULT 320 NOT NULL,
        depth INT DEFAULT 0 NOT NULL,
        parent_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
        model_used VARCHAR(64) DEFAULT 'gemini-3.8-flash',
        grounding JSONB DEFAULT '[]'::jsonb,
        is_collapsed BOOLEAN DEFAULT FALSE NOT NULL,
        is_pinned BOOLEAN DEFAULT FALSE NOT NULL,
        branch_trigger_phrase TEXT DEFAULT '',
        enable_web_search BOOLEAN DEFAULT TRUE NOT NULL,
        color VARCHAR(32) DEFAULT '',
        tokens_used INT DEFAULT 0 NOT NULL,
        custom_data JSONB DEFAULT '{}'::jsonb,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS title VARCHAR(255) DEFAULT '';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS content TEXT DEFAULT '';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS messages JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'idle';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS width INT DEFAULT 380;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS height INT DEFAULT 320;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS is_collapsed BOOLEAN DEFAULT FALSE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS branch_trigger_phrase TEXT DEFAULT '';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS enable_web_search BOOLEAN DEFAULT TRUE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS color VARCHAR(32) DEFAULT '';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tokens_used INT DEFAULT 0;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS custom_data JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    `);

    // 5. Edges table
    await client.query(`
      CREATE TABLE IF NOT EXISTS edges (
        id VARCHAR(64) PRIMARY KEY,
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        source_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        source_handle VARCHAR(64),
        target_handle VARCHAR(64),
        label VARCHAR(255) DEFAULT '',
        animated BOOLEAN DEFAULT FALSE,
        type VARCHAR(32) DEFAULT 'smoothstep',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS source_handle VARCHAR(64);
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS target_handle VARCHAR(64);
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS label VARCHAR(255) DEFAULT '';
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS animated BOOLEAN DEFAULT FALSE;
    `);

    // 6. Credit transactions table
    await client.query(`
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
    `);

    // 6.1 Orders (充值与会员订阅订单表)
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_no VARCHAR(64) UNIQUE NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id VARCHAR(32) NOT NULL,
        plan_name VARCHAR(64) NOT NULL,
        amount_cents INT NOT NULL,
        currency VARCHAR(10) DEFAULT 'CNY' NOT NULL,
        status VARCHAR(32) DEFAULT 'paid' NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
        duration_days INT NOT NULL,
        payment_method VARCHAR(32) DEFAULT 'online_pay' NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        paid_at TIMESTAMPTZ
      );
    `);

    // 6.2 AI Request Logs (模型推演调用审计日志表)
    await client.query(`
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
        status VARCHAR(32) DEFAULT 'success' NOT NULL,
        error_message TEXT,
        grounding_chunks_count INT DEFAULT 0 NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7. System Settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(64) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);


    // 7.1 Canvas Shares (公开分享与协作)
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_shares (
        id VARCHAR(64) PRIMARY KEY,
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        share_code VARCHAR(64) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        permission VARCHAR(20) DEFAULT 'view' NOT NULL,
        views_count INT DEFAULT 0,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7.2 Canvas Snapshots (版本控制与历史记录)
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        name VARCHAR(128) NOT NULL,
        snapshot_data JSONB NOT NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7.3 Tags (标签分类系统)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(64) NOT NULL,
        color VARCHAR(32) DEFAULT 'blue',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        UNIQUE(user_id, name)
      );
    `);

    // 7.4 Canvas Tags (画布标签关联)
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_tags (
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (canvas_id, tag_id)
      );
    `);

    // 7.5 User API Keys (BYOK - 自带密钥支持)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(32) NOT NULL,
        encrypted_key TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        UNIQUE(user_id, provider)
      );
    `);

    // 7.6 Feedbacks (用户反馈系统)
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        user_email VARCHAR(255),
        type VARCHAR(32) DEFAULT 'suggestion' NOT NULL,
        rating INT DEFAULT 5 NOT NULL,
        content TEXT NOT NULL,
        contact_info VARCHAR(255),
        status VARCHAR(32) DEFAULT 'pending' NOT NULL,
        admin_reply TEXT DEFAULT '',
        resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'pending';
      ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS admin_reply TEXT DEFAULT '';
      ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS resolved_by UUID;
      ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
      ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
    `);

    // 7.7 Node Attachments (节点参考资料与多模态附件)
    await client.query(`
      CREATE TABLE IF NOT EXISTS node_attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_size BIGINT NOT NULL,
        mime_type VARCHAR(128) NOT NULL,
        storage_url TEXT NOT NULL,
        parsed_text TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7.8 Canvas Templates (官方思维模板库)
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category VARCHAR(64) DEFAULT 'business' NOT NULL,
        title VARCHAR(128) NOT NULL,
        description TEXT NOT NULL,
        cover_image TEXT DEFAULT '',
        initial_data JSONB NOT NULL,
        tags TEXT[] DEFAULT ARRAY[]::TEXT[],
        usage_count INT DEFAULT 0 NOT NULL,
        is_official BOOLEAN DEFAULT TRUE NOT NULL,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7.9 AI Models Config (动态模型配置与路由)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_models_config (
        id VARCHAR(64) PRIMARY KEY,
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
    `);

    // 7.10 Notifications (站内消息与系统公告)
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(32) DEFAULT 'system' NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        link_url TEXT DEFAULT '',
        is_read BOOLEAN DEFAULT FALSE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7.11 User Audit Logs (安全审计日志)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(32),
        target_id VARCHAR(64),
        ip_address VARCHAR(45) DEFAULT '',
        user_agent TEXT DEFAULT '',
        details JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 8. Indices

    // 新增 PM 视角优化索引
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_canvas_shares_code ON canvas_shares(share_code);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas ON canvas_snapshots(canvas_id, created_at DESC);`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_canvases_user_updated ON canvases(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_canvas_id ON nodes(canvas_id);
      CREATE INDEX IF NOT EXISTS idx_edges_canvas_id ON edges(canvas_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON credit_transactions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
      CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_request_logs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_logs_canvas ON ai_request_logs(canvas_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_fulltext ON nodes
        USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(question, '') || ' ' || COALESCE(answer, '') || ' ' || COALESCE(content, '') || ' ' || COALESCE(note, '')));
    `);

    // Seed default admin in PG if table is empty
    const usersCountRes = await client.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(usersCountRes.rows[0].count, 10) === 0) {
      const adminHash = await hashPassword('Admin123456!');
      const userHash = await hashPassword('User123456!');
      const vipHash = await hashPassword('Vip123456!');

      await client.query(
        `INSERT INTO users (id, email, password_hash, name, role, credits_balance)
         VALUES
           ('00000000-0000-0000-0000-000000000001', 'admin@deepdive.ai', $1, '系统管理员', 'admin', 200000),
           ('00000000-0000-0000-0000-000000000002', 'user@deepdive.ai', $2, '探索先锋', 'user', 50000),
           ('00000000-0000-0000-0000-000000000003', 'vip@deepdive.ai', $3, '高级智囊', 'vip', 100000)
         ON CONFLICT (email) DO NOTHING`,
        [adminHash, userHash, vipHash]
      );
    }

    await client.query('COMMIT');
    schemaInitialized = true;
    console.log('✅ PostgreSQL schema & users verified and initialized.');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Failed to initialize PostgreSQL schema:', e);
    return false;
  } finally {
    client.release();
  }
}
