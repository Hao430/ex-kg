import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { findSession, UserRecord, SessionRecord } from './db.js';

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
 * Required authentication middleware
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      error: '请先登录后继续访问',
      code: 'UNAUTHORIZED',
    });
    return;
  }

  try {
    const result = await findSession(token);
    if (!result) {
      res.clearCookie('session_token', { path: '/' });
      res.status(401).json({
        error: '登录凭证已失效，请重新登录',
        code: 'SESSION_EXPIRED',
      });
      return;
    }

    const { session, user } = result;

    if (!user.is_active) {
      res.clearCookie('session_token', { path: '/' });
      res.status(403).json({
        error: '账号已被系统冻结，请联系运营管理员',
        code: 'ACCOUNT_FROZEN',
      });
      return;
    }

    req.user = user;
    req.session = session;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: '认证服务异常' });
  }
}

/**
 * Optional authentication middleware: attaches user if token is present
 */
export async function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const result = await findSession(token);
    if (result && result.user.is_active) {
      req.user = result.user;
      req.session = result.session;
    }
  } catch (e) {
    // ignore
  }
  next();
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
 * AI Quota pre-check: credits_balance >= 100 points
 */
export function quotaMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
    return;
  }

  const balance = Number(req.user.credits_balance);
  if (balance < 100) {
    res.status(402).json({
      error: 'AI 算力点数不足（当前余额为 0 点），请充值后再继续提问',
      code: 'INSUFFICIENT_CREDITS',
      balance,
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
      error: `提问内容超出 4,000 字符限制 (当前为 ${lastContent.length} 字符)`,
      code: 'QUESTION_TOO_LONG',
    });
    return;
  }

  // 2. Total context length check
  const totalChars = messages.reduce((acc: number, m: any) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
  if (totalChars > 16000) {
    res.status(400).json({
      error: `历史上下文超出 16,000 字符限制 (当前为 ${totalChars} 字符)`,
      code: 'CONTEXT_TOO_LONG',
    });
    return;
  }

  next();
}

/**
 * Dynamic rate limiter per role:
 * user: 10/min, vip: 30/min, admin: 100/min
 */
const rateLimitBuckets = new Map<string, { count: number; resetTime: number }>();

export function roleBasedRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.id || req.ip || 'anonymous';
  const role = req.user?.role || 'user';
  const limit = role === 'admin' ? 100 : role === 'vip' ? 30 : 10;
  const now = Date.now();

  let bucket = rateLimitBuckets.get(userId);
  if (!bucket || now > bucket.resetTime) {
    bucket = { count: 1, resetTime: now + 60 * 1000 };
    rateLimitBuckets.set(userId, bucket);
  } else {
    bucket.count++;
  }

  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - bucket.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetTime / 1000));

  if (bucket.count > limit) {
    res.status(429).json({
      error: `请求频率超出限制（当前角色配额为每分钟 ${limit} 次），请稍后重试`,
      code: 'RATE_LIMIT_EXCEEDED',
    });
    return;
  }

  next();
}
