import { listCanvases, canvasExists, countCanvasNodes } from '../repositories/canvas.repository.js';
import { ForbiddenError } from '../lib/errors.js';
import type { UserRecord } from '../core/records.js';

export const BOARD_LIMIT = 3;
export const NODE_LIMIT = 10;
/** VIP 到期宽限期（Spec B3）：宽限期内体验不中断，仅提醒；超期硬锁定 */
export const GRACE_PERIOD_DAYS = 7;

export type Plan = 'trial' | 'vip' | 'admin';

export interface Entitlements {
  plan: Plan;
  vipExpired: boolean;
  /** 宽限期内剩余天数（仅在已到期但未超出宽限期时返回） */
  vipGraceDaysRemaining?: number;
  boardLimit: number | null;
  nodeLimit: number | null;
}

/**
 * 有效身份判定（Spec B2）：
 * - admin → 不受限
 * - role=vip 且未过期 → VIP 有效（vip_expires_at 为空视为永久有效）
 * - role=vip 且已过期 → VIP 已过期（区别于体验版，错误码不同）
 * - role=user → 体验版
 */
export function effectiveEntitlements(user: Pick<UserRecord, 'role' | 'vip_expires_at'>): Entitlements {
  if (user.role === 'admin') {
    return { plan: 'admin', vipExpired: false, boardLimit: null, nodeLimit: null };
  }
  if (user.role === 'vip') {
    if (user.vip_expires_at) {
      const expiredAt = new Date(user.vip_expires_at).getTime();
      // 非法日期串按已过期处理（fail-closed，审计建议）
      const expiredMs = Number.isNaN(expiredAt) ? -Infinity : expiredAt;
      const graceEndMs = expiredMs + GRACE_PERIOD_DAYS * 24 * 3600 * 1000;
      const now = Date.now();

      if (now <= expiredMs) {
        // 有效期内
        return { plan: 'vip', vipExpired: false, boardLimit: null, nodeLimit: null };
      }
      if (now <= graceEndMs) {
        // 宽限期：体验不中断，仅提醒
        const graceDaysRemaining = Math.max(0, Math.ceil((graceEndMs - now) / (24 * 3600 * 1000)));
        return {
          plan: 'vip',
          vipExpired: true,
          vipGraceDaysRemaining: graceDaysRemaining,
          boardLimit: null,
          nodeLimit: null,
        };
      }
      // 超过宽限期：硬锁定
      return { plan: 'trial', vipExpired: true, boardLimit: BOARD_LIMIT, nodeLimit: NODE_LIMIT };
    }
    // vip_expires_at 为空视为永久有效
    return { plan: 'vip', vipExpired: false, boardLimit: null, nodeLimit: null };
  }
  return { plan: 'trial', vipExpired: false, boardLimit: BOARD_LIMIT, nodeLimit: NODE_LIMIT };
}

/**
 * 新建画板前的画板数配额校验（Spec B1）。超限抛 403 BOARD_LIMIT_REACHED / VIP_EXPIRED。
 */
export async function assertCanCreateBoard(user: UserRecord): Promise<void> {
  const ent = effectiveEntitlements(user);
  if (ent.plan === 'admin' || ent.plan === 'vip') return;

  if (ent.vipExpired) {
    throw new ForbiddenError('VIP 会员已过期，续费后即可继续创建画板', 'VIP_EXPIRED');
  }

  const canvases = await listCanvases(user.id);
  if (canvases.length >= BOARD_LIMIT) {
    throw new ForbiddenError(
      `体验版最多创建 ${BOARD_LIMIT} 个画板，升级 VIP 会员解锁无限画板`,
      'BOARD_LIMIT_REACHED'
    );
  }
}

/**
 * 发起推理前的节点数配额校验（Spec B1）。超限抛 403 NODE_LIMIT_REACHED / VIP_EXPIRED。
 */
export async function assertCanInfer(user: UserRecord, canvasId: string | null | undefined): Promise<void> {
  const ent = effectiveEntitlements(user);
  if (ent.plan === 'admin' || ent.plan === 'vip') return;

  if (ent.vipExpired) {
    throw new ForbiddenError('VIP 会员已过期，续费后即可继续 AI 推理', 'VIP_EXPIRED');
  }

  if (!canvasId) return; // 无画布上下文的自由提问不做节点校验
  const count = await countCanvasNodes(canvasId);
  if (count >= NODE_LIMIT) {
    throw new ForbiddenError(
      `体验版每画板最多 ${NODE_LIMIT} 个 AI 推理节点，升级 VIP 会员解锁无限节点`,
      'NODE_LIMIT_REACHED'
    );
  }
}

export { canvasExists };
