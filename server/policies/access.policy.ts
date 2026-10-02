import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { UserRecord } from '../core/records.js';

export interface CanvasOwnerCheckInfo {
  exists: boolean;
  ownerId: string | null;
}

/**
 * AccessPolicy: 权限校验、账户可用状态、资源归属与 IDOR 防护的唯一事实源。
 * 纯领域策略层实现，无状态、无数据库依赖、100% 可独立单元测试。
 */
export const AccessPolicy = {
  /**
   * 账号可用性校验（防冻结用户执行读写与鉴权）
   */
  assertUserActive(user: Pick<UserRecord, 'is_active'>): void {
    if (!user.is_active) {
      throw new ForbiddenError('账号已被系统冻结，请联系运营管理员', 'ACCOUNT_FROZEN');
    }
  },

  /**
   * 系统管理员角色校验
   */
  assertAdmin(user: Pick<UserRecord, 'role'> | undefined): void {
    if (!user || user.role !== 'admin') {
      throw new ForbiddenError('越权访问：该接口仅限系统管理员访问', 'FORBIDDEN_ADMIN_ONLY');
    }
  },

  /**
   * 画布归属与归因准入校验（ADR-0016 严格属主制 + IDOR 保护）：
   * - 画布若存在，必须为当前用户属主（或为 ADR-0018 的 legacy 共享默认画板）；
   * - 他人画板恒返回 404（避免泄露存在性）；
   * - 尚未落库的画板（exists=false，如首节点对话先于首次保存）放行。
   */
  assertCanvasAttributable(
    userId: string,
    canvasInfo: CanvasOwnerCheckInfo,
    isSharedDefault = false
  ): void {
    if (canvasInfo.exists && canvasInfo.ownerId !== userId && !isSharedDefault) {
      throw new NotFoundError('画板不存在或无权访问 (IDOR Protected)');
    }
  },

  /**
   * 画布分享创建与管理权限校验
   */
  assertCanShareCanvas(userId: string, canvasOwnerId: string | null): void {
    if (canvasOwnerId !== userId) {
      throw new ForbiddenError('只能分享自己的画板', 'CANVAS_FORBIDDEN');
    }
  },

  /**
   * 画布分享管理（撤销/重新生成）权限校验
   */
  assertCanManageShare(userId: string, canvasOwnerId: string | null): void {
    if (canvasOwnerId !== userId) {
      throw new ForbiddenError('只能管理自己的画板分享', 'CANVAS_FORBIDDEN');
    }
  },

  /**
   * 画板分组归属校验
   */
  assertFolderOwnership(
    userId: string,
    folderOwnerId: string,
    action: 'modify' | 'delete' = 'modify'
  ): void {
    if (folderOwnerId !== userId) {
      const actionText = action === 'delete' ? '删除' : '修改';
      throw new ForbiddenError(`无权${actionText}其他用户的分组`, 'FOLDER_FORBIDDEN');
    }
  },

  /**
   * 订单归属校验
   */
  assertOrderOwnership(userId: string, orderUserId: string): void {
    if (orderUserId !== userId) {
      throw new ForbiddenError('无权操作此订单');
    }
  },
};
