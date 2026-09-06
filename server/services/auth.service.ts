import { hashPassword, verifyPassword, generateSessionToken, isAccountLocked, getRemainingLockMinutes } from '../lib/crypto.js';
import { ConflictError, ForbiddenError, LockedError, NotFoundError, UnauthorizedError } from '../lib/errors.js';
import {
  findUserByEmail,
  findUserById,
  createUser,
  recordFailedLogin,
  resetFailedLogin,
  updateUserProfile,
} from '../repositories/user.repository.js';
import { createSession } from '../repositories/session.repository.js';
import type { UserRecord } from '../core/records.js';

export interface AuthResult {
  user: UserRecord;
  token: string;
}

/**
 * 注册：邮箱查重 + 建号（赠 50,000 初始算力）+ 建会话
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
  const newUser = await createUser({
    email: data.email,
    passwordHash,
    name: data.name,
    role: 'user',
    initialCredits: 50000,
  });

  const token = generateSessionToken();
  await createSession({
    userId: newUser.id,
    token,
    ipAddress: data.ip,
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
    throw new ForbiddenError('该账户已被运营管理员冻结，无法登录', 'ACCOUNT_FROZEN');
  }

  if (isAccountLocked(user.locked_until)) {
    const remainingMinutes = getRemainingLockMinutes(user.locked_until!);
    throw new LockedError(
      `连续输错密码达 5 次，账户已被临时锁定。请在 ${remainingMinutes} 分钟后重试`,
      { remainingMinutes }
    );
  }

  const isMatch = await verifyPassword(data.password, user.password_hash);
  if (!isMatch) {
    const { failedAttempts, lockedUntil } = await recordFailedLogin(user.id);
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
