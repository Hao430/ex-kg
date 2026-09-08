import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { handlePgError } from '../core/db-guard.js';
import type { ShareRecord } from '../core/records.js';

/**
 * Spec K2（跟踪清单 B1）：快照式只读分享仓储（双模）。
 *
 * 语义约定（测试锁定 tests/k2-share.test.ts）：
 * - 一画板至多一个分享行（PG 唯一索引 idx_canvas_shares_canvas；内存以 canvas_id 为 key），
 *   重复创建幂等 upsert：更新快照与 share_code、清除撤销标记（旧 code 随之失效）。
 * - 快照不可变：读取返回创建时刻的 snapshot_data，后续画布编辑不传播。
 * - 分享有效性 = 未撤销 AND 所属画布未软删（PG JOIN 过滤 / 内存查 canvases）。
 * - share_code 用 crypto.randomBytes base64url（12 字符，URL 安全、不可枚举）。
 */

function newShareId(): string {
  return crypto.randomUUID();
}

function newShareCode(): string {
  return crypto.randomBytes(9).toString('base64url');
}

function mapRowToShare(row: any): ShareRecord {
  return {
    id: row.id,
    canvas_id: row.canvas_id,
    share_code: row.share_code,
    snapshot: row.snapshot_data ?? null,
    views_count: row.views_count ?? 0,
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

export interface ShareUpsertResult {
  record: ShareRecord;
  /** 是否新建（false = 复用既有行覆盖） */
  created: boolean;
  /** 是否重建了已撤销的分享（换了新 code，旧链接失效）——前端据此提示用户 */
  recreatedRevoked: boolean;
}

/**
 * 幂等 upsert：按 canvas_id 建/覆盖分享（同时生成新 code、清撤销标记）。
 * @param snapshot 全量画布快照 {title, nodes, edges}
 */
export async function upsertShare(
  canvasId: string,
  snapshot: { title: string; nodes: any[]; edges: any[] }
): Promise<ShareUpsertResult> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      // 幂等语义：活跃分享（未撤销）复用原 share_code，仅更新快照；
      // 已撤销的分享重建时换新 code（旧链接保持失效语义），并清除撤销标记
      const existed = await p.query(
        'SELECT share_code, revoked_at FROM canvas_shares WHERE canvas_id = $1',
        [canvasId]
      );
      const recreatedRevoked = existed.rows.length > 0 && existed.rows[0].revoked_at != null;
      const reuseCode = existed.rows.length > 0 && existed.rows[0].revoked_at == null;
      const code = reuseCode ? String(existed.rows[0].share_code) : newShareCode();
      const res = await p.query(
        `INSERT INTO canvas_shares (id, canvas_id, share_code, permission, snapshot_data)
         VALUES ($1, $2, $3, 'view', $4::jsonb)
         ON CONFLICT (canvas_id) DO UPDATE
           SET share_code = EXCLUDED.share_code,
               snapshot_data = EXCLUDED.snapshot_data,
               revoked_at = NULL,
               created_at = NOW()
         RETURNING *`,
        [newShareId(), canvasId, code, JSON.stringify(snapshot)]
      );
      return {
        record: mapRowToShare(res.rows[0]),
        created: existed.rows.length === 0,
        recreatedRevoked,
      };
    } catch (e) {
      handlePgError(e);
      console.warn('PG upsertShare fallback to in-memory:', e);
    }
  }

  const existed = inMemoryStore.shares.get(canvasId);
  // 幂等语义与 PG 分支对齐：活跃分享复用原 code；撤销态重建换新 code
  const recreatedRevoked = Boolean(existed && existed.revoked_at);
  const reuseCode = Boolean(existed && !existed.revoked_at);
  const record: ShareRecord = {
    id: existed?.id || newShareId(),
    canvas_id: canvasId,
    share_code: reuseCode ? existed!.share_code : newShareCode(),
    snapshot,
    views_count: existed?.views_count ?? 0,
    revoked_at: null,
    created_at: new Date().toISOString(),
  };
  inMemoryStore.shares.set(canvasId, record);
  return { record, created: !existed, recreatedRevoked };
}

/**
 * 按 share_code 读取有效分享（未撤销 + 所属画布未软删）。
 * countViews=false 时跳过浏览计数（克隆钩子与同会话刷新不虚增统计，Spec K6/K2 修复）。
 * 无效（撤销/画布删除/不存在/过期）统一返回 null，由 service 转 404（不泄露原因）。
 */
export async function findActiveShareByCode(code: string, countViews = true): Promise<ShareRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `SELECT s.*
           FROM canvas_shares s
           JOIN canvases c ON c.id = s.canvas_id AND c.deleted_at IS NULL
          WHERE s.share_code = $1 AND s.revoked_at IS NULL`,
        [code]
      );
      if (res.rows.length === 0) return null;
      const record = mapRowToShare(res.rows[0]);
      // 浏览计数失败不影响读取主流程
      if (countViews) {
        p.query('UPDATE canvas_shares SET views_count = views_count + 1 WHERE id = $1', [
          record.id,
        ]).catch(() => {});
        record.views_count += 1;
      }
      return record;
    } catch (e) {
      handlePgError(e);
      console.warn('PG findActiveShareByCode fallback to in-memory:', e);
    }
  }

  for (const share of inMemoryStore.shares.values()) {
    if (share.share_code !== code || share.revoked_at) continue;
    const canvas = inMemoryStore.canvases.get(share.canvas_id);
    if (!canvas || canvas.deleted_at) continue;
    if (countViews) share.views_count += 1;
    return { ...share, views_count: share.views_count };
  }
  return null;
}

/**
 * 撤销分享（软撤，保留行）。画布不存在或已软删时返回 false（service 转语义化错误）。
 */
export async function revokeShareByCanvasId(canvasId: string): Promise<boolean> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `UPDATE canvas_shares SET revoked_at = NOW()
          WHERE canvas_id = $1 AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM canvases c WHERE c.id = canvas_shares.canvas_id AND c.deleted_at IS NULL)`,
        [canvasId]
      );
      return (res.rowCount ?? 0) > 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG revokeShareByCanvasId fallback to in-memory:', e);
    }
  }

  const share = inMemoryStore.shares.get(canvasId);
  if (!share || share.revoked_at) return false;
  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas || canvas.deleted_at) return false;
  share.revoked_at = new Date().toISOString();
  return true;
}
