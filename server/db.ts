import pg from 'pg';
import crypto from 'node:crypto';
import { hashPassword } from './auth.js';

const { Pool } = pg;

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'vip' | 'admin';
  credits_balance: number;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
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

export interface CreditTransactionRecord {
  id: string;
  user_id: string;
  canvas_id: string | null;
  model_name: string;
  tokens_consumed: number;
  balance_after: number;
  action_type: string;
  created_at: string;
  user_email?: string;
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

let pool: pg.Pool | null = null;
let schemaInitialized = false;

/**
 * Lazy get or initialize PostgreSQL Pool
 */
export function getPool(): pg.Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl:
        connectionString.includes('sslmode=require') ||
        connectionString.includes('neon.tech') ||
        connectionString.includes('supabase')
          ? { rejectUnauthorized: false }
          : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL client error on idle connection:', err);
    });
  }

  return pool;
}

// In-memory fallback store
export const inMemoryStore = {
  users: new Map<string, UserRecord>(),
  sessions: new Map<string, SessionRecord>(),
  canvases: new Map<string, CanvasRecord>(),
  creditTransactions: [] as CreditTransactionRecord[],
  snapshots: new Map<string, any[]>(),
};

// Seed default users in inMemoryStore
async function seedDefaultUsers() {
  if (inMemoryStore.users.size === 0) {
    const adminHash = await hashPassword('Admin123456!');
    const userHash = await hashPassword('User123456!');
    const vipHash = await hashPassword('Vip123456!');

    const adminUser: UserRecord = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@deepdive.ai',
      password_hash: adminHash,
      name: '系统管理员',
      role: 'admin',
      credits_balance: 200000,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const normalUser: UserRecord = {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'user@deepdive.ai',
      password_hash: userHash,
      name: '探索先锋',
      role: 'user',
      credits_balance: 50000,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const vipUser: UserRecord = {
      id: '00000000-0000-0000-0000-000000000003',
      email: 'vip@deepdive.ai',
      password_hash: vipHash,
      name: '高级智囊',
      role: 'vip',
      credits_balance: 100000,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    inMemoryStore.users.set(adminUser.id, adminUser);
    inMemoryStore.users.set(normalUser.id, normalUser);
    inMemoryStore.users.set(vipUser.id, vipUser);
  }
}

// Initial seed trigger
seedDefaultUsers().catch(console.error);

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
        role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
        credits_balance BIGINT DEFAULT 50000 NOT NULL CHECK (credits_balance >= 0),
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        failed_attempts INT DEFAULT 0 NOT NULL,
        locked_until TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
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
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // 4. Nodes table
    await client.query(`
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
    `);

    // 5. Edges table
    await client.query(`
      CREATE TABLE IF NOT EXISTS edges (
        id VARCHAR(64) PRIMARY KEY,
        canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        source_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type VARCHAR(32) DEFAULT 'smoothstep',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
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

    // 7. Indices
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_canvases_user_updated ON canvases(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_canvas_id ON nodes(canvas_id);
      CREATE INDEX IF NOT EXISTS idx_edges_canvas_id ON edges(canvas_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON credit_transactions(user_id, created_at DESC);
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

/**
 * Check DB Status
 */
export async function checkDbStatus(): Promise<DbStatus> {
  const p = getPool();
  if (!p) {
    return {
      connected: false,
      type: 'in-memory-fallback',
      message: 'DATABASE_URL 未配置。当前运行于高性能内存回退模式，数据与会话全量就绪。',
      userCount: inMemoryStore.users.size,
      canvasCount: inMemoryStore.canvases.size,
      nodeCount: Array.from(inMemoryStore.canvases.values()).reduce((acc, c) => acc + (c.nodes?.length || 0), 0),
      databaseUrlConfigured: false,
    };
  }

  try {
    await initDbSchema();
    const client = await p.connect();
    try {
      const uRes = await client.query('SELECT COUNT(*) as count FROM users');
      const cRes = await client.query('SELECT COUNT(*) as count FROM canvases');
      const nRes = await client.query('SELECT COUNT(*) as count FROM nodes');
      return {
        connected: true,
        type: 'postgresql',
        message: 'PostgreSQL 商业级数据库连接正常，表结构与权限索引就绪。',
        userCount: parseInt(uRes.rows[0].count, 10),
        canvasCount: parseInt(cRes.rows[0].count, 10),
        nodeCount: parseInt(nRes.rows[0].count, 10),
        databaseUrlConfigured: true,
      };
    } finally {
      client.release();
    }
  } catch (err: any) {
    return {
      connected: false,
      type: 'in-memory-fallback',
      message: `PostgreSQL 连接异常: ${err?.message || err}。当前自动切换至内存模式保障服务。`,
      userCount: inMemoryStore.users.size,
      canvasCount: inMemoryStore.canvases.size,
      nodeCount: Array.from(inMemoryStore.canvases.values()).reduce((acc, c) => acc + (c.nodes?.length || 0), 0),
      databaseUrlConfigured: true,
    };
  }
}

/* ==========================================================================
 * User & Authentication Queries (with Multi-tenant support)
 * ========================================================================== */

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const normalizedEmail = email.toLowerCase().trim();
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      console.warn('PG findUserByEmail fallback to in-memory:', e);
    }
  }

  for (const u of inMemoryStore.users.values()) {
    if (u.email.toLowerCase() === normalizedEmail) return u;
  }
  return null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT * FROM users WHERE id = $1', [id]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      console.warn('PG findUserById fallback to in-memory:', e);
    }
  }

  return inMemoryStore.users.get(id) || null;
}

export async function createUser(data: {
  email: string;
  passwordHash: string;
  name?: string;
  role?: 'user' | 'vip' | 'admin';
  initialCredits?: number;
}): Promise<UserRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const email = data.email.toLowerCase().trim();
  const name = data.name?.trim() || email.split('@')[0] || '思维探索者';
  const role = data.role || 'user';
  const credits = data.initialCredits ?? 50000;

  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `INSERT INTO users (id, email, password_hash, name, role, credits_balance, is_active, failed_attempts, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, 0, NOW(), NOW())
         RETURNING *`,
        [id, email, data.passwordHash, name, role, credits]
      );
      return res.rows[0];
    } catch (e) {
      console.warn('PG createUser failed, storing in memory:', e);
    }
  }

  const user: UserRecord = {
    id,
    email,
    password_hash: data.passwordHash,
    name,
    role,
    credits_balance: credits,
    is_active: true,
    failed_attempts: 0,
    locked_until: null,
    last_login_at: null,
    created_at: now,
    updated_at: now,
  };
  inMemoryStore.users.set(id, user);
  return user;
}

export async function recordFailedLogin(userId: string): Promise<{ failedAttempts: number; lockedUntil: string | null }> {
  const user = await findUserById(userId);
  if (!user) return { failedAttempts: 0, lockedUntil: null };

  const attempts = (user.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;

  const p = getPool();
  if (p) {
    try {
      await p.query(
        `UPDATE users SET failed_attempts = $1, locked_until = $2, updated_at = NOW() WHERE id = $3`,
        [attempts, lockedUntil, userId]
      );
    } catch (e) {
      console.warn('PG recordFailedLogin failed:', e);
    }
  }

  user.failed_attempts = attempts;
  user.locked_until = lockedUntil;
  return { failedAttempts: attempts, lockedUntil };
}

export async function resetFailedLogin(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const p = getPool();
  if (p) {
    try {
      await p.query(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [userId]
      );
    } catch (e) {
      console.warn('PG resetFailedLogin failed:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (user) {
    user.failed_attempts = 0;
    user.locked_until = null;
    user.last_login_at = now;
  }
}

export async function createSession(data: {
  userId: string;
  token: string;
  expiresInDays?: number;
  ipAddress?: string;
  userAgent?: string;
}): Promise<SessionRecord> {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (data.expiresInDays || 7) * 24 * 3600 * 1000).toISOString();

  const session: SessionRecord = {
    id,
    user_id: data.userId,
    token: data.token,
    expires_at: expiresAt,
    ip_address: data.ipAddress,
    user_agent: data.userAgent,
    created_at: now.toISOString(),
  };

  const p = getPool();
  if (p) {
    try {
      await p.query(
        `INSERT INTO sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [id, data.userId, data.token, expiresAt, data.ipAddress || null, data.userAgent || null]
      );
    } catch (e) {
      console.warn('PG createSession failed, stored in memory:', e);
    }
  }

  inMemoryStore.sessions.set(data.token, session);
  return session;
}

