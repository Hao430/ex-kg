import crypto from 'node:crypto';
import { hashPassword, verifyPassword, needsRehash, generateSessionToken, isAccountLocked, getRemainingLockMinutes } from '../lib/crypto.js';
import { AppError, ConflictError, ForbiddenError, LockedError, NotFoundError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendVerificationCodeEmail } from '../lib/mailer.js';
import { upsertCode, getCode, consumeCode, EMAIL_CODE_MAX_ATTEMPTS } from '../repositories/email-code.repository.js';
import {
  findUserByEmail,
  findUserById,
  createUser,
  recordFailedLogin,
  resetFailedLogin,
  updateUserProfile,
  setVerificationToken,
  setPasswordResetToken,
  markPasswordResetByToken,
  updateUserPassword,
  deleteAccount,
} from '../repositories/user.repository.js';
import { createSession, deleteUserSessions } from '../repositories/session.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import type { UserRecord } from '../core/records.js';

export interface AuthResult {
  user: UserRecord;
  token: string;
}

/**
 * 注册：邮箱查重 + 验证码校验（验证先行才建号）+ 建号（出生即 email_verified=true）+ 建会话
 */
export async function signUp(data: {
  email: string;
  password: string;
  code: string;
  name?: string;
  ip?: string;
  userAgent?: string;
}): Promise<AuthResult> {
  const email = data.email.toLowerCase().trim();
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new ConflictError('该邮箱已被注册，请直接登录', 'EMAIL_EXISTS');
  }

  // 验证码先行：无有效验证码不得建号。先查重后消费，避免已注册邮箱借码链路探测
  const consumed = await consumeCode(email, data.code);
  if (consumed.result === 'invalid') {
    throw new ValidationError('验证码错误或已过期，请重新获取', 'INVALID_CODE');
  }
  if (consumed.result === 'mismatch') {
    const remaining = Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - consumed.attempts);
    throw new ValidationError(
      remaining > 0
        ? `验证码错误，还可尝试 ${remaining} 次`
        : '验证码错误次数过多，请重新获取',
      'INVALID_CODE'
    );
  }

  const passwordHash = await hashPassword(data.password);
  const newUser = await createUser({
    email,
    passwordHash,
    name: data.name,
    role: 'user',
    emailVerified: true,
  });

  const token = generateSessionToken();
  await createSession({
    userId: newUser.id,
    token,
    ipAddress: data.ip,
    userAgent: data.userAgent,
  });

  await recordAuditLog({
    userId: newUser.id,
    action: 'sign_up',
    ip: data.ip,
    userAgent: data.userAgent,
  });

  return { user: newUser, token };
}

/**
 * 发送注册邮箱验证码（6 位数字，10 分钟有效；每邮箱 60s 冷却）。
 * 邮箱已注册 → 409 EMAIL_EXISTS（与 sign-up 查重口径一致）。
 */
