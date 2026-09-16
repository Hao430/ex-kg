import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { deleteSession, findSession } from '../repositories/session.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { signUp, signIn, updateProfile, resendVerification, requestPasswordReset, resetPassword, changeOwnPassword, deleteOwnAccount, sendRegisterCode } from '../services/auth.service.js';
import { markEmailVerifiedByToken } from '../repositories/user.repository.js';
import { ValidationError } from '../lib/errors.js';
import { OAUTH_UNSET_PASSWORD_HASH } from '../lib/crypto.js';
import { isPlaceholderEmail } from '../services/wechat.service.js';
import { submitFeedback } from '../services/feedback.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { resolveRequestOrigin } from '../lib/origin.js';
import { effectiveEntitlements } from '../services/quota.service.js';
import { setSessionCookie, clearSessionCookie, extractSessionToken } from '../lib/session-cookie.js';
import { runWithSystem } from '../core/db-context.js';
import { authMiddleware, loginRateLimiter, signupRateLimiter, resendVerificationRateLimiter, forgotPasswordRateLimiter, resetPasswordRateLimiter, sendRegisterCodeRateLimiter, bindEmailSendCodeRateLimiter, bindEmailRateLimiter } from '../middleware/auth.js';
import { bindEmail, bindEmailSendCode, getWechatBinding } from '../services/account-binding.service.js';

export const authRouter = Router();

// Zod schemas
const SignUpSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(6, '密码长度至少为 6 位'),
  code: z.string().regex(/^\d{6}$/, '请输入 6 位数字验证码'),
  name: z.string().max(50).optional(),
});

const SendRegisterCodeSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
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

/** ADR-0023 绑定邮箱：与注册同款的邮箱 + 6 位验证码（**刻意不含密码**） */
const BindEmailSendCodeSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
});

const BindEmailSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  code: z.string().regex(/^\d{6}$/, '请输入 6 位数字验证码'),
});

/**
 * ADR-0022：账号构成标记，**由服务端派生而非新增数据库列**。
 * 纯微信账号的 email 是占位地址（`@wechat.invalid`）、password_hash 是不可满足的哨兵，
 * 前端据此把「邮箱」改称「微信登录」、并隐藏修改密码表单（旧密码未知，表单必然失败）。
 * 判据留在服务端，前端不重复实现「什么算占位」。
 */
function accountFlavor(user: { email: string; password_hash: string }) {
  return {
    email_placeholder: isPlaceholderEmail(user.email),
    has_password: user.password_hash !== OAUTH_UNSET_PASSWORD_HASH,
  };
}

function publicUser(user: {
  id: string;
  email: string;
  password_hash: string;
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
    ...accountFlavor(user),
  };
}

/**
 * POST /api/auth/send-register-code（公开）
 * 发送注册邮箱验证码（6 位数字，10 分钟有效；每邮箱 60s 冷却 + 每 IP 5/h 限流）。
 * 邮箱已注册 → 409 EMAIL_EXISTS（与 sign-up 查重口径一致）。
 */
authRouter.post('/send-register-code', sendRegisterCodeRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email } = validate(SendRegisterCodeSchema, req.body);
  // 账号建立前按 email 寻址 → 跨租户（ADR-0019 显式豁免，见 ADR-0019「作用域清单」）
  await runWithSystem('auth: send-register-code 按 email 查重（账号建立前无租户）', () =>
    sendRegisterCode(email)
  );
  res.json({ success: true, message: '验证码已发送至您的邮箱，10 分钟内有效' });
}));

/**
 * POST /api/auth/sign-up
 * Register a new user & auto session cookie（需先通过 send-register-code 获取验证码）
 *
 * 会话令牌**只经 httpOnly cookie 下发**，不进响应体（安全审查 M1）。
 * 曾把 `token` 一并放进 JSON：浏览器端从不读它，却把 httpOnly 的保证拆掉——
 * 响应日志、反向代理缓存与任何一处 XSS 都能捞到一枚可复用的 Bearer 凭据。
 * `/api/auth/sign-in` 同理。
 */
authRouter.post('/sign-up', signupRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email, password, code, name } = validate(SignUpSchema, req.body);
  // 建号前按 email 查重、消费验证码，全是跨租户寻址
  const { user, token } = await runWithSystem('auth: sign-up 按 email 查重并建号（账号建立前无租户）', () =>
    signUp({
      email,
      password,
      code,
      name,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
  );

  setSessionCookie(res, token);

  res.status(201).json({
    success: true,
    message: '注册成功，欢迎加入 枝想！',
    user: publicUser(user),
  });
}));

/**
 * POST /api/auth/sign-in
 * Email/password login with brute-force protection
 */
authRouter.post('/sign-in', loginRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = validate(SignInSchema, req.body);
  // 登录前还不知道是谁 → 只能按 email 跨租户查
  const { user, token } = await runWithSystem('auth: sign-in 按 email 查用户（登录前无租户）', () =>
    signIn({
      email,
      password,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
  );

  setSessionCookie(res, token);

  res.json({
    success: true,
    message: '登录成功',
    user: {
      ...publicUser(user),
      vip_expires_at: user.vip_expires_at,
    },
  });
}));

/**
 * POST /api/auth/sign-out
 * Clear session and cookie
 */
