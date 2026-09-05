import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  findUserByEmail,
  createUser,
  createSession,
  deleteSession,
  recordFailedLogin,
  resetFailedLogin,
  adjustUserCredits,
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
        role: user.role,
        credits_balance: user.credits_balance,
      },
      token,
    });
  } catch (error: any) {
    console.error('Sign-in error:', error);
    res.status(500).json({ error: error?.message || '登录服务异常' });
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
      role: user.role,
      credits_balance: user.credits_balance,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
    },
  });
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
