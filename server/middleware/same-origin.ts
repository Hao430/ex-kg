import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../lib/errors.js';

/**
 * 变更方法同源守卫（技术债 #0013，ADR-0020）。
 *
 * 背景：会话 cookie 是 `httpOnly + sameSite:'lax'`，本身已挡住绝大多数跨站表单提交；
 * 但整条 CSRF 防线此前是**隐式**的——没有任何测试锁住 cookie 属性，谁把它改成
 * `sameSite:'none'` 也不会有东西变红。本中间件把「变更请求必须同源」变成显式契约。
 *
 * 判据（全部只在变更方法上生效）：
 * 1. `Sec-Fetch-Site: cross-site` → 403。这是浏览器给出的最强信号：只要它说跨站，
 *    无论 Origin 是否被裁剪都拒。
 * 2. 带了 `Origin`（或可从 `Referer` 推导出 origin）且不属于本服务的已知 origin → 403。
 * 3. **不带 `Origin` 一律放行**——这是刻意的：curl、服务端到服务端调用、支付宝异步
 *    通知回调、以及全部既有测试都不带 Origin；而浏览器对跨站变更请求**必带** Origin，
 *    因此放行「无 Origin」不会放松浏览器侧的防线。
 *
 * 已知边界：`Origin` 与 `Sec-Fetch-*` 都是浏览器自愿提供的请求头，非浏览器客户端可以
 * 任意伪造——本守卫防的是**用户浏览器被第三方页面驱动**（CSRF），不是防伪造客户端。
 * 后者的边界仍是鉴权（会话 cookie / 分享码 / 支付宝验签）。
 */

/** 仅这些方法会改变状态，才需要同源校验（GET/HEAD/OPTIONS 不经过本守卫） */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 从 Referer 推导 origin；非法/缺失一律返回 null（当作「无 Origin」处理） */
function originFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * 本服务可接受的 origin 集合（运行期读取，见 CODEBUDDY「dotenv 时序坑」）：
 * - `APP_URL` 的 origin（生产经反代时对外真实地址）；
 * - `req.protocol://req.get('host')`（请求自身看到的地址，覆盖未配 APP_URL 的部署与测试）。
 * 两者都不合法时集合为空 → 带 Origin 的请求一律 403（失败关闭，不静默放行）。
 */
function allowedOrigins(req: Request): Set<string> {
  const origins = new Set<string>();

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // 配置非法（缺协议头等）时忽略：日志无法在此安全记录请求体，交由部署前校验兜底
    }
  }

  const host = req.get('host');
  if (host) origins.add(`${req.protocol}://${host}`);

  return origins;
}

export function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  if (req.get('sec-fetch-site') === 'cross-site') {
    next(new ForbiddenError('请求来源校验未通过', 'CSRF_ORIGIN_REJECTED'));
    return;
  }

  const origin = req.get('origin') || originFromReferer(req.get('referer'));
  if (!origin) {
    // 非浏览器客户端（见文件头「判据 3」）
    next();
    return;
  }

  if (!allowedOrigins(req).has(origin)) {
    next(new ForbiddenError('请求来源校验未通过', 'CSRF_ORIGIN_REJECTED'));
    return;
  }

  next();
}
