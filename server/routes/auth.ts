import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  findUserByEmail,
  findUserById,
  findSessionByToken,
  createUser,
  createSession,
  deleteSession,
  recordFailedLogin,
  resetFailedLogin,
  adjustUserCredits,
  subscribeUserPlan,
  updateUserProfile,
  createFeedback,
} from '../db.js';
import { hashPassword, verifyPassword, generateSessionToken, isAccountLocked, getRemainingLockMinutes } from '../auth.js';
import { authMiddleware, loginRateLimiter } from '../middlewares.js';

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

const RechargeSchema = z.object({
  amount: z.number().int().positive('充值点数必须大于 0'),
});

const SubscribeSchema = z.object({
  plan: z.enum(['weekly', 'monthly', 'yearly']),
});

const UpdateProfileSchema = z.object({
  name: z.string().min(1, '昵称不能为空').max(50, '昵称最长 50 个字符').optional(),
  avatar: z.string().max(500).optional(),
});

const FeedbackSchema = z.object({
  type: z.enum(['suggestion', 'bug', 'ux', 'other']).default('suggestion'),
  rating: z.number().int().min(1).max(5).default(5),
  content: z.string().min(3, '反馈内容至少需要 3 个字符').max(2000, '反馈内容请控制在 2000 字以内'),
  contactInfo: z.string().max(100).optional(),
});

/**
 * Cookie options helper
 */
function setSessionCookie(res: Response, token: string) {
  res.cookie('session_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 3600 * 1000, // 7 days
  });
}

/**
 * POST /api/auth/sign-up
 * Register a new user with 50,000 initial credits & auto session cookie
 */
authRouter.post('/sign-up', async (req: Request, res: Response) => {
  try {
    const parseResult = SignUpSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || '请求参数格式错误',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { email, password, name } = parseResult.data;

    // Check if user already exists
    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({
        error: '该邮箱已被注册，请直接登录',
        code: 'EMAIL_EXISTS',
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    const newUser = await createUser({
      email,
      passwordHash,
      name,
      role: 'user',
      initialCredits: 50000,
    });

    const token = generateSessionToken();
    await createSession({
      userId: newUser.id,
      token,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    setSessionCookie(res, token);

    res.status(201).json({
      success: true,
      message: '注册成功，已获赠 50,000 点新手探索算力！',
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        avatar: newUser.avatar,
        role: newUser.role,
        credits_balance: newUser.credits_balance,
      },
      token,
    });
  } catch (error: any) {
    console.error('Sign-up error:', error);
    res.status(500).json({ error: error?.message || '注册服务异常，请稍后重试' });
  }
});

/**
 * POST /api/auth/sign-in
 * Email/password login with brute-force protection
 */
authRouter.post('/sign-in', loginRateLimiter, async (req: Request, res: Response) => {
  try {
    const parseResult = SignInSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || '请求参数格式错误',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { email, password } = parseResult.data;
    const user = await findUserByEmail(email);

    if (!user) {
      res.status(401).json({
        error: '账号或密码错误',
        code: 'INVALID_CREDENTIALS',
      });
      return;
    }

    // Check account status
    if (!user.is_active) {
      res.status(403).json({
        error: '该账户已被运营管理员冻结，无法登录',
        code: 'ACCOUNT_FROZEN',
      });
      return;
    }

    // Check brute-force lock
    if (isAccountLocked(user.locked_until)) {
      const remainingMinutes = getRemainingLockMinutes(user.locked_until!);
      res.status(423).json({
        error: `连续输错密码达 5 次，账户已被临时锁定。请在 ${remainingMinutes} 分钟后重试`,
        code: 'ACCOUNT_LOCKED',
        remainingMinutes,
      });
      return;
    }

    const isMatch = await verifyPassword(password, user.password_hash);
    if (!isMatch) {
      const { failedAttempts, lockedUntil } = await recordFailedLogin(user.id);
      if (lockedUntil) {
        res.status(423).json({
          error: '连续 5 次输错密码，账号已被锁定 15 分钟',
          code: 'ACCOUNT_LOCKED',
          remainingMinutes: 15,
        });
        return;
      }

      res.status(401).json({
        error: `账号或密码错误（连续输错 5 次将锁定 15 分钟，当前失败 ${failedAttempts} 次）`,
        code: 'INVALID_CREDENTIALS',
        failedAttempts,
      });
      return;
    }

    // Login success: reset attempts
    await resetFailedLogin(user.id);

    const token = generateSessionToken();
    await createSession({
      userId: user.id,
      token,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    setSessionCookie(res, token);

    res.json({
      success: true,
      message: '登录成功',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role,
        credits_balance: user.credits_balance,
        vip_expires_at: user.vip_expires_at,
      },
      token,
    });
  } catch (error: any) {
    console.error('Sign-in error:', error);
    res.status(500).json({ error: error?.message || '登录服务异常' });
  }
});

/**
 * POST /api/auth/guest
 * Instant guest session with initial 50,000 trial credits
 */
authRouter.post('/guest', async (req: Request, res: Response) => {
  try {
    const guestId = `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const guestEmail = `${guestId}@guest.deepdive.ai`;
    const passwordHash = await hashPassword(`guest_pass_${Date.now()}`);

    const guestUser = await createUser({
      email: guestEmail,
      passwordHash,
      name: `探索者 #${guestId.slice(-4).toUpperCase()}`,
      role: 'user',
      initialCredits: 50000,
    });

    const token = generateSessionToken();
    await createSession({
      userId: guestUser.id,
      token,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    setSessionCookie(res, token);

    res.status(201).json({
      success: true,
      message: '已为您创建即时探索会话，赠送 50,000 算力点数！',
      user: {
        id: guestUser.id,
        email: guestUser.email,
        name: guestUser.name,
        avatar: guestUser.avatar,
        role: guestUser.role,
        credits_balance: guestUser.credits_balance,
      },
      token,
    });
  } catch (error: any) {
    console.error('Guest auth error:', error);
    res.status(500).json({ error: '创建访客会话失败' });
  }
});

/**
 * POST /api/auth/sign-out
 * Clear session and cookie
 */
authRouter.post('/sign-out', async (req: Request, res: Response) => {
  const token = req.cookies?.session_token || req.headers.authorization?.slice(7).trim();
  if (token) {
    await deleteSession(token);
  }
  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true, message: '已安全登出' });
});

/**
 * GET /api/auth/me
 * Get current session user profile
 */
authRouter.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = req.user!;
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      credits_balance: user.credits_balance,
      vip_expires_at: user.vip_expires_at,
      is_active: user.is_active,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
    },
  });
});

