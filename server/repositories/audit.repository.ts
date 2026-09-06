import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore, trimAuditLogs } from '../core/memory-store.js';
import type { AuditLogRecord } from '../core/records.js';

export interface RecordAuditLogData {
  userId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: any;
}

/**
 * 写入一条审计日志（双模：PG user_audit_logs / 内存 auditLogs）。
 * 审计失败不阻塞主流程：内部吞掉异常仅 console.warn。
 */
export async function recordAuditLog(data: RecordAuditLogData): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const details = data.details ?? {};

    const p = getPool();
    if (p) {
      try {
        await initDbSchema();
        await p.query(
          `INSERT INTO user_audit_logs (id, user_id, action, target_type, target_id, ip_address, user_agent, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            id,
            data.userId || null,
            data.action,
            data.targetType || null,
            data.targetId || null,
            data.ip || '',
            data.userAgent || '',
            JSON.stringify(details),
          ]
        );
        return;
      } catch (e) {
        console.warn('PG recordAuditLog fallback to in-memory:', e);
      }
    }

    const record: AuditLogRecord = {
      id,
      user_id: data.userId || null,
      action: data.action,
      target_type: data.targetType || null,
      target_id: data.targetId || null,
      ip_address: data.ip || null,
      user_agent: data.userAgent || null,
      details,
      created_at: new Date().toISOString(),
    };
    inMemoryStore.auditLogs.unshift(record);
    trimAuditLogs();
  } catch (e) {
    console.warn('recordAuditLog failed (non-blocking):', e);
  }
}

/**
 * 分页查询审计日志（双模），返回最新在前。
 */
export async function listAuditLogs(params: {
  page?: number;
  limit?: number;
  action?: string;
  userId?: string;
}): Promise<{ logs: AuditLogRecord[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(200, Math.max(1, params.limit || 10));
  const offset = (page - 1) * limit;

  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      let whereClause = '1=1';
      const values: any[] = [];

      if (params.action?.trim()) {
        values.push(params.action.trim());
        whereClause += ` AND action = $${values.length}`;
      }
      if (params.userId?.trim()) {
        values.push(params.userId.trim());
        whereClause += ` AND user_id = $${values.length}::uuid`;
      }

      const countRes = await p.query(
        `SELECT COUNT(*) as total FROM user_audit_logs WHERE ${whereClause}`,
        values
      );
      const total = parseInt(countRes.rows[0].total, 10);

      const listRes = await p.query(
        `SELECT * FROM user_audit_logs
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      return {
        logs: listRes.rows.map((r) => ({
          ...r,
          created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        })),
        total,
      };
    } catch (e) {
      console.warn('PG listAuditLogs fallback to in-memory:', e);
    }
  }

  // In-memory fallback
  let list = inMemoryStore.auditLogs;
  if (params.action?.trim()) {
    list = list.filter((l) => l.action === params.action!.trim());
  }
  if (params.userId?.trim()) {
    list = list.filter((l) => l.user_id === params.userId!.trim());
  }
  list = [...list].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return {
    logs: list.slice(offset, offset + limit),
    total: list.length,
  };
}

/**
 * Spec F6：清理超过留存期的审计日志。retentionDays=0 表示全清（测试用）。
 */
export async function cleanupOldAuditLogs(retentionDays: number): Promise<number> {
  const p = getPool();
  if (p) {
    try {
      const res = retentionDays <= 0
        ? await p.query(`DELETE FROM user_audit_logs RETURNING id`)
        : await p.query(
            `DELETE FROM user_audit_logs WHERE created_at < NOW() - make_interval(days => $1) RETURNING id`,
            [retentionDays]
          );
      return res.rowCount || 0;
    } catch (e) {
      console.warn('PG cleanupOldAuditLogs failed, falling back to memory only:', e);
    }
  }

  if (retentionDays <= 0) {
    const removed = inMemoryStore.auditLogs.length;
    inMemoryStore.auditLogs = [];
    return removed;
  }
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const before = inMemoryStore.auditLogs.length;
  inMemoryStore.auditLogs = inMemoryStore.auditLogs.filter(
    (l) => new Date(l.created_at).getTime() > cutoff
  );
  return before - inMemoryStore.auditLogs.length;
}

/** 测试辅助：读取内存审计日志 */
export function getAuditLogsForTest() {
  return inMemoryStore.auditLogs;
}