authRouter.post('/sign-out', asyncHandler(async (req: Request, res: Response) => {
  const token = extractSessionToken(req);
  if (token) {
    // 登出端点刻意不挂 authMiddleware（令牌可能已过期，也要能清 cookie），
    // 因此这里同样是「按 token 定位会话」的跨租户路径
    await runWithSystem('auth: sign-out 按 token 定位并删除会话', async () => {
      const result = await findSession(token).catch(() => null);
      await deleteSession(token);
      await recordAuditLog({
        userId: result?.user.id || null,
        action: 'sign_out',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });
  }
  clearSessionCookie(res);
  res.json({ success: true, message: '已安全登出' });
}));

/**
 * DELETE /api/auth/account
 * Spec F4：用户自助注销（软删除 + 30 天冷却期内可由管理员恢复）
 */
authRouter.delete('/account', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  await deleteOwnAccount(req.user!.id);
  clearSessionCookie(res);
  res.json({ success: true, message: '账号已注销，30 天内可联系管理员恢复' });
}));

/**
 * GET /api/auth/me
 * Get current session user profile
 */
authRouter.get('/me', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const entitlements = effectiveEntitlements(user);
  // ADR-0023：绑定状态只在这里查（不放进 publicUser）——publicUser 是 sign-up/sign-in 的
  // 纯行格式化器，那些响应不需要也不该承担这次查询。本 handler 已在 authMiddleware 建立的
  // runWithUser 作用域内，ALS 跨 await 存活，因此按 user_id 查 oauth_identities 天然放行。
  const wechat = await getWechatBinding(user.id);
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
      ...accountFlavor(user),
      wechat_bound: wechat.bound,
      wechat_nickname: wechat.nickname,
      entitlements,
    },
  });
}));

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

  const verified = await runWithSystem('auth: verify-email 按令牌标记邮箱（无登录态）', () =>
    markEmailVerifiedByToken(token)
  );
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
  // Host 头是请求方可控的：直接拼 `${req.protocol}://${req.get('host')}` 会让攻击者
  // 用伪造 Host + 受害者邮箱触发一封「重置链接指向攻击者域名」的邮件（重置投毒，
  // 令牌明文入库、点击即换号）。resolveRequestOrigin 先取 APP_URL，未配置才用经
  // 字符白名单校验的 Host，两者都不可信时抛 500（安全审查 M3）。
  const origin = resolveRequestOrigin(req);
  await runWithSystem('auth: forgot-password 按 email 发重置链接（账号建立前无租户）', () =>
    requestPasswordReset(email, origin)
  );
  res.json({ success: true, message: '若该邮箱已注册，重置链接已发送' });
}));

/**
 * POST /api/auth/reset-password（公开）
 * Spec F1：凭令牌重置密码，成功后踢下线全部会话。
 * 限流（安全审查 L1）：令牌不可枚举，但成功路径要跑 scrypt，匿名不限流即 CPU 放大面。
 */
authRouter.post('/reset-password', resetPasswordRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = validate(ResetPasswordSchema, req.body);
  await runWithSystem('auth: reset-password 按令牌重置并踢下线（无登录态）', () =>
    resetPassword({
      token,
      newPassword: password,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
  );
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
  clearSessionCookie(res);
  res.json({ success: true, message: '密码已修改，请使用新密码重新登录' });
}));

/**
 * POST /api/auth/bind-email/send-code（登录态，ADR-0023）
 * 为「微信自动建号的账号」补绑邮箱时发送验证码（6 位，10 分钟，每邮箱 60s 冷却）。
 * 仅占位邮箱账号可用（真实邮箱账号 → 400 EMAIL_ALREADY_BOUND，即不提供换绑）。
 */
authRouter.post('/bind-email/send-code', authMiddleware, bindEmailSendCodeRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email } = validate(BindEmailSendCodeSchema, req.body);
  await bindEmailSendCode({ userId: req.user!.id, email });
  res.json({ success: true, message: '绑定验证码已发送至该邮箱，10 分钟内有效' });
}));

/**
 * POST /api/auth/bind-email（登录态，ADR-0023）
 * 补绑邮箱：只绑邮箱**不设密码**，绑完 email_verified 仍为 true、会话不踢。
 * 想用邮箱+密码登录的用户，之后走登录页「忘记密码」自助设置（该地址此时已可达）。
 */
authRouter.post('/bind-email', authMiddleware, bindEmailRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email, code } = validate(BindEmailSchema, req.body);
  const user = await bindEmail({
    userId: req.user!.id,
    email,
    code,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({
    success: true,
    message: '邮箱绑定成功，可通过「忘记密码」设置登录密码',
    user: publicUser(user),
  });
}));

/**
 * POST /api/auth/feedback
 * Submit user feedback & suggestion
 */
authRouter.post('/feedback', asyncHandler(async (req: Request, res: Response) => {
  const { type, rating, content, contactInfo } = validate(FeedbackSchema, req.body);

  // Optional user attachment via session token
  const token = extractSessionToken(req);

  // 反馈可匿名提交（token 可选）→ 按令牌归属，属跨租户寻址
  const fb = await runWithSystem('auth: feedback 按可选令牌归属提交（可匿名）', () =>
    submitFeedback({ token, type, rating, content, contactInfo })
  );

  res.status(201).json({
    success: true,
    message: '感谢您的宝贵建议！我们已收到您的反馈并会认真评估。',
    feedbackId: fb.id,
  });
}));

/**
 * 已删除（2026-09-14）：POST /api/auth/subscribe「一步开通」。
 *
 * 它只挡 `isPaymentEnabled()` 就建单并激活（`status:'paid'` + 叠期），**全程没有任何支付**：
 * `PAYMENT_ENABLED=true` 的任何环境里，登录用户 POST 一次即白拿 30 天 VIP，可无限叠加。
 * 该洞恰好在「上线支付」那一步打开（部署手册让人把开关改成 true）——与 ADR-0014
 * 「替换人工充值入口」的目标直接冲突，故整条链路移除。开通 VIP 只剩两条真实来源：
 * 支付宝 notify/查单结算（`/api/subscriptions/*`）与 admin 后台赠送（`admin.service`）。
 */
