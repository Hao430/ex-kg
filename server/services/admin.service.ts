import { findUserById, updateVipMembership, updateUserStatus as repoUpdateUserStatus } from '../repositories/user.repository.js';
import {
  listAdminUsers,
  getAdminOverview,
} from '../repositories/admin.repository.js';
import { getAiModelConfig, saveAiModelConfig as repoSaveAiModelConfig } from '../repositories/ai.repository.js';
import { recordAuditLog, listAuditLogs } from '../repositories/audit.repository.js';
import { NotFoundError } from '../lib/errors.js';
import type { AiModelConfig, UserRecord } from '../core/records.js';

export {
  listAdminUsers,
  getAdminOverview,
} from '../repositories/admin.repository.js';
export { listAllOrders } from '../repositories/billing.repository.js';
export { listAuditLogs };

/** 操作者上下文：由路由层传入，用于审计日志记录 */
export interface AuditContext {
  actorId?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Admin 冻结/解冻用户（含审计：user_freeze / user_unfreeze）
 */
export async function updateUserStatus(
  userId: string,
  isActive: boolean,
  ctx?: AuditContext
): Promise<UserRecord | null> {
  const updated = await repoUpdateUserStatus(userId, isActive);
  if (updated) {
    await recordAuditLog({
      userId: ctx?.actorId || null,
      action: isActive ? 'user_unfreeze' : 'user_freeze',
      targetType: 'user',
      targetId: userId,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
      details: { targetUserId: userId, isActive },
    });
  }
  return updated;
}

export type AdminOverview = Awaited<ReturnType<typeof getAdminOverview>>;

/**
 * Grant or extend VIP days for a user by admin
 */
export async function grantUserVipDays(data: {
  userId: string;
  days: number;
  actorId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ role: string; vip_expires_at: string | null; user: UserRecord }> {
  const currentUser = await findUserById(data.userId);
  if (!currentUser) throw new NotFoundError('用户不存在');

  let baseTime = Date.now();
  if (currentUser.vip_expires_at && new Date(currentUser.vip_expires_at).getTime() > baseTime) {
    baseTime = new Date(currentUser.vip_expires_at).getTime();
  }

  let newExpiresAt: string | null = null;
  let newRole: string = currentUser.role;

  if (data.days > 0) {
    newExpiresAt = new Date(baseTime + data.days * 24 * 3600 * 1000).toISOString();
    if (newRole !== 'admin') newRole = 'vip';
  } else if (data.days === 0) {
    newExpiresAt = null;
    if (newRole !== 'admin') newRole = 'user';
  }

  const updated = await updateVipMembership({
    userId: data.userId,
    role: newRole,
    vipExpiresAt: newExpiresAt,
  });
  if (!updated) throw new NotFoundError('用户不存在');

  await recordAuditLog({
    userId: data.actorId || null,
    action: data.days > 0 ? 'vip_grant' : 'vip_revoke',
    targetType: 'user',
    targetId: data.userId,
    ip: data.ip,
    userAgent: data.userAgent,
    details: { targetUserId: data.userId, days: data.days },
  });

  return { role: updated.role, vip_expires_at: updated.vip_expires_at || null, user: updated };
}

/**
 * GET /model-config 用的掩码视图（密钥脱敏）
 */
export async function getMaskedModelConfig(): Promise<AiModelConfig & { has_openai_key: boolean }> {
  const config = await getAiModelConfig();
  const hasKey = Boolean(config.openai_api_key && config.openai_api_key.trim().length > 0);
  const maskedKey = hasKey
    ? config.openai_api_key.length > 8
      ? `${config.openai_api_key.slice(0, 3)}••••••••${config.openai_api_key.slice(-4)}`
      : '••••••••'
    : '';

  return {
    ...config,
    openai_api_key: maskedKey,
    has_openai_key: hasKey,
  };
}

/**
 * PUT /model-config：掩码或空 key 保留旧值
 */
export async function resolveConfigForSave(config: Partial<AiModelConfig>): Promise<Partial<AiModelConfig>> {
  const currentConfig = await getAiModelConfig();
  let newApiKey = config.openai_api_key;

  if (!newApiKey || newApiKey.includes('••••') || newApiKey.trim() === '') {
    newApiKey = currentConfig.openai_api_key || '';
  }

  return { ...config, openai_api_key: newApiKey };
}

/**
 * Admin 保存模型配置（含审计：model_config_update）
 */
export async function saveModelConfigWithAudit(
  config: Partial<AiModelConfig>,
  operatorEmail?: string,
  ctx?: AuditContext
): Promise<AiModelConfig> {
  const saved = await repoSaveAiModelConfig(config, operatorEmail);
  await recordAuditLog({
    userId: ctx?.actorId || null,
    action: 'model_config_update',
    targetType: 'model_config',
    ip: ctx?.ip,
    userAgent: ctx?.userAgent,
    details: { operatorEmail, provider: saved.provider },
  });
  return saved;
}

/**
 * 按ID取用户，不存在抛 404
 */
export async function getUserOrFail(id: string): Promise<UserRecord> {
  const user = await findUserById(id);
  if (!user) throw new NotFoundError('用户不存在');
  return user;
}