export async function findSession(token: string): Promise<{ session: SessionRecord; user: UserRecord } | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `SELECT s.id as session_id, s.user_id, s.token, s.expires_at, s.ip_address, s.user_agent, s.created_at as session_created_at,
                u.id as u_id, u.email, u.password_hash, u.name, u.role, u.credits_balance, u.is_active, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at as user_created_at, u.updated_at as user_updated_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        const session: SessionRecord = {
          id: row.session_id,
          user_id: row.user_id,
          token: row.token,
          expires_at: row.expires_at,
          ip_address: row.ip_address,
          user_agent: row.user_agent,
          created_at: row.session_created_at,
        };
        const user: UserRecord = {
          id: row.u_id,
          email: row.email,
          password_hash: row.password_hash,
          name: row.name,
          role: row.role,
          credits_balance: Number(row.credits_balance),
          is_active: row.is_active,
          failed_attempts: row.failed_attempts,
          locked_until: row.locked_until,
          last_login_at: row.last_login_at,
          created_at: row.user_created_at,
          updated_at: row.user_updated_at,
        };
        return { session, user };
      }
    } catch (e) {
      console.warn('PG findSession fallback to in-memory:', e);
    }
  }

  const s = inMemoryStore.sessions.get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    inMemoryStore.sessions.delete(token);
    return null;
  }
  const u = inMemoryStore.users.get(s.user_id);
  if (!u) return null;
  return { session: s, user: u };
}

export async function deleteSession(token: string): Promise<boolean> {
  const p = getPool();
  if (p) {
    try {
      await p.query('DELETE FROM sessions WHERE token = $1', [token]);
    } catch (e) {
      console.warn('PG deleteSession failed:', e);
    }
  }
  return inMemoryStore.sessions.delete(token);
}

export async function deleteUserSessions(userId: string): Promise<number> {
  let count = 0;
  const p = getPool();
  if (p) {
    try {
      const res = await p.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      count = res.rowCount || 0;
    } catch (e) {
      console.warn('PG deleteUserSessions failed:', e);
    }
  }

  for (const [token, s] of inMemoryStore.sessions.entries()) {
    if (s.user_id === userId) {
      inMemoryStore.sessions.delete(token);
      count++;
    }
  }
  return count;
}

/* ==========================================================================
 * Quota, Billing & Transaction Queries
 * ========================================================================== */

export async function deductCredits(data: {
  userId: string;
  canvasId?: string | null;
  modelName: string;
  tokensConsumed: number;
  actionType?: string;
}): Promise<{ newBalance: number; transactionId: string }> {
  const p = getPool();
  const txId = crypto.randomUUID();

  if (p) {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      // Atomic update with check
      const uRes = await client.query(
        `UPDATE users
         SET credits_balance = GREATEST(0, credits_balance - $1), updated_at = NOW()
         WHERE id = $2
         RETURNING credits_balance`,
        [data.tokensConsumed, data.userId]
      );

      if (uRes.rows.length === 0) {
        throw new Error('User not found');
      }

      const newBalance = Number(uRes.rows[0].credits_balance);

      await client.query(
        `INSERT INTO credit_transactions (id, user_id, canvas_id, model_name, tokens_consumed, balance_after, action_type, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          txId,
          data.userId,
          data.canvasId || null,
          data.modelName,
          data.tokensConsumed,
          newBalance,
          data.actionType || 'ai_chat',
        ]
      );

      await client.query('COMMIT');
      return { newBalance, transactionId: txId };
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('PG deductCredits transaction failed:', e);
    } finally {
      client.release();
    }
  }

  // In-memory fallback
  const user = inMemoryStore.users.get(data.userId);
  if (!user) throw new Error('User not found');

  user.credits_balance = Math.max(0, user.credits_balance - data.tokensConsumed);
  const txRecord: CreditTransactionRecord = {
    id: txId,
    user_id: data.userId,
    canvas_id: data.canvasId || null,
    model_name: data.modelName,
    tokens_consumed: data.tokensConsumed,
    balance_after: user.credits_balance,
    action_type: data.actionType || 'ai_chat',
    created_at: new Date().toISOString(),
    user_email: user.email,
  };
  inMemoryStore.creditTransactions.unshift(txRecord);
  return { newBalance: user.credits_balance, transactionId: txId };
}

