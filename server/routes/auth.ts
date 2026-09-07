import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { deleteSession, findSession } from '../repositories/session.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { signUp, signIn, updateProfile, resendVerification, requestPasswordReset, resetPassword, changeOwnPassword, deleteOwnAccount } from '../services/auth.service.js';
import { markEmailVerifiedByToken } from '../repositories/user.repository.js';
import { ValidationError } from '../lib/errors.js';
import { subscribeUserPlan, isPaymentEnabled } from '../services/billing.service.js';
import { submitFeedback } from '../services/feedback.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { effectiveEntitlements } from '../services/quota.service.js';
import type { Response as ExpressResponse } from 'express';
import { authMiddleware, loginRateLimiter, signupRateLimiter, resendVerificationRateLimiter, forgotPasswordRateLimiter } from '../middleware/auth.js';

export const authRouter = Router();

// Zod schemas
const SignUpSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(6, '密码长度至少为 6 位'),
  name: z.string().max(50).optional(),
});

const SignInSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(1, '请输入密码'),
});

const UpdateProfileSchema = z.object({
  name: z.string().min(1, '昵称不能为空').max(50).optional(),
  avatar: z.string().max(500).optional(),
});

const FeedbackSchema = z.object({
  type: z.enum(['suggestion', 'bug', 'other']),
  rating: z.number().int().min(1).max(5).optional(),
  content: z.string().min(1, '请填写反馈内容').max(2000),
  contactInfo: z.string().max(255).optional(),
});

const SubscribeSchema = z.object({
  plan: z.enum(['weekly', 'monthly', 'yearly']),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1, '缺少重置令牌'),
  password: z.string().min(6, '密码长度至少为 6 位'),
});

const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入旧密码'),
  newPassword: z.string().min(6, '新密码长度至少为 6 位'),
});

/**
 * Set session cookie (7 days)
 */
function setSessionCookie(res: ExpressResponse, token: string): void {
  res.cookie('session_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 3600 * 1000, // 7 days
  });
}

function publicUser(user: {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: string;
  vip_expires_at?: string | null;
  email_verified?: boolean;
  is_active?: boolean;
  created_at?: string;
  last_login_at?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    role: user.role,
    vip_expires_at: user.vip_expires_at,
    email_verified: user.email_verified,
  };
}

/**
 * POST /api/auth/sign-up
 * Register a new user & auto session cookie
 */
authRouter.post('/sign-up', signupRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email, password, name } = validate(SignUpSchema, req.body);
  const { user, token } = await signUp({
    email,
    password,
    name,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  setSessionCookie(res, token);

  res.status(201).json({
    success: true,
    message: '注册成功，欢迎加入 枝想！',
    user: publicUser(user),
    token,
  });
}));

/**
 * POST /api/auth/sign-in
 * Email/password login with brute-force protection
 */
authRouter.post('/sign-in', loginRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = validate(SignInSchema, req.body);
  const { user, token } = await signIn({
    email,
    password,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  setSessionCookie(res, token);

  res.json({
    success: true,
    message: '登录成功',
    user: {
      ...publicUser(user),
      vip_expires_at: user.vip_expires_at,
    },
    token,
  });
}));

/**
 * POST /api/auth/sign-out
 * Clear session and cookie
 */
authRouter.post('/sign-out', asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.session_token || req.headers.authorization?.slice(7).trim();
  if (token) {
    const result = await findSession(token).catch(() => null);
    await deleteSession(token);
    await recordAuditLog({
      userId: result?.user.id || null,
      action: 'sign_out',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true, message: '已安全登出' });
}));

/**
 * DELETE /api/auth/account
 * Spec F4：用户自助注销（软删除 + 30 天冷却期内可由管理员恢复）
 */
authRouter.delete('/account', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  await deleteOwnAccount(req.user!.id);
  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true, message: '账号已注销，30 天内可联系管理员恢复' });
}));

/**
 * GET /api/auth/me
 * Get current session user profile
 */
authRouter.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = req.user!;
  const entitlements = effectiveEntitlements(user);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      vip_expires_at: user.vip_expires_at,
      email_verified: user.email_verified,
      is_active: user.is_active,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      entitlements,
    },
  });
});

/**
 * POST /api/auth/profile
 * Update user nickname & avatar
 */
