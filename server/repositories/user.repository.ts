import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { UserRecord } from '../core/records.js';
import { deleteUserSessions } from './session.repository.js';
import { handlePgError } from '../core/db-guard.js';

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
    reset_token: row.reset_token,
    reset_expires_at: row.reset_expires_at ? new Date(row.reset_expires_at).toISOString() : null,
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
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
      const res = await p.query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [normalizedEmail]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      handlePgError(e);
      console.warn('PG findUserByEmail fallback to in-memory:', e);
    }
  }

  for (const u of inMemoryStore.users.values()) {
    if (u.deleted_at) continue; // Spec F4：已注销用户语义上不存在
    if (u.email.toLowerCase() === normalizedEmail) return u;
  }
  return null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      handlePgError(e);
      console.warn('PG findUserById fallback to in-memory:', e);
    }
  }

  const u = inMemoryStore.users.get(id);
  if (!u || u.deleted_at) return null; // Spec F4：已注销用户语义上不存在
  return u;
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
      // Spec F4：email 查重（sign-up 链路 findUserByEmail）已排除 deleted，
      // partial 唯一索引（WHERE deleted_at IS NULL）允许同邮箱注销后以新 id 重新注册，
      // 因此这里恢复纯新建——新注册者不继承已注销账号的旧数据
      const res = await p.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active, failed_attempts, email_verified, verify_token, verify_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, 0, $6, $7, $8, NOW(), NOW())
         RETURNING *`,
        [id, email, data.passwordHash, name, role, emailVerified, data.verifyToken || null, data.verifyExpiresAt || null]
      );
      return res.rows[0];
    } catch (e) {
      handlePgError(e);
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
      handlePgError(e);
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
      handlePgError(e);
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

/**
 * Spec F1：写入/覆盖找回密码令牌（1h 有效）。双模。
 */
export async function setPasswordResetToken(userId: string, token: string, expiresAt: string): Promise<void> {
  const p = getPool();
  if (p) {
    try {
      await p.query(
        `UPDATE users SET reset_token = $1, reset_expires_at = $2, updated_at = NOW() WHERE id = $3`,
        [token, expiresAt, userId]
      );
      return;
    } catch (e) {
      handlePgError(e);
      console.warn('PG setPasswordResetToken failed, fallback to memory:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (user) {
    user.reset_token = token;
    user.reset_expires_at = expiresAt;
    user.updated_at = new Date().toISOString();
  }
}

/**
 * Spec F1：按找回密码令牌查找用户（仅供发起重置校验）。
 * 仅命中未过期（reset_expires_at > NOW()）的令牌；不清令牌（由 updateUserPassword 清空）。双模。
 */
export async function markPasswordResetByToken(token: string): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `SELECT * FROM users WHERE reset_token = $1 AND reset_expires_at > NOW() AND deleted_at IS NULL`,
        [token]
      );
      if (res.rows.length > 0) return mapRowToUser(res.rows[0]);
      return null;
    } catch (e) {
      handlePgError(e);
      console.warn('PG markPasswordResetByToken failed, fallback to memory:', e);
    }
  }

  for (const u of inMemoryStore.users.values()) {
    if (
      u.reset_token === token &&
      u.reset_expires_at &&
      new Date(u.reset_expires_at).getTime() > Date.now() &&
      !u.deleted_at
    ) {
      return u;
    }
  }
  return null;
}

/**
 * Spec F1：更新密码并清空找回密码令牌。双模。
 */
export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  const p = getPool();
  if (p) {
    try {
      await p.query(
        `UPDATE users
         SET password_hash = $1, reset_token = NULL, reset_expires_at = NULL, updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, userId]
      );
      return;
    } catch (e) {
      handlePgError(e);
      console.warn('PG updateUserPassword failed, fallback to memory:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (user) {
    user.password_hash = passwordHash;
    user.reset_token = null;
    user.reset_expires_at = null;
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
      handlePgError(e);
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
      handlePgError(e);
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
      handlePgError(e);
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
      handlePgError(e);
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
      handlePgError(e);
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

/**
 * Spec F4：软删除账号（注销）——置 deleted_at + is_active=false。
 * 踢下线为逻辑失效：findSession 排除 deleted_at 非空用户的会话（/me → 401）；
 * 会话记录的物理清理随 30 天硬删外键级联完成。
 * 双模：PG UPDATE / 内存置 deleted_at。用户不存在返回 false。
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `UPDATE users SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      return (res.rowCount || 0) > 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG deleteAccount failed, fallback to memory:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (!user) return false;
  user.deleted_at = new Date().toISOString();
  user.is_active = false;
  user.updated_at = new Date().toISOString();
  return true;
}

/**
 * Spec F4：硬删除超过冷却期（retentionDays 天）的已注销用户（外键级联清数据）。
 * retentionDays <= 0 表示全清（与 cleanupOldAuditLogs(0) 的全清语义一致，测试用），
 * 管理员账号不属业务清理范围、始终保留（保留 admin 账号以免破坏种子/运维登录）。返回删除条数。双模。
 */
/**
 * 内存模式级联：删除某用户的画板、相关分享，并把其画板的 AI 日志 canvas_id 置空
 * （对齐 PG 外键 ON DELETE CASCADE / ai_request_logs.canvas_id ON DELETE SET NULL）。
 * 2026-09-10 修复：原内存分支仅删会话，注销用户画板永久残留并被管理端统计计入。
 */
function purgeUserDataMemory(userId: string): void {
  const removedCanvasIds = new Set<string>();
  for (const [canvasId, canvas] of inMemoryStore.canvases.entries()) {
    if (canvas.user_id === userId) {
      inMemoryStore.canvases.delete(canvasId);
      removedCanvasIds.add(canvasId);
    }
  }
  if (removedCanvasIds.size === 0) return;
  for (const [shareId, share] of inMemoryStore.shares.entries()) {
    if (removedCanvasIds.has(share.canvas_id)) inMemoryStore.shares.delete(shareId);
  }
  for (const log of inMemoryStore.aiRequestLogs) {
    if (log.canvas_id && removedCanvasIds.has(log.canvas_id)) log.canvas_id = null;
  }
}

export async function cleanupDeletedUsers(retentionDays: number): Promise<number> {
  const p = getPool();
  if (p) {
    try {
      const res = retentionDays <= 0
        ? await p.query(`DELETE FROM users WHERE role <> 'admin' RETURNING id`)
        : await p.query(
            `DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= NOW() - make_interval(days => $1) RETURNING id`,
            [retentionDays]
          );
      return res.rowCount || 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG cleanupDeletedUsers failed, falling back to memory only:', e);
    }
  }

  if (retentionDays <= 0) {
    const removedIds: string[] = [];
    for (const [id, u] of inMemoryStore.users.entries()) {
      if (u.role === 'admin') continue;
      inMemoryStore.users.delete(id);
      removedIds.push(id);
    }
    for (const id of removedIds) {
      await deleteUserSessions(id);
      purgeUserDataMemory(id);
    }
    return removedIds.length;
  }

  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const removedIds: string[] = [];
  for (const [id, u] of inMemoryStore.users.entries()) {
    if (!u.deleted_at) continue;
    if (new Date(u.deleted_at).getTime() <= cutoff) {
      inMemoryStore.users.delete(id);
      removedIds.push(id);
    }
  }
  // 级联清理残留会话与画板数据（对应 PG 外键 ON DELETE CASCADE）
  for (const id of removedIds) {
    await deleteUserSessions(id);
    purgeUserDataMemory(id);
  }
  return removedIds.length;
}

/**
 * Spec F4：恢复已注销账号——清 deleted_at + is_active=true。
 * 未注销或不存在返回 null。双模。
 */
export async function restoreAccount(userId: string): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `UPDATE users SET deleted_at = NULL, is_active = TRUE, updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NOT NULL
         RETURNING *`,
        [userId]
      );
      if (res.rows.length > 0) return mapRowToUser(res.rows[0]);
      return null;
    } catch (e: any) {
      // 邮箱唯一冲突（冷却期内同邮箱已重新注册）向上抛，由 service 转 409
      if (e?.code === '23505') throw e;
      handlePgError(e);
      console.warn('PG restoreAccount failed, fallback to memory:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (!user || !user.deleted_at) return null;
  user.deleted_at = null;
  user.is_active = true;
  user.updated_at = new Date().toISOString();
  return user;
}

/**
 * 管理员修改用户邮箱：更新 email 并重置邮箱验证状态（Spec D3：新邮箱需重新验证）。
 * PG 唯一索引冲突（23505，partial index WHERE deleted_at IS NULL）向上抛由 service 转 409。
 * 双模。用户不存在返回 null。
 */
export async function updateUserEmail(
  userId: string,
  newEmail: string,
  verifyToken: string,
  verifyExpiresAt: string
): Promise<UserRecord | null> {
  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `UPDATE users
         SET email = $1,
             email_verified = FALSE,
             verify_token = $2,
             verify_expires_at = $3,
             updated_at = NOW()
         WHERE id = $4 AND deleted_at IS NULL
         RETURNING *`,
        [newEmail, verifyToken, verifyExpiresAt, userId]
      );
      if (res.rows.length > 0) return mapRowToUser(res.rows[0]);
      return null;
    } catch (e: any) {
      // 邮箱唯一冲突向上抛，由 service 转 409
      if (e?.code === '23505') throw e;
      handlePgError(e);
      console.warn('PG updateUserEmail failed, fallback to memory:', e);
    }
  }

  const user = inMemoryStore.users.get(userId);
  if (!user || user.deleted_at) return null;
  user.email = newEmail;
  user.email_verified = false;
  user.verify_token = verifyToken;
  user.verify_expires_at = verifyExpiresAt;
  user.updated_at = new Date().toISOString();
  return user;
}
