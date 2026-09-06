import crypto from 'node:crypto';
import { hashPassword, verifyPassword, generateSessionToken, isAccountLocked, getRemainingLockMinutes } from '../lib/crypto.js';
import { ConflictError, ForbiddenError, LockedError, NotFoundError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { sendVerificationEmail } from '../lib/mailer.js';
import {
  findUserByEmail,
  findUserById,
  createUser,
  recordFailedLogin,
  resetFailedLogin,
  updateUserProfile,
  setVerificationToken,
} from '../repositories/user.repository.js';
import { createSession } from '../repositories/session.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import type { UserRecord } from '../core/records.js';

export interface AuthResult {
  user: UserRecord;
  token: string;
}

/**
 * 注册：邮箱查重 + 建号 + 建会话
 */
export async function signUp(data: {
  email: string;
  password: string;
  name?: string;
  ip?: string;
  userAgent?: string;
}): Promise<AuthResult> {
  const existing = await findUserByEmail(data.email);
  if (existing) {
    throw new ConflictError('该邮箱已被注册，请直接登录', 'EMAIL_EXISTS');
  }

  const passwordHash = await hashPassword(data.password);
  const verifyToken = crypto.randomBytes(32).toString('hex');
  const verifyExpiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const newUser = await createUser({
    email: data.email,
    passwordHash,
    name: data.name,
    role: 'user',
    emailVerified: false,
    verifyToken,
    verifyExpiresAt,
  });

  // Spec D3：注册即发验证邮件；发信失败不影响注册
  const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify-email?token=${verifyToken}`;
  await sendVerificationEmail(newUser.email, verifyUrl);

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
