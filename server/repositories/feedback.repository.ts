import crypto from 'node:crypto';
import { getDb } from '../core/db.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { FeedbackRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

/**
 * Spec P1 反馈工单处理通道。
 *
 * 表结构（`schema.ts` 7.6）早就预留了 status / admin_reply / resolved_by / resolved_at /
 * updated_at 五列与 `idx_feedbacks_status`，但全仓从无代码读写——本文件是唯一数据访问点。
 * **零 schema 变更**：五列已存在，内存模式的 FeedbackRecord 补默认值即可（PG 有列默认值，
 * 内存没有，这是本文件最需要留意的双模分叉点）。
 */
export const FEEDBACK_STATUSES = ['pending', 'processing', 'resolved', 'rejected'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** 终态：进入时落 resolved_by/resolved_at，之后不可再流转 */
export const FEEDBACK_TERMINAL_STATUSES: readonly string[] = ['resolved', 'rejected'];

/**
 * 显式列投影（H1 纪律，`ADMIN_USER_COLUMNS` 先例）。
 *
 * feedbacks 无口令/令牌类敏感列，但依然禁止 `SELECT *`——列演进（例如将来加内部备注、
 * 风控标记）会静默进入响应，而运营台列表会进浏览器缓存与客服截图。两个分支共用下面
 * 两个视图函数做裁剪，只改 PG 不改内存会变成内存模式独有的泄漏。
 */
const FEEDBACK_COLUMNS = `id, user_id, user_email, type, rating, content, contact_info,
  status, admin_reply, resolved_by, resolved_at, created_at, updated_at`;

export interface AdminFeedbackView {
  id: string;
  user_id: string | null;
  user_email: string | null;
  type: string;
  rating: number;
  content: string;
  contact_info: string;
  status: string;
  admin_reply: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 用户自查视图：**不含** resolved_by（内部 admin uuid）、contact_info / user_email / user_id
 * （本人提交时已填，无必要回吐）。恰为 9 键，测试按键集合锁定。
 */
export interface MyFeedbackView {
  id: string;
  type: string;
  rating: number;
  content: string;
  status: string;
  admin_reply: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 时间戳归一化：PG 返回 Date，内存分支已是 ISO 串，两路必须同形 */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toAdminFeedbackView(row: Record<string, any>): AdminFeedbackView {
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    user_email: row.user_email ?? null,
    type: row.type,
    rating: row.rating ?? 5,
    content: row.content,
    contact_info: row.contact_info ?? '',
    status: row.status ?? 'pending',
    admin_reply: row.admin_reply ?? '',
    resolved_by: row.resolved_by ?? null,
    resolved_at: toIsoOrNull(row.resolved_at),
    created_at: toIsoOrNull(row.created_at) ?? '',
    updated_at: toIsoOrNull(row.updated_at) ?? '',
  };
}

export function toMyFeedbackView(row: Record<string, any>): MyFeedbackView {
  return {
    id: row.id,
    type: row.type,
    rating: row.rating ?? 5,
    content: row.content,
    status: row.status ?? 'pending',
    admin_reply: row.admin_reply ?? '',
    resolved_at: toIsoOrNull(row.resolved_at),
    created_at: toIsoOrNull(row.created_at) ?? '',
    updated_at: toIsoOrNull(row.updated_at) ?? '',
  };
}

export async function createFeedback(data: {
  userId?: string;
  userEmail?: string;
  type: string;
  rating?: number;
  content: string;
  contactInfo?: string;
}): Promise<FeedbackRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const type = data.type || 'suggestion';
  const rating = data.rating ?? 5;
  const content = data.content.trim();
  const contactInfo = data.contactInfo?.trim() || '';

  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `INSERT INTO feedbacks (id, user_id, user_email, type, rating, content, contact_info, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING ${FEEDBACK_COLUMNS}`,
        [id, data.userId || null, data.userEmail || null, type, rating, content, contactInfo]
      );
      if (res.rows.length > 0) {
        return {
          id: res.rows[0].id,
          user_id: res.rows[0].user_id,
          user_email: res.rows[0].user_email,
          type: res.rows[0].type,
          rating: res.rows[0].rating,
          content: res.rows[0].content,
          contact_info: res.rows[0].contact_info,
          status: res.rows[0].status,
          admin_reply: res.rows[0].admin_reply ?? '',
          resolved_by: res.rows[0].resolved_by ?? null,
          resolved_at: toIsoOrNull(res.rows[0].resolved_at),
          created_at: res.rows[0].created_at,
          updated_at: toIsoOrNull(res.rows[0].updated_at) ?? now,
        };
      }
    } catch (e) {
      handlePgError(e);
      console.warn('PG createFeedback fallback to in-memory:', e);
    }
  }

  // 内存分支必须显式写全默认值：PG 靠列默认值补齐，内存没有列可言，漏一个就是双模分叉
  const record: FeedbackRecord = {
    id,
    user_id: data.userId ?? null,
    user_email: data.userEmail ?? null,
    type,
    rating,
    content,
    contact_info: contactInfo,
    status: 'pending',
    admin_reply: '',
    resolved_by: null,
    resolved_at: null,
    created_at: now,
    updated_at: now,
  };
  inMemoryStore.feedbacks.push(record);
  return record;
}