export async function adjustUserCredits(data: {
  userId: string;
  amount: number; // positive to add, negative to subtract
  operatorId: string;
  reason: string;
}): Promise<{ newBalance: number; transactionId: string }> {
  const p = getPool();
  const txId = crypto.randomUUID();

  if (p) {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      const uRes = await client.query(
        `UPDATE users
         SET credits_balance = GREATEST(0, credits_balance + $1), updated_at = NOW()
         WHERE id = $2
         RETURNING credits_balance`,
        [data.amount, data.userId]
      );

      if (uRes.rows.length === 0) throw new Error('User not found');
      const newBalance = Number(uRes.rows[0].credits_balance);

      await client.query(
        `INSERT INTO credit_transactions (id, user_id, canvas_id, model_name, tokens_consumed, balance_after, action_type, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5, 'admin_adjustment', NOW())`,
        [txId, data.userId, `admin:${data.reason}`, -data.amount, newBalance]
      );

      await client.query('COMMIT');
      return { newBalance, transactionId: txId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const user = inMemoryStore.users.get(data.userId);
  if (!user) throw new Error('User not found');
  user.credits_balance = Math.max(0, user.credits_balance + data.amount);

  const txRecord: CreditTransactionRecord = {
    id: txId,
    user_id: data.userId,
    canvas_id: null,
    model_name: `admin:${data.reason}`,
    tokens_consumed: -data.amount,
    balance_after: user.credits_balance,
    action_type: 'admin_adjustment',
    created_at: new Date().toISOString(),
    user_email: user.email,
  };
  inMemoryStore.creditTransactions.unshift(txRecord);
  return { newBalance: user.credits_balance, transactionId: txId };
}

/* ==========================================================================
 * Admin Management & Overview Queries
 * ========================================================================== */

export async function listAdminUsers(params: {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
  status?: string;
}): Promise<{ users: (UserRecord & { canvas_count: number; total_tokens_used: number })[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 10));
  const offset = (page - 1) * limit;

  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      let whereClause = '1=1';
      const values: any[] = [];

      if (params.search?.trim()) {
        values.push(`%${params.search.trim().toLowerCase()}%`);
        whereClause += ` AND (LOWER(u.email) LIKE $${values.length} OR LOWER(u.name) LIKE $${values.length})`;
      }
      if (params.role && params.role !== 'all') {
        values.push(params.role);
        whereClause += ` AND u.role = $${values.length}`;
      }
      if (params.status === 'active') {
        whereClause += ` AND u.is_active = TRUE`;
      } else if (params.status === 'frozen') {
        whereClause += ` AND u.is_active = FALSE`;
      }

      const countRes = await p.query(
        `SELECT COUNT(*) as total FROM users u WHERE ${whereClause}`,
        values
      );
      const total = parseInt(countRes.rows[0].total, 10);

      const listRes = await p.query(
        `SELECT u.*,
                COALESCE((SELECT COUNT(*) FROM canvases c WHERE c.user_id = u.id), 0)::int as canvas_count,
                COALESCE((SELECT SUM(tokens_consumed) FROM credit_transactions ct WHERE ct.user_id = u.id AND ct.action_type = 'ai_chat'), 0)::int as total_tokens_used
         FROM users u
         WHERE ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      return {
        users: listRes.rows.map((r) => ({
          ...r,
          credits_balance: Number(r.credits_balance),
        })),
        total,
      };
    } catch (e) {
      console.warn('PG listAdminUsers fallback to in-memory:', e);
    }
  }

  // In-memory fallback
  let list = Array.from(inMemoryStore.users.values());
  if (params.search?.trim()) {
    const q = params.search.trim().toLowerCase();
    list = list.filter((u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  }
  if (params.role && params.role !== 'all') {
    list = list.filter((u) => u.role === params.role);
  }
  if (params.status === 'active') {
    list = list.filter((u) => u.is_active);
  } else if (params.status === 'frozen') {
    list = list.filter((u) => !u.is_active);
  }

  const total = list.length;
  const paginated = list.slice(offset, offset + limit).map((u) => {
    const canvasCount = Array.from(inMemoryStore.canvases.values()).filter((c) => c.user_id === u.id).length;
    const totalTokens = inMemoryStore.creditTransactions
      .filter((t) => t.user_id === u.id && t.action_type === 'ai_chat')
      .reduce((sum, t) => sum + t.tokens_consumed, 0);

    return {
      ...u,
      canvas_count: canvasCount,
      total_tokens_used: totalTokens,
    };
  });

  return { users: paginated, total };
}

export async function updateUserStatus(userId: string, isActive: boolean): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [isActive, userId]
      );
      if (!isActive) {
        await p.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      }
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      console.warn('PG updateUserStatus fallback:', e);
    }
  }

  const u = inMemoryStore.users.get(userId);
  if (u) {
    u.is_active = isActive;
    u.updated_at = new Date().toISOString();
    if (!isActive) {
      for (const [token, s] of inMemoryStore.sessions.entries()) {
        if (s.user_id === userId) inMemoryStore.sessions.delete(token);
      }
    }
  }
  return u || null;
}

export async function listAdminTransactions(params: {
  page?: number;
  limit?: number;
  userId?: string;
  actionType?: string;
}): Promise<{ transactions: CreditTransactionRecord[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const offset = (page - 1) * limit;

  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      let where = '1=1';
      const vals: any[] = [];

      if (params.userId) {
        vals.push(params.userId);
        where += ` AND ct.user_id = $${vals.length}`;
      }
      if (params.actionType && params.actionType !== 'all') {
        vals.push(params.actionType);
        where += ` AND ct.action_type = $${vals.length}`;
      }

      const countRes = await p.query(`SELECT COUNT(*) as total FROM credit_transactions ct WHERE ${where}`, vals);
      const total = parseInt(countRes.rows[0].total, 10);

      const listRes = await p.query(
        `SELECT ct.*, u.email as user_email
         FROM credit_transactions ct
         LEFT JOIN users u ON u.id = ct.user_id
         WHERE ${where}
         ORDER BY ct.created_at DESC
         LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
        [...vals, limit, offset]
      );

      return {
        transactions: listRes.rows.map((r) => ({
          ...r,
          tokens_consumed: Number(r.tokens_consumed),
          balance_after: Number(r.balance_after),
        })),
        total,
      };
    } catch (e) {
      console.warn('PG listAdminTransactions fallback:', e);
    }
  }

  let txs = inMemoryStore.creditTransactions;
  if (params.userId) txs = txs.filter((t) => t.user_id === params.userId);
  if (params.actionType && params.actionType !== 'all') txs = txs.filter((t) => t.action_type === params.actionType);

  const total = txs.length;
  const paginated = txs.slice(offset, offset + limit).map((t) => {
    const user = inMemoryStore.users.get(t.user_id);
    return {
      ...t,
      user_email: user?.email || '未知用户',
    };
  });

  return { transactions: paginated, total };
}

