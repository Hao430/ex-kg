import { getMigrationPool } from './pool.js';
import { hashPassword } from '../lib/crypto.js';

let schemaInitialized = false;

/**
 * ADR-0019：受 RLS 约束的表 → 谓词形态。这三份清单是**策略的唯一事实源**，
 * 由 `arch-tests/rls-coverage.test.mjs` 锁定「开策略的表 ∪ 豁免表 = 全部建表」，
 * 新增表若忘了归类会直接变红（漏一张表 = 一条静默的跨租户读通道）。
 */

/** 直接归属：`user_id = app.user_id` */
export const RLS_DIRECT_USER_TABLES = [
  'sessions',
  'canvases',
  'orders',
  'ai_request_logs',
  'tags',
  'folders',
  'user_api_keys',
  'feedbacks',
  'notifications',
  'user_audit_logs',
  'event_logs',
] as const;

/** 账号表本身：`id = app.user_id` */
export const RLS_SELF_ID_TABLES = ['users'] as const;

/** 间接归属（无 user_id 列）：经 canvas_id 回指 canvases 的属主 */
export const RLS_CANVAS_CHILD_TABLES = ['nodes', 'edges', 'canvas_shares'] as const;

/**
 * 显式豁免（不开 RLS）。每一项都必须写明理由——豁免就是一条**刻意**的跨租户通道：
 * - `system_settings`：全局配置（模型/支付/开关），非租户数据；
 * - `email_verification_codes`：账号建立**之前**按 email 寻址，此时无 app.user_id 可言；
 * - 余下 5 张是 #0004 待评估删除的空壳表，全仓零引用（2026-09-12 grep 核实），
 *   里面没有数据可保护；随 #0004 删除时一并从本清单移除。
 */
export const RLS_EXEMPT_TABLES = [
  'system_settings',
  'email_verification_codes',
  'canvas_snapshots',
  'canvas_tags',
  'node_attachments',
  'canvas_templates',
  'ai_models_config',
] as const;

/** 策略中的「当前请求用户」——NULLIF 防空串 cast 报错（SQLSTATE 22P02） */
const SELF_USER_ID = `NULLIF(current_setting('app.user_id', true), '')::uuid`;

/**
 * Initialize PostgreSQL tables and seed default users if not present
 */