/** 用户自查（Spec P1）：只回本人工单；匿名提交 user_id 为 NULL，任何人查不到。 */
export async function listUserFeedbacks(userId: string): Promise<MyFeedbackView[]> {
  const db = getDb();
  if (db) {
    try {
      // 显式 user_id 过滤是防御纵深：RLS 谓词已在 PG 层隔离，两路同形更易对齐
      const res = await db.query(
        `SELECT ${FEEDBACK_COLUMNS} FROM feedbacks
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      );
      return res.rows.map((r) => toMyFeedbackView(r));
    } catch (e) {
      handlePgError(e);
      console.warn('PG listUserFeedbacks fallback to in-memory:', e);
    }
  }

  return inMemoryStore.feedbacks
    .filter((f) => f.user_id === userId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((f) => toMyFeedbackView(f));
}

/** 运营台工单列表（Spec P1）：跨租户，仅在 admin system 作用域下调用。 */
export async function listAdminFeedbacks(params: {
  status?: string;
  type?: string;
  page?: number;
  limit?: number;
}): Promise<{ feedbacks: AdminFeedbackView[]; total: number; statusCounts: Record<string, number> }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const offset = (page - 1) * limit;

  const statusCounts: Record<string, number> = {};
  for (const s of FEEDBACK_STATUSES) statusCounts[s] = 0;

  const db = getDb();
  if (db) {
    try {
      const values: any[] = [];
      let whereClause = 'TRUE';
      if (params.status) {
        values.push(params.status);
        whereClause += ` AND status = $${values.length}`;
      }
      if (params.type) {
        values.push(params.type);
        whereClause += ` AND type = $${values.length}`;
      }

      const countRes = await db.query(
        `SELECT COUNT(*)::int as total FROM feedbacks WHERE ${whereClause}`,
        values
      );
      const total = countRes.rows[0]?.total ?? 0;

      // 角标计数不受 status 过滤影响（否则选「已解决」后其它角标全归零），但受 type 过滤影响
      const countValues: any[] = [];
      let countWhere = 'TRUE';
      if (params.type) {
        countValues.push(params.type);
        countWhere += ` AND type = $${countValues.length}`;
      }
      const statusRes = await db.query(
        `SELECT status, COUNT(*)::int as count FROM feedbacks WHERE ${countWhere} GROUP BY status`,
        countValues
      );
      for (const row of statusRes.rows) statusCounts[row.status] = row.count;

      const listRes = await db.query(
        `SELECT ${FEEDBACK_COLUMNS} FROM feedbacks
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      return { feedbacks: listRes.rows.map((r) => toAdminFeedbackView(r)), total, statusCounts };
    } catch (e) {
      handlePgError(e);
      console.warn('PG listAdminFeedbacks fallback to in-memory:', e);
    }
  }

  let list = [...inMemoryStore.feedbacks];
  if (params.type) list = list.filter((f) => f.type === params.type);
  for (const f of list) {
    const s = f.status || 'pending';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  if (params.status) list = list.filter((f) => f.status === params.status);
  list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return {
    feedbacks: list.slice(offset, offset + limit).map((f) => toAdminFeedbackView(f)),
    total: list.length,
    statusCounts,
  };
}

/** 单条读取（运营台）：工单不存在返回 null，由 service 抛 404。 */
export async function getFeedbackById(id: string): Promise<AdminFeedbackView | null> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT ${FEEDBACK_COLUMNS} FROM feedbacks WHERE id = $1`,
        [id]
      );
      if (res.rows.length > 0) return toAdminFeedbackView(res.rows[0]);
      return null;
    } catch (e) {
      handlePgError(e);
      console.warn('PG getFeedbackById fallback to in-memory:', e);
    }
  }

  const found = inMemoryStore.feedbacks.find((f) => f.id === id);
  return found ? toAdminFeedbackView(found) : null;
}

/**
 * 运营台流转 + 回复（Spec P1）。
 *
 * `resolved_by`/`resolved_at` **只在首次进入终态时落值**（`IS NULL` 守卫）：
 * 终态后修订回复不该把「谁定的案」改成最后一个编辑者。
 * 占位符纪律：`$4` 是 JS 算好的布尔（终态判定）、`$5` 是 uuid，**不把 `$2` 同时用于
 * varchar 赋值与 text 比较**——同一占位符跨类型上下文会 `42P08`，内存分支测不到（既有先例）。
 */
export async function updateFeedbackByAdmin(data: {
  id: string;
  status: string;
  adminReply: string;
  resolvedBy?: string | null;
}): Promise<AdminFeedbackView | null> {
  const isTerminal = FEEDBACK_TERMINAL_STATUSES.includes(data.status);
  const reply = data.adminReply ?? '';
  const now = new Date().toISOString();

  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `UPDATE feedbacks SET
           status = $2,
           admin_reply = $3,
           updated_at = NOW(),
           resolved_by = CASE WHEN $4::boolean AND resolved_by IS NULL THEN $5::uuid ELSE resolved_by END,
           resolved_at = CASE WHEN $4::boolean AND resolved_at IS NULL THEN NOW() ELSE resolved_at END
         WHERE id = $1
         RETURNING ${FEEDBACK_COLUMNS}`,
        [data.id, data.status, reply, isTerminal, data.resolvedBy || null]
      );
      if (res.rows.length > 0) return toAdminFeedbackView(res.rows[0]);
      return null;
    } catch (e) {
      handlePgError(e);
      console.warn('PG updateFeedbackByAdmin fallback to in-memory:', e);
    }
  }

  const record = inMemoryStore.feedbacks.find((f) => f.id === data.id);
  if (!record) return null;
  record.status = data.status;
  record.admin_reply = reply;
  record.updated_at = now;
  if (isTerminal) {
    // 与 PG 的 IS NULL 守卫同语义：终态后回复可改，定案人与定案时间不变
    if (record.resolved_by == null) record.resolved_by = data.resolvedBy || null;
    if (record.resolved_at == null) record.resolved_at = now;
  }
  return toAdminFeedbackView(record);
}