export async function sendRegisterCode(email: string): Promise<void> {
  const normalized = email.toLowerCase().trim();
  const existing = await findUserByEmail(normalized);
  if (existing) {
    throw new ConflictError('该邮箱已被注册，请直接登录', 'EMAIL_EXISTS');
  }

  const rec = await getCode(normalized);
  if (rec && Date.now() - new Date(rec.updated_at).getTime() < 60 * 1000) {
    throw new AppError(429, 'CODE_COOLDOWN', '验证码发送过于频繁，请 1 分钟后再试');
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await upsertCode(normalized, code, expiresAt);

  // 发信失败仅 warn，不影响响应（用户可重发，受冷却/限流保护）
  await sendVerificationCodeEmail(normalized, code);
}

/**
 * 登录：状态检查 + 防爆破锁定 + 验密 + 建会话
 */
export async function signIn(data: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<AuthResult> {
  const user = await findUserByEmail(data.email);

  if (!user) {
    throw new UnauthorizedError('账号或密码错误', 'INVALID_CREDENTIALS');
  }

  if (!user.is_active) {
    await recordAuditLog({ userId: user.id, action: 'sign_in_failed', details: { reason: 'account_frozen' }, ip: data.ip, userAgent: data.userAgent });
    throw new ForbiddenError('该账户已被运营管理员冻结，无法登录', 'ACCOUNT_FROZEN');
  }

  if (isAccountLocked(user.locked_until)) {
    const remainingMinutes = getRemainingLockMinutes(user.locked_until!);
    await recordAuditLog({ userId: user.id, action: 'sign_in_failed', details: { reason: 'account_locked' }, ip: data.ip, userAgent: data.userAgent });
    throw new LockedError(
      `连续输错密码达 5 次，账户已被临时锁定。请在 ${remainingMinutes} 分钟后重试`,
      { remainingMinutes }
    );
  }

  const isMatch = await verifyPassword(data.password, user.password_hash);
  if (!isMatch) {
    const { failedAttempts, lockedUntil } = await recordFailedLogin(user.id);
    await recordAuditLog({ userId: user.id, action: 'sign_in_failed', details: { reason: 'wrong_password', failedAttempts }, ip: data.ip, userAgent: data.userAgent });
    if (lockedUntil) {
      throw new LockedError('连续 5 次输错密码，账号已被锁定 15 分钟', { remainingMinutes: 15 });
    }

    throw new UnauthorizedError(
      `账号或密码错误（连续输错 5 次将锁定 15 分钟，当前失败 ${failedAttempts} 次）`,
      'INVALID_CREDENTIALS',
      { failedAttempts }
    );
  }

  // 登录成功：重置失败计数
  await resetFailedLogin(user.id);

  // Spec F5：旧参数哈希透明升级到新 scrypt 参数
  if (needsRehash(user.password_hash)) {
    const upgraded = await hashPassword(data.password);
    await updateUserPassword(user.id, upgraded);
    user.password_hash = upgraded;
  }

  const token = generateSessionToken();
  await createSession({
    userId: user.id,
    token,
    ipAddress: data.ip,
    userAgent: data.userAgent,
  });

  await recordAuditLog({
    userId: user.id,
    action: 'sign_in',
    ip: data.ip,
    userAgent: data.userAgent,
  });

  return { user, token };
}

/**
 * Spec F4：用户自助注销账号。
 * 软删除（deleted_at + is_active=false）+ 踢下线全部会话 + 审计 account_deletion。
 */
export async function deleteOwnAccount(userId: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new NotFoundError('未找到该用户');
  }

  await deleteAccount(user.id);

  await recordAuditLog({
    userId,
    action: 'account_deletion',
    targetType: 'user',
    targetId: userId,
  });
}

/**
 * 更新个人资料
 */
export async function updateProfile(data: {
  userId: string;
  name?: string;
  avatar?: string;
}): Promise<UserRecord> {
  const updated = await updateUserProfile(data);
  if (!updated) {
    throw new NotFoundError('未找到该用户');
  }
  return updated;
}

/**
 * Spec D3：重发验证邮件（新 token 覆盖旧 token）。
 * 已验证账号 → 400 EMAIL_ALREADY_VERIFIED（测试契约要求 400，而非 409）。
 */
export async function resendVerification(userId: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new NotFoundError('未找到该用户');
  }
  if (user.email_verified) {
    throw new ValidationError('邮箱已验证', 'EMAIL_ALREADY_VERIFIED');
  }

  const verifyToken = crypto.randomBytes(32).toString('hex');
  const verifyExpiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await setVerificationToken(user.id, verifyToken, verifyExpiresAt);

  const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify-email?token=${verifyToken}`;
  await sendVerificationEmail(user.email, verifyUrl);
}

/**
 * Spec F1：发起找回密码。
 * 邮箱不存在直接静默返回（防账号枚举）；存在则生成 1h token 并发送重置邮件。
 */
export async function requestPasswordReset(email: string, origin: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) return;

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await setPasswordResetToken(user.id, resetToken, resetExpiresAt);

  const resetUrl = `${process.env.APP_URL || origin}/reset-password?token=${resetToken}`;
  await sendPasswordResetEmail(user.email, resetUrl);
}

/**
 * Spec F1：重置密码。
 * token 无效/过期 → 400 INVALID_TOKEN；成功 → 更新密码 + 清空 token + 删除全部会话（踢下线）+ 审计。
 */
export async function resetPassword(data: {
  token: string;
  newPassword: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const user = await markPasswordResetByToken(data.token);
  if (!user) {
    throw new AppError(400, 'INVALID_TOKEN', '重置链接无效或已过期');
  }

  const passwordHash = await hashPassword(data.newPassword);
  await updateUserPassword(user.id, passwordHash);
  await deleteUserSessions(user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'password_reset',
    ip: data.ip,
    userAgent: data.userAgent,
  });
}

/**
 * 已登录修改密码。
 * 旧密码错误 → 400 WRONG_OLD_PASSWORD；成功 → 更新密码 + 删除全部会话（含当前，需重新登录）+ 审计。
 */
export async function changeOwnPassword(data: {
  userId: string;
  oldPassword: string;
  newPassword: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const user = await findUserById(data.userId);
  if (!user) {
    throw new NotFoundError('未找到该用户');
  }

  const isMatch = await verifyPassword(data.oldPassword, user.password_hash);
  if (!isMatch) {
    throw new AppError(400, 'WRONG_OLD_PASSWORD', '旧密码不正确');
  }

  const passwordHash = await hashPassword(data.newPassword);
  await updateUserPassword(user.id, passwordHash);
  await deleteUserSessions(user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'password_change',
    ip: data.ip,
    userAgent: data.userAgent,
  });
}
