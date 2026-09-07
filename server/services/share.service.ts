import { getCanvasOwnerInfo } from '../repositories/canvas.repository.js';
import { getCanvas } from '../repositories/canvas.repository.js';
import {
  upsertShare,
  findActiveShareByCode,
  revokeShareByCanvasId,
} from '../repositories/share.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { UserRecord } from '../core/records.js';

/**
 * Spec K2（跟踪清单 B1）：快照式只读分享服务。
 *
 * 权限：创建/撤销严格属主制（admin 放行，对齐 H1 画布口径）；
 * 读取公开无鉴权，但仅在分享有效（未撤销 + 所属画布未软删）时返回，无效统一 404 不泄露原因。
 * 审计：share_create / share_revoke 写 user_audit_logs（J4 checklist §6：增量动作补类目）。
 */

export interface ShareViewPayload {
  title: string;
  nodes: any[];
  edges: any[];
  createdAt: string;
  viewCount: number;
}

/** 创建（或幂等重建）画布分享，返回 shareCode 与公开访问 URL */
export async function createShareForCanvas(
  user: UserRecord,
  canvasId: string,
  appUrl: string
): Promise<{ shareCode: string; url: string }> {
  const info = await getCanvasOwnerInfo(canvasId);
  if (!info.exists) {
    throw new NotFoundError('画布不存在');
  }
  if (user.role !== 'admin' && info.ownerId !== user.id) {
    throw new ForbiddenError('只能分享自己的画板', 'CANVAS_FORBIDDEN');
  }

  // getCanvas 内部已含属主校验，属主/管理员路径必定放行
  const canvas = await getCanvas(canvasId, user.id, user.role === 'admin');
  if (!canvas) {
    throw new NotFoundError('画布不存在');
  }

  const snapshot = {
    title: canvas.title || canvasId,
    nodes: canvas.nodes || [],
    edges: canvas.edges || [],
  };
  const { record } = await upsertShare(canvasId, snapshot);

  await recordAuditLog({
    userId: user.id,
    action: 'share_create',
    targetType: 'canvas',
    targetId: canvasId,
    details: { shareCode: record.share_code },
  });

  const base = appUrl.replace(/\/+$/, '');
  return { shareCode: record.share_code, url: `${base}/share/${record.share_code}` };
}

/** 撤销分享（软撤） */
export async function revokeShareForCanvas(user: UserRecord, canvasId: string): Promise<void> {
  const info = await getCanvasOwnerInfo(canvasId);
  if (!info.exists) {
    throw new NotFoundError('画布不存在');
  }
  if (user.role !== 'admin' && info.ownerId !== user.id) {
    throw new ForbiddenError('只能管理自己的画板分享', 'CANVAS_FORBIDDEN');
  }

  const revoked = await revokeShareByCanvasId(canvasId);
  if (!revoked) {
    // 画布存在但无活跃分享：与不存在同语义，避免暴露分享状态
    throw new NotFoundError('画布分享不存在或已撤销');
  }

  await recordAuditLog({
    userId: user.id,
    action: 'share_revoke',
    targetType: 'canvas',
    targetId: canvasId,
  });
}

/** 公开读取分享快照（无效统一 404，不泄露撤销/删除/不存在的原因差异） */
export async function getShareView(code: string): Promise<ShareViewPayload> {
  const record = await findActiveShareByCode(code);
  if (!record || !record.snapshot) {
    throw new NotFoundError('分享不存在或已失效');
  }
  return {
    title: record.snapshot.title,
    nodes: record.snapshot.nodes || [],
    edges: record.snapshot.edges || [],
    createdAt: record.created_at,
    viewCount: record.views_count,
  };
}
