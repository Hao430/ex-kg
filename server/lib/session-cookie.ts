import type { CookieOptions, Request, Response } from 'express';

/**
 * 会话 cookie 的唯一出处（技术债 #0013，ADR-0020）。
 *
 * 为什么单独成模块：会话 cookie 的属性（`HttpOnly` / `SameSite=Lax` / `Secure` / 无 `Domain`）
 * 此前是**隐式防线**——散在 `routes/auth.ts` 的登录与三处登出、以及 `middleware/auth.ts`
 * 的冻结账号分支里，各写各的 `{ path: '/' }`。谁把登录那处的 `sameSite` 改成 `'none'`，
 * 不会有任何东西变红。收敛到这里之后，属性是单一事实源，`tests/cookie-attributes.test.ts`
 * 再把它们锁成会变红的显式契约。
 *
 * 不变量：
 * - `HttpOnly`：JS 读不到会话令牌（XSS 无法直接窃取会话）；
 * - `SameSite=Lax`：跨站子请求不带 cookie，是最基础的 CSRF 防线（与 `same-origin.ts` 互补）；
 * - 不设 `Domain`：host-only cookie，不向父域泄漏；
 * - `Secure` **仅生产**——本地开发与测试走 http，恒 Secure 会让 cookie 根本发不出去。
 */

export const SESSION_COOKIE_NAME = 'session_token';

/** 会话有效期 7 天（与 `sessions.expires_at` 的服务端口径一致） */
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * 属性在**调用时**求值：`dotenv.config()` 在 `server.ts` 里晚于所有 import 执行，
 * 模块级常量读 `process.env.NODE_ENV` 会恒为 undefined（见 CODEBUDDY「dotenv 时序坑」）。
 */
function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

/** 下发会话 cookie（登录 / 注册 / 重置密码后自动登录） */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, { ...sessionCookieOptions(), maxAge: SESSION_MAX_AGE_MS });
}

/**
 * 清除会话 cookie。属性必须与下发时**逐项一致**（除 `maxAge`）——`res.clearCookie` 默认
 * 只带它收到的 options，漏掉哪项就等于下发了一个属性不同的 cookie，浏览器按
 * (name, domain, path) 删除仍然有效，但响应头本身会失去同款保护，也让「属性唯一事实源」失守。
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
}

/** 从 Cookie 或 `Authorization: Bearer` 头提取会话令牌 */
export function extractSessionToken(req: Request): string | null {
  const fromCookie = req.cookies?.[SESSION_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}
