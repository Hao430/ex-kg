import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { SessionRecord, UserRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

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
      return session;
    } catch (e) {
      handlePgError(e);
      console.warn('PG createSession failed, stored in memory:', e);
    }
  }

  // 内存兜底（无 pool 或 PG 失败时才写内存，PG 成功不双写）
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
                u.id as u_id, u.email, u.password_hash, u.name, u.avatar, u.role, u.vip_expires_at, u.email_verified, u.is_active, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at as user_created_at, u.updated_at as user_updated_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > NOW() AND u.deleted_at IS NULL`,
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
          avatar: row.avatar,
          role: row.role,
          vip_expires_at: row.vip_expires_at ? new Date(row.vip_expires_at).toISOString() : null,
          email_verified: row.email_verified ?? false,
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
      handlePgError(e);
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
  if (!u || u.deleted_at) return null; // Spec F4：已注销用户会话失效
  return { session: s, user: u };
}

export const findSessionByToken = findSession;

export async function deleteSession(token: string): Promise<boolean> {
  const p = getPool();
  if (p) {
    try {
      await p.query('DELETE FROM sessions WHERE token = $1', [token]);
    } catch (e) {
      handlePgError(e);
      console.warn('PG deleteSession failed:', e);
    }
  }
  // 清理型操作：PG 与内存都删，避免 PG 宕机切换时内存残留会话
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
      handlePgError(e);
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

/**
 * 清理已过期会话（供 F6 清理任务调用）：过期的会话此前仅在登出/硬删级联时移除，
 * 正常过期行会永久堆积。PG 与内存兜底都清理，返回清理条数。
 */
export async function cleanupExpiredSessions(): Promise<number> {
  let count = 0;
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('DELETE FROM sessions WHERE expires_at < NOW()');
      count = res.rowCount || 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG cleanupExpiredSessions failed, falling back to memory only:', e);
    }
  }

  const now = Date.now();
  for (const [token, s] of inMemoryStore.sessions.entries()) {
    if (new Date(s.expires_at).getTime() < now) {
      inMemoryStore.sessions.delete(token);
      count++;
    }
  }
  return count;
}