/**
 * POST /api/auth/profile
 * Update user nickname & avatar
 */
authRouter.post('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parseResult = UpdateProfileSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || '请求参数格式错误',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { name, avatar } = parseResult.data;
    const user = req.user!;

    const updated = await updateUserProfile({
      userId: user.id,
      name,
      avatar,
    });

    if (!updated) {
      res.status(404).json({ error: '未找到该用户' });
      return;
    }

    res.json({
      success: true,
      message: '个人信息更新成功！',
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        avatar: updated.avatar,
        role: updated.role,
        credits_balance: updated.credits_balance,
        vip_expires_at: updated.vip_expires_at,
        is_active: updated.is_active,
        created_at: updated.created_at,
        last_login_at: updated.last_login_at,
      },
    });
  } catch (error: any) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: error?.message || '更新个人资料失败' });
  }
});

/**
 * POST /api/auth/feedback
 * Submit user feedback & suggestion
 */
authRouter.post('/feedback', async (req: Request, res: Response) => {
  try {
    const parseResult = FeedbackSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || '请填写完整的反馈内容',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { type, rating, content, contactInfo } = parseResult.data;
    
    // Check if token session exists for optional user attachment
    const token = req.cookies?.session_token || req.headers.authorization?.slice(7).trim();
    let userId: string | undefined;
    let userEmail: string | undefined;

    if (token) {
      const sessionData = await findSessionByToken(token);
      if (sessionData) {
        userId = sessionData.user.id;
        userEmail = sessionData.user.email;
      }
    }

    const fb = await createFeedback({
      userId,
      userEmail,
      type,
      rating,
      content,
      contactInfo,
    });

    res.status(201).json({
      success: true,
      message: '感谢您的宝贵建议！我们已收到您的反馈并会认真评估。',
      feedbackId: fb.id,
    });
  } catch (error: any) {
    console.error('Submit feedback error:', error);
    res.status(500).json({ error: error?.message || '提交反馈失败，请稍后重试' });
  }
});

/**
 * POST /api/auth/subscribe
 * Subscribe to weekly / monthly / yearly Pro membership
 */
authRouter.post('/subscribe', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parseResult = SubscribeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: '请选择有效的会员订阅周期', code: 'INVALID_PLAN' });
      return;
    }

    const { plan } = parseResult.data;
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
        credits_balance: updatedUser.credits_balance,
        vip_expires_at: updatedUser.vip_expires_at,
        is_active: updatedUser.is_active,
      },
    });
  } catch (error: any) {
    console.error('Subscription error:', error);
    res.status(500).json({ error: error?.message || '开通会员订阅失败' });
  }
});

/**
 * POST /api/auth/recharge
 * Allow self-service top-up for testing / demo
 */
authRouter.post('/recharge', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parseResult = RechargeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: '请输入有效的充值点数', code: 'INVALID_AMOUNT' });
      return;
    }

    const { amount } = parseResult.data;
    const user = req.user!;

    const { newBalance, transactionId } = await adjustUserCredits({
      userId: user.id,
      amount,
      operatorId: user.id,
      reason: `自主充值: +${amount} 点`,
    });

    res.json({
      success: true,
      message: `成功充值 ${amount} 点 AI 算力！`,
      credits_balance: newBalance,
      transactionId,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '充值失败' });
  }
});