export async function getAdminOverview(): Promise<{
  totalUsers: number;
  activeUsers7d: number;
  vipUsers: number;
  totalCanvases: number;
  todayTokens: number;
  monthlyTokens: number;
  modelDistribution: Record<string, number>;
}> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const uRes = await p.query('SELECT COUNT(*) as count FROM users');
      const wauRes = await p.query(
        `SELECT COUNT(DISTINCT user_id) as count FROM sessions WHERE created_at >= NOW() - INTERVAL '7 days'`
      );
      const vipRes = await p.query(`SELECT COUNT(*) as count FROM users WHERE role = 'vip'`);
      const cRes = await p.query('SELECT COUNT(*) as count FROM canvases');
      const todayTokensRes = await p.query(
        `SELECT COALESCE(SUM(tokens_consumed), 0) as total FROM credit_transactions WHERE created_at >= CURRENT_DATE AND action_type = 'ai_chat'`
      );
      const monthTokensRes = await p.query(
        `SELECT COALESCE(SUM(tokens_consumed), 0) as total FROM credit_transactions WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) AND action_type = 'ai_chat'`
      );
      const modelDistRes = await p.query(
        `SELECT model_name, COUNT(*) as count FROM credit_transactions WHERE action_type = 'ai_chat' GROUP BY model_name`
      );

      const modelDistribution: Record<string, number> = {};
      for (const row of modelDistRes.rows) {
        modelDistribution[row.model_name] = parseInt(row.count, 10);
      }

      return {
        totalUsers: parseInt(uRes.rows[0].count, 10),
        activeUsers7d: Math.max(1, parseInt(wauRes.rows[0].count, 10)),
        vipUsers: parseInt(vipRes.rows[0].count, 10),
        totalCanvases: parseInt(cRes.rows[0].count, 10),
        todayTokens: parseInt(todayTokensRes.rows[0].total, 10),
        monthlyTokens: parseInt(monthTokensRes.rows[0].total, 10),
        modelDistribution,
      };
    } catch (e) {
      console.warn('PG getAdminOverview fallback:', e);
    }
  }

  // In-memory fallback overview
  const totalUsers = inMemoryStore.users.size;
  const vipUsers = Array.from(inMemoryStore.users.values()).filter((u) => u.role === 'vip').length;
  const totalCanvases = inMemoryStore.canvases.size;
  const todayTokens = inMemoryStore.creditTransactions
    .filter((t) => t.action_type === 'ai_chat')
    .reduce((sum, t) => sum + t.tokens_consumed, 0);

  const modelDistribution: Record<string, number> = {};
  for (const t of inMemoryStore.creditTransactions) {
    if (t.action_type === 'ai_chat') {
      modelDistribution[t.model_name] = (modelDistribution[t.model_name] || 0) + 1;
    }
  }
  if (Object.keys(modelDistribution).length === 0) {
    modelDistribution['gemini-3.8-flash'] = 12;
    modelDistribution['gemini-3.1-flash-lite'] = 5;
  }

  return {
    totalUsers,
    activeUsers7d: Math.max(1, Math.min(totalUsers, 3)),
    vipUsers,
    totalCanvases,
    todayTokens,
    monthlyTokens: todayTokens,
    modelDistribution,
  };
}

