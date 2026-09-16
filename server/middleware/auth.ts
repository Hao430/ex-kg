import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { findSession } from '../repositories/session.repository.js';
import type { UserRecord, SessionRecord } from '../core/records.js';
import { UnauthorizedError } from '../lib/errors.js';
import { extractSessionToken, clearSessionCookie } from '../lib/session-cookie.js';
import { runWithSystem, runWithUser } from '../core/db-context.js';

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
 * Rate limiter for quota query: 60 req/min per IP（读接口，供前端余量展示轮询，Spec J2）
 */
export const quotaRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '配额查询过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for share create/revoke: 10 req/min per IP（写操作，Spec K1）
 */
export const shareActionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '分享操作过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for my-shares list: 30 req/min per user（读接口，「我的分享」弹窗每次打开拉取一次）
 */
export const mySharesReadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '分享列表查询过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for admin log read endpoints: 30 req/min per user（Spec I，独立实例）
 */
export const adminLogReadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '日志查询过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for folder mutations (Spec L1): 30 req/min per user（独立实例，ADR-0007）
 */
export const folderActionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '分组操作过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for auto-title generation: 20 req/min per user（自动命名非关键路径，防滥用刷 LLM）
 */
export const autoTitleRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '命名请求过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for public share read: 60 req/min per IP（公开端点，防枚举扫描，Spec K1）
 */
export const publicShareReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '访问过于频繁，请稍后再试',
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
 * 重置密码限流（安全审查 L1）。
 *
 * 这是**唯一没有独立限流器的匿名端点**（登录/注册/找回密码都有）：令牌虽是 32 字节随机
 * hex、不可枚举，但每次请求都跑一遍 scrypt（ADR-0010 刻意调到单次 ≥200ms）——
 * 不限流就是一个廉价的 CPU 放大面。按 IP 独立计数，不与 forgot-password 共桶
 * （ADR-0007：一个端点被刷不该拖垮另一个）。
 */
export const resetPasswordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '重置密码请求过于频繁，请稍后重试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for 订单状态轮询（GET /api/subscriptions/orders/:orderNo）：40 req/min per user。
 *
 * 必须与 subscriptionRateLimiter（10/min）**分开实例**：前端 RechargeModal 每 3s 轮一次
 * = 20 req/min，共用同一个 10/min 的桶会在约 27 秒后把轮询打死（弹窗却要等满 5 分钟），
 * 用户付完款看不到「已开通」，且 ADR-0014 的查单兜底（靠这个 GET 触发）也一并失效。
 * 「防刷下单」的额度不该被读端点消耗，读端点也不该挤下单额度。
 *
 * 按用户维度计数并挂在 authMiddleware 之后：同一 NAT 出口的多个用户不再互相挤额度
 * （与 mySharesReadRateLimiter / adminLogReadRateLimiter 同惯例）。
 * 40/min 是稳态 20/min 的 2 倍余量，够多标签页与会话重开。
 */
export const orderStatusReadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '订单状态查询过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for subscription endpoints: 10 req/min per IP（技术债 #0012，防刷"尝试下单"）
 */
export const subscriptionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '订阅操作过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Extract token from Cookie or Bearer header
 */
export function extractToken(req: Request): string | null {
  return extractSessionToken(req);
}

/**
 * 强制登录鉴权中间件（Spec A1：游客模式已删除）：
 * - 有效会话：校验并附着 user/session
 * - 冻结账号：403 ACCOUNT_FROZEN
 * - 未登录 / 会话失效：401 UNAUTHORIZED（前端应跳转登录页）
 */
export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  // 会话查询是**先有鸡还是先有蛋**的那一步：此刻还不知道请求属于哪个用户，
  // 只能按 token 跨租户查 sessions ⋈ users（ADR-0019 的 system 作用域）。
  // 查询与「进入下游」严格分开：next() 会同步进入整条下游链，把它留在 try 里
  // 会让任何下游同步抛错都被当成「会话查询失败」吞掉、再 next() 第二次。
  let authResult: { user: UserRecord; session: SessionRecord } | null = null;
  if (token) {
    try {
      authResult = await runWithSystem('auth: 按 token 跨租户查 sessions ⋈ users', () =>
        findSession(token)
      );
    } catch (error) {
      console.error('Session lookup error:', error);
    }
  }

  if (authResult) {
    const { session, user } = authResult;

    if (!user.is_active) {
      clearSessionCookie(_res);
      _res.status(403).json({
        error: '账号已被系统冻结，请联系运营管理员',
        code: 'ACCOUNT_FROZEN',
      });
      return;
    }

    req.user = user;
    req.session = session;
    // 从这一刻起整条下游调用链都在该用户作用域内：路由 → service → repository
    // 的每条查询都会带上 app.user_id，RLS 生效。
    // ⚠️ 依赖 Express 4 的 next() 是**同步**进入下游（下游 async 函数在同一 ALS
    // 上下文里开始执行），由 tests/pg/db-scope.pg.test.ts 独立锁定。
    runWithUser(user.id, () => next());
    return;
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

/**
 * 微信登录限流器组（ADR-0022）。三个**独立实例**（ADR-0007），互不挤占额度。
 *
 * 这一组端点全部**免 auth**（它们就是登录路径本身），所以计数只能按 IP。
 * 与支付宝 `/notify` 的「免限流」不同：那个是服务器对服务器、验签即鉴权、限流会毁掉
 * 重试风暴的自愈；而这里是**浏览器驱动**、可被廉价刷、唯一鉴权就是 state cookie，
 * 因此 per-IP 限流是真实防线而非摆设。
 */

/** 20 req/min per IP：只做一件事——生成 state 并 302 到微信，防跳转刷量 */
export const wechatAuthorizeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '微信登录请求过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * 30 req/min per IP：回调背后是「外呼微信 ×2 + 可能的建号写库」，是真开销。
 *
 * `handler` 刻意不用默认的 JSON 响应：本端点是**浏览器顶层导航**的落点，
 * 用户看到一坨 JSON 429 会以为网站坏了。改成 302 回前端，由前端给一句人话。
 */
export const wechatCallbackRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  handler: (_req: Request, res: Response) => {
    res.redirect('/?wechat_error=RATE_LIMITED');
  },
});

/** 60 req/min per IP：只回一个布尔值 `{enabled}`，供前端决定是否渲染按钮（兼运维探针） */
export const wechatStatusRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anonymous'),
  message: {
    error: '请求过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * 补绑邮箱（ADR-0023）的两个限流器。都是 **per-user**，因此必须挂在 `authMiddleware` **之后**
 * （先例 `resendVerificationRateLimiter`）：同一 NAT 出口的多个用户不该互相挤额度。
 */

/** 5 req/hour per user：每次都会真发一封信，按邮费口径收紧 */
export const bindEmailSendCodeRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '验证码发送过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/** 10 req/hour per user：挡住 6 位码的提交刷量（连错 5 次作废是第二道，见 consumeCode） */
export const bindEmailRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '操作过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * 30 req/min per user：运营台的**写**操作（当前唯一消费方是解除第三方绑定）。
 * 与 `adminLogReadRateLimiter` 分开实例（ADR-0007）——读日志的额度不该被写操作占用，反之亦然。
 */
export const adminUserWriteRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip || 'anonymous')),
  message: {
    error: '操作过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});
