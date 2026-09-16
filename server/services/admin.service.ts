import { findUserById, findUserByEmail, updateVipMembership, updateUserEmail as repoUpdateUserEmail, updateUserStatus as repoUpdateUserStatus, restoreAccount as repoRestoreAccount } from '../repositories/user.repository.js';
import { ConflictError } from '../lib/errors.js';
import { sendVerificationEmail } from '../lib/mailer.js';
import crypto from 'node:crypto';
import {
  listAdminUsers,
  getAdminOverview,
} from '../repositories/admin.repository.js';
import { getAiModelConfig, getSavedAiModelConfig, saveAiModelConfig as repoSaveAiModelConfig } from '../repositories/ai.repository.js';
import { recordAuditLog, listAuditLogs } from '../repositories/audit.repository.js';
import { NotFoundError } from '../lib/errors.js';
import { DEFAULT_AI_MODEL_CONFIG } from '../core/records.js';
import type { AiModelConfig, UserRecord } from '../core/records.js';
import { destroyOAuthIdentity, findOAuthIdentityByUserId } from '../repositories/oauth.repository.js';
import { WECHAT_PROVIDER } from './wechat.service.js';

export {
  listAdminUsers,
  getAdminOverview,
} from '../repositories/admin.repository.js';
export { listAllOrders } from '../repositories/billing.repository.js';
export { listAuditLogs };
// Spec I：AI 推演日志与业务事件日志的 admin 分页查询
export { listAiRequestLogs } from '../repositories/ai.repository.js';
export { listEventLogs } from '../repositories/event-log.repository.js';

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
 * Spec F4：Admin 恢复已注销账号（30 天冷却期内）。
 * 未注销或不存在 → 404；成功 → 审计 account_restore。
 */
export async function restoreAccount(
  actorId: string,
  targetUserId: string
): Promise<UserRecord> {
  let restored: UserRecord;
  try {
    restored = await repoRestoreAccount(targetUserId);
  } catch (e: any) {
    // 冷却期内同邮箱已被重新注册占用 → 409（唯一索引冲突）
    if (e?.code === '23505') {
      throw new ConflictError('该邮箱已被新注册账号占用，无法恢复原账号', 'EMAIL_TAKEN_BY_NEW_ACCOUNT');
    }
    throw e;
  }
  if (!restored) throw new NotFoundError('用户不存在或未注销');

  await recordAuditLog({
    userId: actorId,
    action: 'account_restore',
    targetType: 'user',
    targetId: targetUserId,
  });

  return restored;
}

/** 运营台可解除的第三方绑定白名单（目前只有微信；加服务商必须同时改这里与前端文案） */
const UNBINDABLE_PROVIDERS = new Set<string>([WECHAT_PROVIDER]);

/**
 * ADR-0023：运营台解除某用户的第三方登录绑定——**误绑时的唯一退路**。
 *
 * 用户侧刻意不提供自助解绑（单向绑定），但若没有任何解除手段，
 * 「扫了别人的微信 / 手机号被回收后微信号易主」就会留下一个**永久且无法移除**的登录凭据。
 * 用户找客服 → 运营台解绑 → 用户重新绑正确的微信。
 *
 * 调用方在 admin 路由的 `runWithSystem` 作用域内（跨租户），故这里的仓储调用无需额外作用域处理。
 */
export async function unbindOAuthIdentity(data: {
  actorId: string;
  targetUserId: string;
  provider: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ provider: string; nickname: string | null }> {
  if (!UNBINDABLE_PROVIDERS.has(data.provider)) {
    throw new NotFoundError('不支持该第三方登录方式');
  }

  const target = await findUserById(data.targetUserId);
  if (!target) throw new NotFoundError('用户不存在');

  // 删除前取一次昵称：解绑后审计里还能看出「解掉的是谁」，这是排障的唯一线索
  const identity = await findOAuthIdentityByUserId(data.targetUserId, data.provider);
  if (!identity) throw new NotFoundError('该用户未绑定此第三方账号');

  const removed = await destroyOAuthIdentity(data.targetUserId, data.provider);
  if (removed === 0) throw new NotFoundError('该用户未绑定此第三方账号');

  await recordAuditLog({
    userId: data.actorId,
    action: 'admin_oauth_unbind',
    targetType: 'user',
    targetId: data.targetUserId,
    ip: data.ip,
    userAgent: data.userAgent,
    details: { provider: data.provider, nickname: identity.nickname ?? null },
  });

  return { provider: data.provider, nickname: identity.nickname ?? null };
}

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
 * Admin 修改用户邮箱。
 * 规范化查重（软删用户邮箱可复用，F4 口径）→ 更新 email 并重置验证状态（Spec D3）→
 * 向新邮箱发送验证邮件（发信失败不影响改绑）→ 审计 admin_email_change。不踢会话（身份未变）。
 */
export async function adminUpdateUserEmail(data: {
  targetUserId: string;
  newEmail: string;
  actorId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ user: UserRecord; oldEmail: string }> {
  const target = await findUserById(data.targetUserId);
  if (!target) throw new NotFoundError('用户不存在');

  const newEmail = data.newEmail.trim().toLowerCase();
  const oldEmail = target.email;
  if (newEmail === oldEmail) {
    throw new ConflictError('新邮箱与当前邮箱一致，无需修改', 'EMAIL_UNCHANGED');
  }

  const existing = await findUserByEmail(newEmail);
  if (existing) {
    throw new ConflictError('该邮箱已被其他账号使用', 'EMAIL_TAKEN');
  }

  const verifyToken = crypto.randomBytes(32).toString('hex');
  const verifyExpiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  let updated: UserRecord | null;
  try {
    updated = await repoUpdateUserEmail(data.targetUserId, newEmail, verifyToken, verifyExpiresAt);
  } catch (e: any) {
    if (e?.code === '23505') {
      throw new ConflictError('该邮箱已被其他账号使用', 'EMAIL_TAKEN');
    }
    throw e;
  }
  if (!updated) throw new NotFoundError('用户不存在');

  // 发信失败不影响改绑（与 signUp 的验证邮件口径一致）
  const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify-email?token=${verifyToken}`;
  try {
    await sendVerificationEmail(newEmail, verifyUrl);
  } catch (e) {
    console.warn('adminUpdateUserEmail: 验证邮件发送失败（改绑已完成）:', e);
  }

  await recordAuditLog({
    userId: data.actorId || null,
    action: 'admin_email_change',
    targetType: 'user',
    targetId: data.targetUserId,
    ip: data.ip,
    userAgent: data.userAgent,
    details: { targetUserId: data.targetUserId, oldEmail, newEmail },
  });

  return { user: updated, oldEmail };
}

/**
 * GET /model-config 用的掩码视图（密钥脱敏）
 */
export async function getMaskedModelConfig(): Promise<AiModelConfig & { has_openai_key: boolean }> {
  // 基于管理员原始保存值构建掩码视图（而非合并内置默认）：
  // gemini_model 未选择时为空串，前端显示「请选择模型」，保证模型唯一来源是后台配置
  const saved = await getSavedAiModelConfig();
  const config = { ...DEFAULT_AI_MODEL_CONFIG, gemini_model: '', ...saved } as AiModelConfig;
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