authRouter.post('/profile', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { name, avatar } = validate(UpdateProfileSchema, req.body);
  const user = req.user!;

  const updated = await updateProfile({
    userId: user.id,
    name,
    avatar,
  });

  res.json({
    success: true,
    message: '个人信息更新成功！',
    user: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      avatar: updated.avatar,
      role: updated.role,
      vip_expires_at: updated.vip_expires_at,
      is_active: updated.is_active,
      created_at: updated.created_at,
      last_login_at: updated.last_login_at,
    },
  });
}));

/**
 * GET /api/auth/verify-email（公开，无 auth）
 * Spec D3：校验验证令牌并标记邮箱已验证
 */
authRouter.get('/verify-email', asyncHandler(async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    throw new ValidationError('缺少验证令牌', 'INVALID_TOKEN');
  }

  const verified = await markEmailVerifiedByToken(token);
  if (!verified) {
    throw new ValidationError('验证链接无效或已过期', 'INVALID_TOKEN');
  }

  res.json({ success: true, message: '邮箱验证成功' });
}));

/**
 * POST /api/auth/resend-verification（authMiddleware）
 * Spec D3：未验证账号重发验证邮件
 */
authRouter.post('/resend-verification', authMiddleware, resendVerificationRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  await resendVerification(req.user!.id);
  res.json({ success: true, message: '验证邮件已重新发送，请查收' });
}));

/**
 * POST /api/auth/forgot-password（公开）
 * Spec F1：发起找回密码。无论邮箱是否存在恒 200（防账号枚举）。
 */
authRouter.post('/forgot-password', forgotPasswordRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email } = validate(ForgotPasswordSchema, req.body);
  const origin = `${req.protocol}://${req.get('host')}`;
  await requestPasswordReset(email, origin);
  res.json({ success: true, message: '若该邮箱已注册，重置链接已发送' });
}));

/**
 * POST /api/auth/reset-password（公开）
 * Spec F1：凭令牌重置密码，成功后踢下线全部会话。
 */
authRouter.post('/reset-password', asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = validate(ResetPasswordSchema, req.body);
  await resetPassword({
    token,
    newPassword: password,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({ success: true, message: '密码已重置，请使用新密码登录' });
}));

/**
 * POST /api/auth/change-password（登录态）
 * 已登录修改密码：旧密码校验 → 更新 → 踢全部会话（需重新登录）。
 * 复用 loginRateLimiter 防旧密码爆破。
 */
authRouter.post('/change-password', authMiddleware, loginRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { oldPassword, newPassword } = validate(ChangePasswordSchema, req.body);
  await changeOwnPassword({
    userId: req.user!.id,
    oldPassword,
    newPassword,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true, message: '密码已修改，请使用新密码重新登录' });
}));

/**
 * POST /api/auth/feedback
 * Submit user feedback & suggestion
 */
authRouter.post('/feedback', asyncHandler(async (req: Request, res: Response) => {
  const { type, rating, content, contactInfo } = validate(FeedbackSchema, req.body);

  // Optional user attachment via session token
  const token = req.cookies?.session_token || req.headers.authorization?.slice(7).trim();

  const fb = await submitFeedback({ token, type, rating, content, contactInfo });

  res.status(201).json({
    success: true,
    message: '感谢您的宝贵建议！我们已收到您的反馈并会认真评估。',
    feedbackId: fb.id,
  });
}));

/**
 * POST /api/auth/subscribe
 * Subscribe to weekly / monthly / yearly Pro membership
 * 一期未接真实支付，PAYMENT_ENABLED 默认禁用（503），过渡走微信人工充值。
 */
authRouter.post('/subscribe', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  if (!isPaymentEnabled()) {
    res.status(503).json({ error: '在线支付暂未开放，请通过客服微信人工充值开通会员', code: 'PAYMENT_DISABLED' });
    return;
  }
  const { plan } = validate(SubscribeSchema, req.body);
  const user = req.user!;

  const { role, vip_expires_at, user: updatedUser } = await subscribeUserPlan({
    userId: user.id,
    plan,
  });

  const planNames = {
    weekly: '周度 Pro 会员 (7天)',
    monthly: '月度 Pro 会员 (30天)',
    yearly: '年度 Pro 会员 (365天)',
  };

  res.json({
    success: true,
    message: `恭喜！已成功开通 ${planNames[plan]}，尊享无限画板与无限 AI 深度推演！`,
    role,
    vip_expires_at,
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      role: updatedUser.role,
      vip_expires_at: updatedUser.vip_expires_at,
      is_active: updatedUser.is_active,
    },
  });
}));