export async function initDbSchema(): Promise<boolean> {
  const p = getMigrationPool();
  if (!p) return false;
  if (schemaInitialized) return true;

  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // Enable pgcrypto if possible（PG13+ 已内置 gen_random_uuid，扩展只为兼容旧库）。
    // ⚠️ 必须用 SAVEPOINT 包住：非超级用户角色无权 CREATE EXTENSION，裸 try/catch 会吞掉报错，
    // 而失败语句已让事务进入 aborted 状态 → 后续所有 DDL 一律 25P02，空库上整套建表静默全废。
    // 2026-09-10 踩坑：新库部署表现为「表全都不存在」，日志里只有一条被吞的错误。
    try {
      await client.query('SAVEPOINT pgcrypto_ext');
      await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
      await client.query('RELEASE SAVEPOINT pgcrypto_ext');
    } catch (extErr) {
      await client.query('ROLLBACK TO SAVEPOINT pgcrypto_ext').catch(() => {});
      console.warn(
        '[schema] 跳过 pgcrypto 扩展（无权限或不可用），gen_random_uuid 由 PG13+ 内置提供：',
        (extErr as { message?: string })?.message
      );
    }

    // 1. Users core table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL, -- 唯一性由下方 partial 索引保证（仅约束未注销用户，Spec F4）
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) DEFAULT '' NOT NULL,
        avatar TEXT,
        role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
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
      -- Spec D3：邮箱验证状态与令牌（24h 有效）
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires_at TIMESTAMPTZ;
      -- Spec F1：找回密码一次性令牌（1h 有效）
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ;
      -- Spec F4：注销软删除时间戳（30 天冷却恢复）
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
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
        default_model VARCHAR(64) DEFAULT '' NOT NULL, -- 默认模型由管理后台配置（ai_model_config），存列仅作画布级元数据
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
        -- 技术债 #0006：禁止 parent 自指（环链的最低防线；多节点环由 saveCanvas 写入路径校验）
        CONSTRAINT nodes_parent_id_no_self CHECK (id != parent_id),
        model_used VARCHAR(64) DEFAULT '', -- 默认模型由管理后台配置（ai_model_config），存列仅作节点级元数据
        grounding JSONB DEFAULT '[]'::jsonb,
        is_collapsed BOOLEAN DEFAULT FALSE NOT NULL,
        is_pinned BOOLEAN DEFAULT FALSE NOT NULL,
        branch_trigger_phrase TEXT DEFAULT '',
        enable_web_search BOOLEAN DEFAULT TRUE NOT NULL,
        color VARCHAR(32) DEFAULT '',
        tokens_used INT DEFAULT 0 NOT NULL,
        custom_data JSONB DEFAULT '{}'::jsonb,
        deleted_at TIMESTAMPTZ,
        -- 节点级合并的行级定序判据（ADR-0017）：写入瞬间 rev = rev + 1，行锁下串行 → 严格递增。
        -- 不能用 updated_at 代替：PG 的 NOW() 是事务开始时间，同事务内所有行共享同一个值。
        rev BIGINT DEFAULT 1 NOT NULL,
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
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 1;
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
        style JSONB,
        marker_end JSONB,
        deleted_at TIMESTAMPTZ,
        rev BIGINT DEFAULT 1 NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS source_handle VARCHAR(64);
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS target_handle VARCHAR(64);
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS label VARCHAR(255) DEFAULT '';
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS animated BOOLEAN DEFAULT FALSE;
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS style JSONB;
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS marker_end JSONB;
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 1;
      ALTER TABLE edges ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);

    // 6. Orders (会员订阅订单表)
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
      -- 可观测埋点扩列（Spec I）：provider 与推演链路明细，存量库幂等补列
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS provider VARCHAR(32) DEFAULT '' NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS web_search_calls INT DEFAULT 0 NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS raw_sources_count INT DEFAULT 0 NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS sources_truncated BOOLEAN DEFAULT FALSE NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS ttft_ms INT DEFAULT 0 NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS aborted BOOLEAN DEFAULT FALSE NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN DEFAULT FALSE NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS reset_count INT DEFAULT 0 NOT NULL;
      ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS candidate_failures INT DEFAULT 0 NOT NULL;
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
        -- Spec K1：快照式只读分享——创建时刻的全量画布快照（不可变，后续编辑不传播）
        snapshot_data JSONB,
        -- Spec K1：软撤销时间戳（非空 = 分享已失效，但保留行以便审计与重新分享覆盖）
        revoked_at TIMESTAMPTZ,
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

    // 7.4b Folders (Spec L1 / ADR-0015：单层分组，无 parent_id；删除分组只解除画板归属)
    await client.query(`
      CREATE TABLE IF NOT EXISTS folders (
        id VARCHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(64) NOT NULL,
        sort_order INT DEFAULT 0 NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
      ALTER TABLE canvases ADD COLUMN IF NOT EXISTS folder_id VARCHAR(64) REFERENCES folders(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_canvases_folder ON canvases(folder_id) WHERE deleted_at IS NULL;
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

    // 7.12 Email Verification Codes (注册邮箱验证码：验证先行才建号，email 唯一，一邮箱一码)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        email VARCHAR(255) PRIMARY KEY,
        code VARCHAR(6) NOT NULL,
        attempts INT DEFAULT 0 NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 7.13 Event Logs (业务事件埋点：画布冲突/配额拦截/推演容灾等，Spec I 可观测)
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category VARCHAR(32) NOT NULL,
        event VARCHAR(64) NOT NULL,
        entity_type VARCHAR(32),
        entity_id VARCHAR(64),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        num1 INT,
        num2 INT,
        details JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 8. Indices

    // 新增 PM 视角优化索引
      // Spec F4：邮箱唯一约束改为 partial——仅约束未注销用户，
      // 同邮箱可在注销（deleted_at 非空）后以新账号新 id 重新注册（数据所有权隔离）
      await client.query(`DROP INDEX IF EXISTS idx_users_email;`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;`);
      // 存量库迁移：删除旧版内联 UNIQUE 产生的全行唯一约束（会无视 deleted_at 阻断同邮箱重注册）
      await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;`);
      // 令牌为稀疏列，partial 索引缩小体积（重建替换旧的全量索引）
      await client.query(`DROP INDEX IF EXISTS idx_users_verify_token;`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token) WHERE verify_token IS NOT NULL;`);
      await client.query(`DROP INDEX IF EXISTS idx_users_reset_token;`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;`);
      // token/order_no/share_code 已有内联 UNIQUE 约束自带的唯一索引，去除冗余普通索引（纯写放大）
      await client.query(`DROP INDEX IF EXISTS idx_sessions_token;`);
      await client.query(`DROP INDEX IF EXISTS idx_orders_order_no;`);
      await client.query(`DROP INDEX IF EXISTS idx_canvas_shares_code;`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_expire ON sessions(user_id, expires_at);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_depth ON nodes(canvas_id, depth);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_edges_source_target ON edges(source_id, target_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas ON canvas_snapshots(canvas_id, created_at DESC);`);
      // 审计与通知高频查询路径（对齐 docs 建表脚本）
      await client.query(`CREATE INDEX IF NOT EXISTS idx_user_audit_user_action ON user_audit_logs(user_id, action, created_at DESC);`);
      // 技术债 #0018：Admin 审计日志分页查询路径——BRIN 不能提供有序输出，纯
      // ORDER BY created_at DESC 分页与"仅按 user_id 过滤"各需一条 B-tree
      await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_created_desc ON user_audit_logs(created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_user_created ON user_audit_logs(user_id, created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC);`);

    await client.query(`
      -- 软删画布/节点高频查询改为 partial 索引（重建替换旧的全量索引）
      DROP INDEX IF EXISTS idx_canvases_user_updated;
      CREATE INDEX IF NOT EXISTS idx_canvases_user_updated ON canvases(user_id, updated_at DESC) WHERE deleted_at IS NULL;
      DROP INDEX IF EXISTS idx_nodes_canvas_id;
      CREATE INDEX IF NOT EXISTS idx_nodes_canvas_id ON nodes(canvas_id) WHERE deleted_at IS NULL;
      -- 读路径一律带 deleted_at IS NULL（ADR-0017 墓碑语义），边索引同步改 partial
      DROP INDEX IF EXISTS idx_edges_canvas_id;
      CREATE INDEX IF NOT EXISTS idx_edges_canvas_id ON edges(canvas_id) WHERE deleted_at IS NULL;
      -- 墓碑 GC 扫描路径（server/jobs/log-cleanup.ts）：只关心已删行，partial 索引体积极小
      CREATE INDEX IF NOT EXISTS idx_nodes_deleted_at ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_edges_deleted_at ON edges(deleted_at) WHERE deleted_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_request_logs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_logs_canvas ON ai_request_logs(canvas_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_fulltext ON nodes
        USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(question, '') || ' ' || COALESCE(answer, '') || ' ' || COALESCE(content, '') || ' ' || COALESCE(note, '')));
    `);

    // BRIN 时间索引：日志表为追加型，供按 created_at 范围的清理任务使用，避免每 24h 全表扫描
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_logs_created_brin ON ai_request_logs USING BRIN(created_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_created_brin ON user_audit_logs USING BRIN(created_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_created_brin ON event_logs USING BRIN(created_at);`);
    // 业务事件高频查询路径（event 过滤 + 用户维度 + 时间排序）
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_logs_event ON event_logs(event, created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_logs_user ON event_logs(user_id, created_at DESC);`);

    // C 组清理迁移：点数体系已下线，删除历史遗留列与流水表
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS credits_balance;`);
    await client.query(`DROP TABLE IF EXISTS credit_transactions;`);

    // 技术债 #0006：存量库补 nodes 自指 CHECK（PG 无 ADD CONSTRAINT IF NOT EXISTS，先查 pg_constraint；
    // 上约束前修复历史自指脏数据——parent 指向自身无业务语义，置空处理）
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_parent_id_no_self') THEN
          UPDATE nodes SET parent_id = NULL WHERE parent_id = id;
          ALTER TABLE nodes ADD CONSTRAINT nodes_parent_id_no_self CHECK (id != parent_id);
        END IF;
      END $$;
    `);

    // 模型默认值中性化迁移：默认模型唯一来源为管理后台配置（ai_model_config），
    // 存量库同步将列默认值改为空串（写入路径始终显式赋值，此处仅口径对齐）
    await client.query(`ALTER TABLE canvases ALTER COLUMN default_model SET DEFAULT '';`);
    await client.query(`ALTER TABLE nodes ALTER COLUMN model_used SET DEFAULT '';`);

    // Spec K1：快照式只读分享——存量库补列 + 一画板至多一个活跃分享（重复 POST 幂等 upsert）
    await client.query(`ALTER TABLE canvas_shares ADD COLUMN IF NOT EXISTS snapshot_data JSONB;`);
    await client.query(`ALTER TABLE canvas_shares ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_shares_canvas ON canvas_shares(canvas_id);`
    );

    // Seed default admin in PG if table is empty
    const usersCountRes = await client.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(usersCountRes.rows[0].count, 10) === 0) {
      const adminHash = await hashPassword('Admin123456!');
      const userHash = await hashPassword('User123456!');
      const vipHash = await hashPassword('Vip123456!');

        // PG partial unique index does not support ON CONFLICT arbiter, use check-then-insert
        const existingEmails = await client.query(
          "SELECT email FROM users WHERE email IN ('admin@deepdive.ai', 'user@deepdive.ai', 'vip@deepdive.ai')"
        );
        const existingSet = new Set(existingEmails.rows.map((r: any) => r.email));
        const seeds = [
          { id: '00000000-0000-0000-0000-000000000001', email: 'admin@deepdive.ai', hash: adminHash, name: '系统管理员', role: 'admin' },
          { id: '00000000-0000-0000-0000-000000000002', email: 'user@deepdive.ai', hash: userHash, name: '探索先锋', role: 'user' },
          { id: '00000000-0000-0000-0000-000000000003', email: 'vip@deepdive.ai', hash: vipHash, name: '高级智囊', role: 'vip' },
        ];
        for (const s of seeds) {
          if (!existingSet.has(s.email)) {
            await client.query(
              `INSERT INTO users (id, email, password_hash, name, role, email_verified)
               VALUES ($1, $2, $3, $4, $5, TRUE)`,
              [s.id, s.email, s.hash, s.name, s.role]
            );
          }
        }
    }

    // Spec D3：种子账号（存量豁免）始终视为已验证
    await client.query(
      `UPDATE users SET email_verified = TRUE
       WHERE email IN ('admin@deepdive.ai', 'user@deepdive.ai', 'vip@deepdive.ai')`
    );

    // ---------- ADR-0019：行级安全（RLS）策略 ----------
    // 用 ENABLE 而非 FORCE：owner（syf_minapp）是迁移角色，必须能正常建表与 DML；
    // arborize_app 非属主，ENABLE 即对其生效。
    // ⚠️ **不得改成 FORCE**：canvas_probe 靠 SECURITY DEFINER 以属主身份执行来绕过策略，
    // FORCE 会让属主也受约束 → 探针静默返回 NULL → 跨租户保存退化成 404（ADR-0019）。
    const policySql: Array<[string, string]> = [
      ...RLS_DIRECT_USER_TABLES.map((t) => [t, `user_id = ${SELF_USER_ID}`] as [string, string]),
      ...RLS_SELF_ID_TABLES.map((t) => [t, `id = ${SELF_USER_ID}`] as [string, string]),
      ...RLS_CANVAS_CHILD_TABLES.map(
        (t) =>
          [
            t,
            // 子查询自身也被 canvases 的策略过滤，语义自洽：只能看见自己画布的节点/边/分享
            `canvas_id IN (SELECT id FROM canvases WHERE user_id = ${SELF_USER_ID})`,
          ] as [string, string]
      ),
    ];
    for (const [table, predicate] of policySql) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      // CREATE POLICY 没有 IF NOT EXISTS，先 DROP 保证本函数可重复执行（迁移是幂等的）
      await client.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
      await client.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${predicate}) WITH CHECK (${predicate})`
      );
    }

    // canvas_probe：跨租户归属探针（ADR-0019）。
    // RLS 让 app 角色看不见他人的行，而 saveCanvas 必须区分「不存在（新建/404）」与
    // 「存在但非属主（403）」，deleteCanvas / updateCanvasMeta / getCanvasOwnerInfo 同此。
    // 仅暴露「某 id 的归属」这一个事实：参数化、需知道 id 才能问、不泄露任何租户内容。
    // 参数声明为 VARCHAR 而非 TEXT —— canvases.id 是 VARCHAR(64)，声明成 TEXT 会让
    // `c.id = p_id` 退化为 `text = text`（列被隐式转换），索引失效。
    await client.query(`
      CREATE OR REPLACE FUNCTION canvas_probe(p_id VARCHAR)
      RETURNS TABLE (user_id UUID, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ)
      LANGUAGE sql
      SECURITY DEFINER
      STABLE
      SET search_path = pg_catalog, public
      AS $$
        SELECT c.user_id, c.updated_at, c.deleted_at FROM public.canvases c WHERE c.id = p_id
      $$
    `);
    // 默认 EXECUTE 授予 PUBLIC，先收回再按需授予（角色可能尚未创建：本地/CI 首轮）
    await client.query('REVOKE EXECUTE ON FUNCTION canvas_probe(VARCHAR) FROM PUBLIC');
    await client.query(`
      DO $$
      DECLARE r TEXT;
      BEGIN
        FOREACH r IN ARRAY ARRAY['arborize_app', 'arborize_system'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION canvas_probe(VARCHAR) TO %I', r);
          END IF;
        END LOOP;
      END $$
    `);

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