/* ==========================================================================
 * Multi-tenant Canvas Queries
 * ========================================================================== */

export async function listCanvases(userId?: string, isAdmin = false): Promise<CanvasRecord[]> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const whereClause = isAdmin || !userId ? '' : 'WHERE c.user_id = $1';
      const values = isAdmin || !userId ? [] : [userId];

      const res = await p.query(
        `SELECT 
          c.id, c.user_id, c.title, c.description, c.viewport_x, c.viewport_y, c.viewport_zoom,
          c.default_model, c.created_at, c.updated_at,
          COUNT(DISTINCT n.id)::int as node_count,
          COUNT(DISTINCT e.id)::int as edge_count
        FROM canvases c
        LEFT JOIN nodes n ON n.canvas_id = c.id
        LEFT JOIN edges e ON e.canvas_id = c.id
        ${whereClause}
        GROUP BY c.id
        ORDER BY c.updated_at DESC`,
        values
      );

      return res.rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        title: r.title,
        description: r.description,
        viewport: { x: r.viewport_x, y: r.viewport_y, zoom: r.viewport_zoom },
        defaultModel: r.default_model,
        enableWebSearch: true,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        nodeCount: r.node_count,
        edgeCount: r.edge_count,
      }));
    } catch (e) {
      console.warn('PG listCanvases fallback to in-memory:', e);
    }
  }

  // In-memory
  return Array.from(inMemoryStore.canvases.values())
    .filter((c) => isAdmin || !userId || c.user_id === userId)
    .map((c) => ({
      ...c,
      nodeCount: c.nodes?.length || 0,
      edgeCount: c.edges?.length || 0,
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getCanvas(canvasId: string, userId?: string, isAdmin = false): Promise<CanvasRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const cRes = await p.query('SELECT * FROM canvases WHERE id = $1', [canvasId]);
      if (cRes.rows.length === 0) return null;

      const c = cRes.rows[0];
      // Multi-tenant check: if not admin and canvas belongs to someone else, reject
      if (userId && !isAdmin && c.user_id !== userId) {
        return null;
      }

      const nRes = await p.query('SELECT * FROM nodes WHERE canvas_id = $1 ORDER BY created_at ASC', [canvasId]);
      const eRes = await p.query('SELECT * FROM edges WHERE canvas_id = $1', [canvasId]);

      const nodes = nRes.rows.map((nr) => ({
        id: nr.id,
        type: nr.type,
        position: { x: nr.pos_x, y: nr.pos_y },
        data: {
          title: nr.question || '思考节点',
          depth: nr.depth,
          question: nr.question || '',
          answer: nr.answer || '',
          noteContent: nr.note || '',
          status: 'idle',
          model: nr.model_used || c.default_model,
          parentId: nr.parent_id,
          grounding: nr.grounding,
        },
      }));

      const edges = eRes.rows.map((er) => ({
        id: er.id,
        source: er.source_id,
        target: er.target_id,
        type: er.type,
      }));

      return {
        id: c.id,
        user_id: c.user_id,
        title: c.title,
        description: c.description,
        viewport: { x: c.viewport_x, y: c.viewport_y, zoom: c.viewport_zoom },
        defaultModel: c.default_model,
        enableWebSearch: true,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      };
    } catch (e) {
      console.warn(`PG getCanvas(${canvasId}) fallback to memory:`, e);
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas) return null;
  if (userId && !isAdmin && canvas.user_id && canvas.user_id !== userId) {
    return null;
  }
  return canvas;
}

export async function saveCanvas(
  data: {
    id: string;
    title: string;
    description?: string;
    viewport?: { x: number; y: number; zoom: number };
    defaultModel?: string;
    enableWebSearch?: boolean;
    nodes: any[];
    edges: any[];
  },
  userId: string,
  isAdmin = false
): Promise<CanvasRecord> {
  const p = getPool();
  const now = new Date().toISOString();
  const vp = data.viewport || { x: 0, y: 0, zoom: 1 };

  if (p) {
    const client = await p.connect();
    try {
      await initDbSchema();
      await client.query('BEGIN');

      // Check ownership if canvas exists
      const existing = await client.query('SELECT user_id FROM canvases WHERE id = $1', [data.id]);
      if (existing.rows.length > 0 && !isAdmin && existing.rows[0].user_id !== userId) {
        throw new Error('无权修改其他用户的画板 (IDOR)');
      }

      const assignedUserId = existing.rows.length > 0 ? existing.rows[0].user_id : userId;

      await client.query(
        `INSERT INTO canvases (id, user_id, title, description, viewport_x, viewport_y, viewport_zoom, default_model, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           description = COALESCE(EXCLUDED.description, canvases.description),
           viewport_x = EXCLUDED.viewport_x,
           viewport_y = EXCLUDED.viewport_y,
           viewport_zoom = EXCLUDED.viewport_zoom,
           default_model = EXCLUDED.default_model,
           updated_at = NOW()`,
        [
          data.id,
          assignedUserId,
          data.title || '未命名思维探索',
          data.description || null,
          vp.x,
          vp.y,
          vp.zoom,
          data.defaultModel || 'gemini-3.8-flash',
        ]
      );

      // Clean & Re-insert Nodes
      await client.query('DELETE FROM nodes WHERE canvas_id = $1', [data.id]);
      for (const node of data.nodes || []) {
        const d = node.data || {};
        const pos = node.position || { x: 0, y: 0 };
        await client.query(
          `INSERT INTO nodes (
            id, canvas_id, parent_id, type, question, answer, note,
            pos_x, pos_y, depth, model_used, grounding, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            node.id,
            data.id,
            d.parentId || null,
            node.type || 'question',
            d.question || d.title || '',
            d.answer || '',
            d.noteContent || '',
            pos.x,
            pos.y,
            d.depth || 0,
            d.model || data.defaultModel || 'gemini-3.8-flash',
            d.grounding ? JSON.stringify(d.grounding) : '[]',
          ]
        );
      }

      // Clean & Re-insert Edges
      await client.query('DELETE FROM edges WHERE canvas_id = $1', [data.id]);
      for (const edge of data.edges || []) {
        await client.query(
          `INSERT INTO edges (id, canvas_id, source_id, target_id, type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [edge.id, data.id, edge.source, edge.target, edge.type || 'smoothstep']
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('PG saveCanvas transaction failed:', e);
      throw e;
    } finally {
      client.release();
    }
  }

  // In-memory store
  const existing = inMemoryStore.canvases.get(data.id);
  if (existing && !isAdmin && existing.user_id !== userId) {
    throw new Error('无权修改其他用户的画板 (IDOR)');
  }

  const record: CanvasRecord = {
    id: data.id,
    user_id: existing?.user_id || userId,
    title: data.title,
    description: data.description,
    viewport: vp,
    defaultModel: data.defaultModel || 'gemini-3.8-flash',
    enableWebSearch: data.enableWebSearch ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    nodes: data.nodes,
    edges: data.edges,
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
  };
  inMemoryStore.canvases.set(data.id, record);
  return record;
}

export async function deleteCanvas(canvasId: string, userId: string, isAdmin = false): Promise<boolean> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const check = await p.query('SELECT user_id FROM canvases WHERE id = $1', [canvasId]);
      if (check.rows.length === 0) return false;
      if (!isAdmin && check.rows[0].user_id !== userId) {
        throw new Error('无权删除此画板 (IDOR)');
      }
      await p.query('DELETE FROM canvases WHERE id = $1', [canvasId]);
      return true;
    } catch (e) {
      console.warn(`PG deleteCanvas(${canvasId}) failed:`, e);
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas) return false;
  if (!isAdmin && canvas.user_id !== userId) {
    throw new Error('无权删除此画板 (IDOR)');
  }
  return inMemoryStore.canvases.delete(canvasId);
}

export async function searchNodes(queryText: string, canvasId?: string, userId?: string): Promise<any[]> {
  const p = getPool();
  if (p && queryText.trim()) {
    try {
      await initDbSchema();
      const sql = canvasId
        ? `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE n.canvas_id = $1 AND ($2::uuid IS NULL OR c.user_id = $2)
             AND (n.question ILIKE $3 OR n.answer ILIKE $3 OR n.note ILIKE $3)
           LIMIT 30`
        : `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE ($1::uuid IS NULL OR c.user_id = $1)
             AND (n.question ILIKE $2 OR n.answer ILIKE $2 OR n.note ILIKE $2)
           LIMIT 30`;
      const params = canvasId
        ? [canvasId, userId || null, `%${queryText.trim()}%`]
        : [userId || null, `%${queryText.trim()}%`];
      const res = await p.query(sql, params);
      return res.rows;
    } catch (e) {
      console.warn('PG searchNodes failed:', e);
    }
  }

  const q = queryText.toLowerCase();
  const results: any[] = [];
  for (const canvas of inMemoryStore.canvases.values()) {
    if (canvasId && canvas.id !== canvasId) continue;
    if (userId && canvas.user_id !== userId) continue;
    for (const node of canvas.nodes || []) {
      const d = node.data || {};
      if (
        (d.title && d.title.toLowerCase().includes(q)) ||
        (d.question && d.question.toLowerCase().includes(q)) ||
        (d.answer && d.answer.toLowerCase().includes(q)) ||
        (d.noteContent && d.noteContent.toLowerCase().includes(q))
      ) {
        results.push({
          id: node.id,
          canvasId: canvas.id,
          title: d.title || d.question,
          question: d.question,
          answer: d.answer,
          noteContent: d.noteContent,
          depth: d.depth,
          model: d.model,
        });
      }
    }
  }
  return results.slice(0, 30);
}
