import { listCanvases, canvasExists, countCanvasNodes } from '../repositories/canvas.repository.js';
import type { UserRecord } from '../core/records.js';
import {
  QuotaPolicy,
  BOARD_LIMIT,
  NODE_LIMIT,
  GRACE_PERIOD_DAYS,
} from '../policies/quota.policy.js';
import type { Plan, Entitlements } from '../policies/quota.policy.js';

export {
  BOARD_LIMIT,
  NODE_LIMIT,
  GRACE_PERIOD_DAYS,
  type Plan,
  type Entitlements,
  canvasExists,
};

/**
 * 有效身份判定（Spec B2）：委托 QuotaPolicy
 */
export function effectiveEntitlements(user: Pick<UserRecord, 'role' | 'vip_expires_at'>): Entitlements {
  return QuotaPolicy.calculateEntitlements(user);
}

/**
 * 新建画板前的画板数配额编排（Spec B1）：
 * 从仓储拉取画板数量，委托 QuotaPolicy 进行业务决策。
 */
export async function assertCanCreateBoard(user: UserRecord): Promise<void> {
  const ent = QuotaPolicy.calculateEntitlements(user);
  if (ent.plan === 'admin' || ent.plan === 'vip') return;

  // 避免对未过期用户做无谓的仓储查询
  if (ent.vipExpired) {
    QuotaPolicy.assertCanCreateBoard(ent, 0);
    return;
  }

  const canvases = await listCanvases(user.id);
  QuotaPolicy.assertCanCreateBoard(ent, canvases.length);
}

/**
 * 发起推理前的节点数配额编排（Spec B1）：
 * 从仓储统计当前节点数，委托 QuotaPolicy 进行业务决策。
 */
export async function assertCanInfer(user: UserRecord, canvasId: string | null | undefined): Promise<void> {
  const ent = QuotaPolicy.calculateEntitlements(user);
  if (ent.plan === 'admin' || ent.plan === 'vip') return;

  if (ent.vipExpired) {
    QuotaPolicy.assertCanInfer(ent, null);
    return;
  }

  if (!canvasId) return; // 无画布上下文的自由提问放行
  const count = await countCanvasNodes(canvasId);
  QuotaPolicy.assertCanInfer(ent, count);
}
