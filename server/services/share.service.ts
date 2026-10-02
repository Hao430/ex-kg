import { getCanvasOwnerInfo } from '../repositories/canvas.repository.js';
import { getCanvas } from '../repositories/canvas.repository.js';
import {
  upsertShare,
  findActiveShareByCode,
  revokeShareByCanvasId,
  listActiveSharesByUser,
} from '../repositories/share.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { recordEventLog } from '../repositories/event-log.repository.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { UserRecord } from '../core/records.js';
import { runWithSystem } from '../core/db-context.js';
import { AccessPolicy } from '../policies/access.policy.js';


/**
 * Spec K2（跟踪清单 B1）：快照式只读分享服务。
 *
 * 权限：创建/撤销严格属主制（仅属主本人；admin 不例外 — ADR-0016）；
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

/** 创建（或幂等重建）画布分享，返回 shareCode 与公开访问 URL；recreated=重建了已撤销分享（换新 code，旧链接失效） */
export async function createShareForCanvas(
  user: UserRecord,
  canvasId: string,
  appUrl: string
): Promise<{ shareCode: string; url: string; recreated: boolean }> {
  const info = await getCanvasOwnerInfo(canvasId);
  if (!info.exists) {
    throw new NotFoundError('画布不存在');
  }
  AccessPolicy.assertCanShareCanvas(user.id, info.ownerId);

  // getCanvas 内部已含属主校验，属主路径必定放行
  const canvas = await getCanvas(canvasId, user.id);
  if (!canvas) {
    throw new NotFoundError('画布不存在');
  }

  const snapshot = {
    title: canvas.title || canvasId,
    nodes: canvas.nodes || [],
    edges: canvas.edges || [],
  };
  const { record, recreatedRevoked } = await upsertShare(canvasId, snapshot);

  // 审计只记「发生过创建/重建」这一事实与重建标记，绝不落 shareCode：
  // 分享码是公开只读的访问凭据，写进日志后 admin 可经 /api/admin/audit-logs 收集
  // 他人分享码绕过严格属主制读取画布快照（ADR-0016 follow-up）。画布归属由 targetId 锚定。
  await recordAuditLog({
    userId: user.id,
    action: 'share_create',
    targetType: 'canvas',
    targetId: canvasId,
    details: { recreatedRevoked },
  });

  const base = appUrl.replace(/\/+$/, '');
  return {
    shareCode: record.share_code,
    url: `${base}/share/${record.share_code}`,
    recreated: recreatedRevoked,
  };
}

/** 撤销分享（软撤） */
export async function revokeShareForCanvas(user: UserRecord, canvasId: string): Promise<void> {
  const info = await getCanvasOwnerInfo(canvasId);
  if (!info.exists) {
    throw new NotFoundError('画布不存在');
  }
  AccessPolicy.assertCanManageShare(user.id, info.ownerId);

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

/** 公开读取分享快照（无效统一 404，不泄露撤销/删除/不存在的原因差异）；countViews 控制浏览计数 */
export async function getShareView(code: string, countViews = true): Promise<ShareViewPayload> {
  return runWithSystem('shares: 公开分享按 shareCode 读快照（无登录态）', async () => {
    const record = await findActiveShareByCode(code, countViews);
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
  });
}


export interface MyShareItem {
  canvasId: string;
  canvasTitle: string;
  shareCode: string;
  url: string;
  viewsCount: number;
  createdAt: string;
}

/**
 * 「我的分享」列表（2026-09-09）：仅本人、仅生效中（未撤销 + 画布未软删）。
 * admin 同样只看自己的（个人中心语义，非运营视图）。
 * 列表读取不递增浏览计数（与公开读取端口径区分），但落一条使用埋点供运营漏斗。
 */
export async function listMyShares(user: UserRecord, appUrl: string): Promise<{ shares: MyShareItem[] }> {
  const items = await listActiveSharesByUser(user.id);

  void recordEventLog({
    category: 'share',
    event: 'share_manage_viewed',
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
  });

  const base = appUrl.replace(/\/+$/, '');
  return {
    shares: items.map((it) => ({
      canvasId: it.canvas_id,
      canvasTitle: it.canvas_title,
      shareCode: it.share_code,
      url: `${base}/share/${it.share_code}`,
      viewsCount: it.views_count,
      createdAt: it.created_at,
    })),
  };
}
