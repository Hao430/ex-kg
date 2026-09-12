import crypto from 'node:crypto';
import { getDb } from '../core/db.js';
import { inMemoryStore, trimEventLogs } from '../core/memory-store.js';
import type { EventLogRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

export interface RecordEventLogData {
  category: string;
  event: string;
  entityType?: string | null;
  entityId?: string | null;
  userId?: string | null;
  num1?: number | null;
  num2?: number | null;
  details?: any;
  ip?: string | null;
}

/**
 * Spec I：写入一条业务事件埋点（双模：PG event_logs / 内存 eventLogs）。
 * 埋点绝不阻塞/改变业务结果：外层整体吞异常仅 console.warn。
 */
export async function recordEventLog(data: RecordEventLogData): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const details = data.details ?? {};

    const db = getDb();
    if (db) {
      try {
        await db.query(
          `INSERT INTO event_logs (id, category, event, entity_type, entity_id, user_id, num1, num2, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            id,
            data.category,
            data.event,
            data.entityType || null,
            data.entityId || null,
            data.userId || null,
            data.num1 ?? null,
            data.num2 ?? null,
            JSON.stringify(details),
          ]
        );
        return;
      } catch (e) {
        handlePgError(e);
        console.warn('PG recordEventLog fallback to in-memory:', e);
      }
    }

    const record: EventLogRecord = {
      id,
      category: data.category,
      event: data.event,
      entity_type: data.entityType || null,
      entity_id: data.entityId || null,
      user_id: data.userId || null,
      num1: data.num1 ?? null,
      num2: data.num2 ?? null,
      details,
      created_at: new Date().toISOString(),
    };
    inMemoryStore.eventLogs.unshift(record);
    trimEventLogs();
  } catch (e) {
    console.warn('recordEventLog failed (non-blocking):', e);
  }
}

/**
 * 分页查询业务事件（双模，admin 专用），返回最新在前。
 */
export async function listEventLogs(params: {
  page?: number;
  limit?: number;
  category?: string;
  event?: string;
  userId?: string;
}): Promise<{ logs: EventLogRecord[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(200, Math.max(1, params.limit || 10));
  const offset = (page - 1) * limit;

  const db = getDb();
  if (db) {
    try {
      let whereClause = '1=1';
      const values: any[] = [];

      if (params.category?.trim()) {
        values.push(params.category.trim());
        whereClause += ` AND category = $${values.length}`;
      }
      if (params.event?.trim()) {
        values.push(params.event.trim());
        whereClause += ` AND event = $${values.length}`;
      }
      if (params.userId?.trim()) {
        values.push(params.userId.trim());
        whereClause += ` AND user_id = $${values.length}::uuid`;
      }

      const countRes = await db.query(
        `SELECT COUNT(*) as total FROM event_logs WHERE ${whereClause}`,
        values
      );
      const total = parseInt(countRes.rows[0].total, 10);

      const listRes = await db.query(
        `SELECT * FROM event_logs
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
      handlePgError(e);
      console.warn('PG listEventLogs fallback to in-memory:', e);
    }
  }

  // In-memory fallback
  let list = inMemoryStore.eventLogs;
  if (params.category?.trim()) {
    list = list.filter((l) => l.category === params.category!.trim());
  }
  if (params.event?.trim()) {
    list = list.filter((l) => l.event === params.event!.trim());
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
 * Spec I：清理超过留存期的业务事件。retentionDays=0 表示全清（测试用）。
 */
export async function cleanupOldEventLogs(retentionDays: number): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const res = retentionDays <= 0
        ? await db.query(`DELETE FROM event_logs RETURNING id`)
        : await db.query(
            `DELETE FROM event_logs WHERE created_at < NOW() - make_interval(days => $1) RETURNING id`,
            [retentionDays]
          );
      return res.rowCount || 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG cleanupOldEventLogs failed, falling back to memory only:', e);
    }
  }

  if (retentionDays <= 0) {
    const removed = inMemoryStore.eventLogs.length;
    inMemoryStore.eventLogs = [];
    return removed;
  }
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const before = inMemoryStore.eventLogs.length;
  inMemoryStore.eventLogs = inMemoryStore.eventLogs.filter(
    (l) => new Date(l.created_at).getTime() > cutoff
  );
  return before - inMemoryStore.eventLogs.length;
}

/** 测试辅助：读取内存业务事件 */
export function getEventLogsForTest(): EventLogRecord[] {
  return inMemoryStore.eventLogs;
}
