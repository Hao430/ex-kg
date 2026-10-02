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

export interface QuotaUsageCalculation {
  board: {
    used: number;
    limit: number | null;
  };
  node: {
    used: number;
    limit: number | null;
    remaining: number | null;
  } | null;
}

/**
 * QuotaPolicy: 配额、VIP 订阅状态、模型可用性及 AI 推理准入规则的唯一事实源。
 * 纯领域策略层实现，无状态、无数据库依赖、100% 可独立单元测试。
 */
export const QuotaPolicy = {
  BOARD_LIMIT,
  NODE_LIMIT,
  GRACE_PERIOD_DAYS,

  /**
   * 有效身份与权益判定（Spec B2 / B3）：
   * - admin → 不受限
   * - role=vip 且未过期 → VIP 有效（vip_expires_at 为空视为永久有效）
   * - role=vip 且在宽限期内（≤7 天）→ 放行 + 附带剩余宽限天数提示
   * - role=vip 且超宽限期 → 降为体验版硬锁定（vipExpired=true，错误码区别于普通体验版）
   * - role=user → 体验版
   */
  calculateEntitlements(
    user: Pick<UserRecord, 'role' | 'vip_expires_at'>,
    now = Date.now()
  ): Entitlements {
    if (user.role === 'admin') {
      return { plan: 'admin', vipExpired: false, boardLimit: null, nodeLimit: null };
    }

    if (user.role === 'vip') {
      if (user.vip_expires_at) {
        const expiredAt = new Date(user.vip_expires_at).getTime();
        // 非法日期串按已过期处理（fail-closed，审计建议）
        const expiredMs = Number.isNaN(expiredAt) ? -Infinity : expiredAt;
        const graceEndMs = expiredMs + GRACE_PERIOD_DAYS * 24 * 3600 * 1000;

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
  },

  /**
   * 新建画板前的画板数配额校验（Spec B1）。超限抛 403 BOARD_LIMIT_REACHED / VIP_EXPIRED。
   */
  assertCanCreateBoard(ent: Entitlements, currentBoardCount: number): void {
    if (ent.plan === 'admin' || ent.plan === 'vip') return;

    if (ent.vipExpired) {
      throw new ForbiddenError('VIP 会员已过期，续费后即可继续创建画板', 'VIP_EXPIRED');
    }

    if (currentBoardCount >= BOARD_LIMIT) {
      throw new ForbiddenError(
        `体验版最多创建 ${BOARD_LIMIT} 个画板，升级 VIP 会员解锁无限画板`,
        'BOARD_LIMIT_REACHED'
      );
    }
  },

  /**
   * 发起推理前的节点数配额校验（Spec B1）。超限抛 403 NODE_LIMIT_REACHED / VIP_EXPIRED。
   */
  assertCanInfer(ent: Entitlements, currentNodeCount: number | null | undefined): void {
    if (ent.plan === 'admin' || ent.plan === 'vip') return;

    if (ent.vipExpired) {
      throw new ForbiddenError('VIP 会员已过期，续费后即可继续 AI 推理', 'VIP_EXPIRED');
    }

    if (currentNodeCount === null || currentNodeCount === undefined) return; // 无画布上下文自由提问放行
    if (currentNodeCount >= NODE_LIMIT) {
      throw new ForbiddenError(
        `体验版每画板最多 ${NODE_LIMIT} 个 AI 推理节点，升级 VIP 会员解锁无限节点`,
        'NODE_LIMIT_REACHED'
      );
    }
  },

  /**
   * VIP 专享模型校验（Spec E4）：
   * 体验版用户请求白名单模型直接拦截抛 403 MODEL_VIP_ONLY；Admin / VIP 豁免。
   */
  assertCanUseModel(
    ent: Entitlements,
    requestedModel: string | undefined,
    vipOnlyModels: string[] | undefined
  ): void {
    if (ent.plan !== 'trial') return;
    const whitelist = (vipOnlyModels || [])
      .filter((m) => typeof m === 'string' && m.trim().length > 0)
      .map((m) => m.trim().toLowerCase());
    if (whitelist.length === 0) return;

    const requested = (requestedModel || '').trim().toLowerCase();
    if (requested && whitelist.includes(requested)) {
      throw new ForbiddenError('该模型为 VIP 专享，请升级会员后使用', 'MODEL_VIP_ONLY');
    }
  },

  /**
   * 邮箱验证前置准入校验（Spec D3）：
   * 未验证邮箱禁推理（admin 豁免；VIP 同受限于注册邮箱验证）。
   */
  assertCanInferWithEmail(user: Pick<UserRecord, 'role' | 'email_verified'>): void {
    if (user.role !== 'admin' && user.email_verified === false) {
      throw new ForbiddenError('请先验证邮箱后再使用 AI 推理', 'EMAIL_NOT_VERIFIED');
    }
  },

  /**
   * 统一配额余量视图计算（Spec J2，供 GET /api/quota 使用）
   */
  calculateQuotaUsage(
    ent: Entitlements,
    currentBoardCount: number,
    currentNodeCount: number | null
  ): QuotaUsageCalculation {
    const unlimited = ent.plan === 'admin' || ent.plan === 'vip';
    const boardLimit = unlimited ? null : ent.boardLimit ?? BOARD_LIMIT;
    const nodeLimit = unlimited ? null : ent.nodeLimit ?? NODE_LIMIT;

    const board = { used: currentBoardCount, limit: boardLimit };
    let node: QuotaUsageCalculation['node'] = null;

    if (currentNodeCount !== null && currentNodeCount !== undefined) {
      node = {
        used: currentNodeCount,
        limit: nodeLimit,
        remaining: nodeLimit === null ? null : Math.max(0, nodeLimit - currentNodeCount),
      };
    }

    return { board, node };
  },
};
