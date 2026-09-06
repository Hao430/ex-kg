import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { UserRecord } from '../core/records.js';

/** 将 PG 行映射为 UserRecord（数值/时间戳规范化） */
export function mapRowToUser(row: any): UserRecord {
  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    name: row.name,
    avatar: row.avatar,
    role: row.role,
    vip_expires_at: row.vip_expires_at ? new Date(row.vip_expires_at).toISOString() : null,
    email_verified: row.email_verified ?? false,
    verify_token: row.verify_token,
    verify_expires_at: row.verify_expires_at ? new Date(row.verify_expires_at).toISOString() : null,
    is_active: row.is_active,
    failed_attempts: row.failed_attempts,
    locked_until: row.locked_until,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

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
  emailVerified?: boolean;
  verifyToken?: string;
  verifyExpiresAt?: string;
}): Promise<UserRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const email = data.email.toLowerCase().trim();
  const name = data.name?.trim() || email.split('@')[0] || '思维探索者';
  const role = data.role || 'user';
  const emailVerified = data.emailVerified ?? false;

  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active, failed_attempts, email_verified, verify_token, verify_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, 0, $6, $7, $8, NOW(), NOW())
         RETURNING *`,
        [id, email, data.passwordHash, name, role, emailVerified, data.verifyToken || null, data.verifyExpiresAt || null]
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
    is_active: true,
    failed_attempts: 0,
    locked_until: null,
    last_login_at: null,
    email_verified: emailVerified,
    verify_token: data.verifyToken || null,
    verify_expires_at: data.verifyExpiresAt || null,
    created_at: now,
    updated_at: now,
  };
  inMemoryStore.users.set(id, user);
  return user;
}

/**
 * Spec D3：按验证令牌标记邮箱已验证。
 * 仅命中未过期（verify_expires_at > NOW()）的令牌；成功置 email_verified=true 并清空令牌，返回用户，否则 null。双模。
 */
export async function markEmailVerifiedByToken(token: string): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `UPDATE users
         SET email_verified = TRUE, verify_token = NULL, verify_expires_at = NULL, updated_at = NOW()
         WHERE verify_token = $1 AND verify_expires_at > NOW()
         RETURNING *`,
        [token]
      );
      if (res.rows.length > 0) return mapRowToUser(res.rows[0]);
      return null;
    } catch (e) {
      console.warn('PG markEmailVerifiedByToken failed, fallback to memory:', e);
    }
  }

  for (const u of inMemoryStore.users.values()) {
    if (
      u.verify_token === token &&
      u.verify_expires_at &&
      new Date(u.verify_expires_at).getTime() > Date.now()
    ) {
      u.email_verified = true;
      u.verify_token = null;
      u.verify_expires_at = null;
      u.updated_at = new Date().toISOString();
      return u;
    }
  }
  return null;
}

/**
 * Spec D3：写入/覆盖验证令牌（注册与重发共用）。双模。
 */
export async function setVerificationToken(userId: string, token: string, expiresAt: string): Promise<void> {
  const p = getPool();
  if (p) {
    try {
      await p.query(
        `UPDATE users SET verify_token = $1, verify_expires_at = $2, updated_at = NOW() WHERE id = $3`,
        [token, expiresAt, userId]
      );
      return;
    } catch (e) {
      console.warn('PG setVerificationToken failed, fallback to memory:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (user) {
    user.verify_token = token;
    user.verify_expires_at = expiresAt;
    user.updated_at = new Date().toISOString();
  }
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
      return { failedAttempts: attempts, lockedUntil };
    } catch (e) {
      console.warn('PG recordFailedLogin failed:', e);
    }
  }

  // 内存兜底（无 pool 或 PG 失败时才回写内存，PG 成功不双写）
  user.failed_attempts = attempts;
  user.locked_until = lockedUntil;
  return { failedAttempts: attempts, lockedUntil };
}

export async function resetFailedLogin(userId: string): Promise<void> {
  const p = getPool();
  if (p) {
    try {
      await p.query(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      return;
    } catch (e) {
      console.warn('PG resetFailedLogin failed:', e);
    }
  }

  // 内存兜底（无 pool 或 PG 失败时才回写内存）
  const user = inMemoryStore.users.get(userId);
  if (user) {
    user.failed_attempts = 0;
    user.locked_until = null;
    user.last_login_at = new Date().toISOString();
  }
}

export async function updateUserProfile(data: {
  userId: string;
  name?: string;
  avatar?: string;
}): Promise<UserRecord | null> {
  const now = new Date().toISOString();
  const user = await findUserById(data.userId);
  if (!user) return null;

  const newName = data.name !== undefined ? data.name.trim() : user.name;
  const newAvatar = data.avatar !== undefined ? data.avatar : user.avatar;

  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `UPDATE users SET name = $1, avatar = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [newName, newAvatar, data.userId]
      );
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      console.warn('PG updateUserProfile fallback to in-memory:', e);
    }
  }

  const inMem = inMemoryStore.users.get(data.userId);
  if (inMem) {
    inMem.name = newName;
    inMem.avatar = newAvatar;
    inMem.updated_at = now;
    return inMem;
  }

  user.name = newName;
  user.avatar = newAvatar;
  user.updated_at = now;
  return user;
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
        // 冻结强制踢下线（保留原语义）
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

/**
 * 更新用户的会员角色与到期时间（订阅 / Admin 赠送共用的纯 UPDATE 分支）。
 * PG 成功返回行记录；无 pool 或 PG 失败时回写内存并返回内存记录；用户不存在返回 null。
 */
export async function updateVipMembership(data: {
  userId: string;
  role: string;
  vipExpiresAt: string | null;
}): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `UPDATE users
         SET role = $1,
             vip_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [data.role, data.vipExpiresAt, data.userId]
      );
      if (res.rows.length > 0) return mapRowToUser(res.rows[0]);
    } catch (e) {
      console.warn('PG updateVipMembership failed, updating memory:', e);
    }
  }

  const memUser = inMemoryStore.users.get(data.userId);
  if (!memUser) return null;
  memUser.role = data.role as UserRecord['role'];
  memUser.vip_expires_at = data.vipExpiresAt;
  memUser.updated_at = new Date().toISOString();
  return memUser;
}
