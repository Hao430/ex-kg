import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { findSession } from '../repositories/session.repository.js';
import type { UserRecord, SessionRecord } from '../core/records.js';
import { UnauthorizedError } from '../lib/errors.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: UserRecord;
      session?: SessionRecord;
    }
  }
}

/**
 * Rate limiter for login / sign-in: 15 req/min per IP
 */
export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '登录尝试过于频繁，请在 1 分钟后重试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for resend-verification: 3 req/10min per user（防邮件轰炸，Spec D3 审计）
 */
export const resendVerificationRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '验证邮件发送过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for sign-up: 5 req/hour per IP（Spec D1，防批量注册刷取体验额度）
 */
export const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '注册过于频繁，请 1 小时后重试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for send-register-code: 5 req/hour per IP（注册验证码防邮件轰炸）
 */
export const sendRegisterCodeRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '验证码发送过于频繁，请 1 小时后重试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for forgot-password: 5 req/hour per IP（Spec F1，独立实例防邮件轰炸）
 */
export const forgotPasswordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '找回密码请求过于频繁，请 1 小时后重试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Extract token from Cookie or Bearer header
 */
export function extractToken(req: Request): string | null {
  if (req.cookies?.session_token) {
    return req.cookies.session_token;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

/**
 * 强制登录鉴权中间件（Spec A1：游客模式已删除）：
 * - 有效会话：校验并附着 user/session
 * - 冻结账号：403 ACCOUNT_FROZEN
 * - 未登录 / 会话失效：401 UNAUTHORIZED（前端应跳转登录页）
 */
export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  if (token) {
    try {
      const result = await findSession(token);
      if (result) {
        const { session, user } = result;

        if (!user.is_active) {
          _res.clearCookie('session_token', { path: '/' });
          _res.status(403).json({
            error: '账号已被系统冻结，请联系运营管理员',
            code: 'ACCOUNT_FROZEN',
          });
          return;
        }

        req.user = user;
        req.session = session;
        next();
        return;
      }
    } catch (error) {
      console.error('Session lookup error:', error);
    }
  }

  next(new UnauthorizedError());
}

/**
 * Require admin role
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({
      error: '越权访问：该接口仅限系统管理员访问',
      code: 'FORBIDDEN_ADMIN_ONLY',
    });
    return;
  }
  next();
}

/**
 * Input limits validator for malicious payload defense
 * - Single question <= 4,000 characters
 * - Total context history <= 16,000 characters
 */
export function validateInputLimits(req: Request, res: Response, next: NextFunction): void {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: '提问消息列表不能为空', code: 'INVALID_PAYLOAD' });
    return;
  }

  const lastMessage = messages[messages.length - 1];
  const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';

  // 1. Single question length check
  if (lastContent.length > 4000) {
    res.status(400).json({
      error: `单次提问内容过长（当前 ${lastContent.length} 字符，上限 4,000 字符）`,
      code: 'PROMPT_TOO_LONG',
    });
    return;
  }

  // 2. Total context history length check
  const totalLength = messages.reduce((acc, msg) => acc + (typeof msg.content === 'string' ? msg.content.length : 0), 0);
  if (totalLength > 16000) {
    res.status(400).json({
      error: `对话历史上下文过长（当前 ${totalLength} 字符，上限 16,000 字符）`,
      code: 'CONTEXT_TOO_LONG',
    });
    return;
  }

  next();
}

/**
 * Dynamic role-based rate limiter
 * - Admin: 120 req/min
 * - VIP: 60 req/min
 * - Normal user / guest: 25 req/min
 */
export const roleBasedRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req: Request) => {
    const role = req.user?.role;
    if (role === 'admin') return 120;
    if (role === 'vip') return 60;
    return 25;
  },
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const role = req.user?.role || 'user';
    const limit = role === 'admin' ? 120 : role === 'vip' ? 60 : 25;
    res.status(429).json({
      error: `请求过于频繁，当前每分钟上限为 ${limit} 次，请稍候再试`,
      code: 'RATE_LIMIT_EXCEEDED',
      role,
      limit,
    });
  },
});
