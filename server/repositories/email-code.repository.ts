import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { EmailCodeRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

/** 连错上限：达 5 次即作废当前验证码（需重新获取） */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

function isExpired(rec: EmailCodeRecord): boolean {
  return new Date(rec.expires_at).getTime() <= Date.now();
}

/**
 * 注册邮箱验证码：写入/覆盖验证码（attempts 归零），并机会式清理已过期行。双模。
 */
export async function upsertCode(email: string, code: string, expiresAt: string): Promise<void> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      // 机会式清理：写入新码时顺带删除全表过期行（表基数 ≤ distinct 尝试邮箱数，无增长风险）
      await p.query(`DELETE FROM email_verification_codes WHERE expires_at < NOW()`);
      await p.query(
        `INSERT INTO email_verification_codes (email, code, attempts, expires_at, updated_at)
         VALUES ($1, $2, 0, $3, NOW())
         ON CONFLICT (email) DO UPDATE SET code = $2, attempts = 0, expires_at = $3, updated_at = NOW()`,
        [email, code, expiresAt]
      );
      return;
    } catch (e) {
      handlePgError(e);
      console.warn('PG upsertCode failed, fallback to memory:', e);
    }
  }

  for (const [key, rec] of inMemoryStore.emailVerificationCodes) {
    if (isExpired(rec)) inMemoryStore.emailVerificationCodes.delete(key);
  }
  inMemoryStore.emailVerificationCodes.set(email, {
    email,
    code,
    attempts: 0,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });
}

/**
 * 注册邮箱验证码：读取（供发送冷却判断）。过期视为不存在。双模。
 */
export async function getCode(email: string): Promise<EmailCodeRecord | null> {
  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `SELECT * FROM email_verification_codes WHERE email = $1 AND expires_at > NOW()`,
        [email]
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        email: row.email,
        code: row.code,
        attempts: row.attempts,
        expires_at: new Date(row.expires_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };
    } catch (e) {
      handlePgError(e);
      console.warn('PG getCode failed, fallback to memory:', e);
    }
  }

  const rec = inMemoryStore.emailVerificationCodes.get(email);
  if (!rec || isExpired(rec)) return null;
  return rec;
}

/**
 * 注册邮箱验证码：消费验证码。
 * 成功 → 原子删除行（PG 以 DELETE rowCount 判定，天然防重放/并发；内存读-比-删同同步块）；
 * 不存在/已过期/已作废 → invalid；码不匹配 → mismatch 并累计 attempts，达上限即作废。双模。
 */
export async function consumeCode(
  email: string,
  code: string
): Promise<{ result: 'ok' } | { result: 'invalid' } | { result: 'mismatch'; attempts: number }> {
  const p = getPool();
  if (p) {
    try {
      const del = await p.query(
        `DELETE FROM email_verification_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()`,
        [email, code]
      );
      if (del.rowCount && del.rowCount > 0) return { result: 'ok' };

      const sel = await p.query(
        `SELECT attempts FROM email_verification_codes WHERE email = $1 AND expires_at > NOW()`,
        [email]
      );
      if (sel.rows.length === 0) return { result: 'invalid' };
      const attempts = Number(sel.rows[0].attempts) + 1;
      if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
        await p.query(`DELETE FROM email_verification_codes WHERE email = $1`, [email]);
      } else {
        await p.query(
          `UPDATE email_verification_codes SET attempts = $2, updated_at = NOW() WHERE email = $1`,
          [email, attempts]
        );
      }
      return { result: 'mismatch', attempts };
    } catch (e) {
      handlePgError(e);
      console.warn('PG consumeCode failed, fallback to memory:', e);
    }
  }

  // 内存路径：读-比-删必须在同一同步代码块内完成（Node 事件循环保证原子），中间不得插入 await
  const rec = inMemoryStore.emailVerificationCodes.get(email);
  if (!rec || isExpired(rec)) return { result: 'invalid' };
  if (rec.code !== code) {
    rec.attempts += 1;
    rec.updated_at = new Date().toISOString();
    if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      inMemoryStore.emailVerificationCodes.delete(email);
    }
    return { result: 'mismatch', attempts: rec.attempts };
  }
  inMemoryStore.emailVerificationCodes.delete(email);
  return { result: 'ok' };
}
