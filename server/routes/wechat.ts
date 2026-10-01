import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { AppError } from '../lib/errors.js';
import { resolveOrigin } from '../lib/seo.js';
import {
  setSessionCookie,
  setWechatStateCookie,
  clearWechatStateCookie,
  readWechatStateCookie,
  extractSessionToken,
} from '../lib/session-cookie.js';
import {
  wechatAuthorizeRateLimiter,
  wechatCallbackRateLimiter,
  wechatStatusRateLimiter,
} from '../middleware/auth.js';
import {
  isWechatConfigured,
  buildAuthorizeUrl,
  WechatAuthError,
} from '../services/wechat-provider.js';
import {
  loginWithWechat,
  resolveSessionUser,
  bindWechatAccount,
  recordWechatBindFailure,
  recordWechatLoginFailure,
} from '../services/wechat.service.js';

/**
 * 网站应用微信登录（ADR-0022）。挂在 `/api/auth/wechat`（见 `server/app.ts`）。
 *
 * 三个端点都是 **GET**，且都**免 auth**——它们就是登录路径本身。
 *
 * ⚠️ `GET /callback` 会**改状态**（建账号、下发会话），而 `same-origin.ts` 的
 * `MUTATING_METHODS` 刻意只含 POST/PUT/PATCH/DELETE。这不是漏网：微信的回调必须是
 * 浏览器顶层 GET 导航（`open.weixin.qq.com` 只支持 302 回跳），而它的 CSRF 防护是
 * **state 双提交 cookie**（见 `session-cookie.ts` 的 `setWechatStateCookie`）。
 * 按 ADR-0020 已登记「改状态的 GET」处理，本端点记为其第三例。
 */

export const wechatRouter = Router();

const CALLBACK_PATH = '/api/auth/wechat/callback';

/** 回跳目标一律硬编码，**不接受任何用户提供的 returnUrl**（开放重定向面为零） */
const OK_REDIRECT = '/?wechat=ok';
/** ADR-0023：绑定成功的回跳。与登录区分开，前端据此给不同提示 */
const BOUND_REDIRECT = '/?wechat=bound';

function errorRedirect(code: string): string {
  return `/?wechat_error=${encodeURIComponent(code)}`;
}

/**
 * 绑定失败走**独立通道**，不能挤进 `wechat_error`：后者在前端会打开「登录」弹窗
 * （`AuthContext` 的参数消费 effect），对一次绑定操作弹出登录框是错的引导。
 */
function bindErrorRedirect(code: string): string {
  return `/?wechat_bind_error=${encodeURIComponent(code)}`;
}

/** 恒定时间比较（长度先判，`timingSafeEqual` 对不等长会抛） */
function stateMatches(cookieState: string | null, queryState: unknown): boolean {
  if (!cookieState || typeof queryState !== 'string' || !queryState) return false;
  const a = Buffer.from(cookieState);
  const b = Buffer.from(queryState);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET /api/auth/wechat/authorize
 * 种一次性 state cookie 并 302 到微信扫码页（scope=snsapi_login）。
 * 未配置凭据时不外呼，直接回 NOT_CONFIGURED，前端据此不展示按钮。
 *
 * 同一个入口同时服务登录（无会话）与绑定（有会话）——见 `resolveSessionUser`。
 */
wechatRouter.get('/authorize', wechatAuthorizeRateLimiter, (req: Request, res: Response) => {
  if (!isWechatConfigured()) {
    res.redirect(errorRedirect('NOT_CONFIGURED'));
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  setWechatStateCookie(res, state);

  // 回调地址由 APP_URL（经 resolveOrigin 校验合法性）推导，不单设 REDIRECT_URI 变量：
  // 少一个变量 = 少一次「错一个字母静默失效」。须与开放平台后台的「授权回调域」一致。
  res.redirect(buildAuthorizeUrl(state, `${resolveOrigin(req)}${CALLBACK_PATH}`));
});

/**
 * 判定「这次回调是登录还是绑定」：**带有效会话 = 绑定意图**（ADR-0023）。
 *
 * 为什么用会话、而不是一个显式的意图参数：个人中心的「绑定微信」与登录弹窗里的
 * 「微信扫码登录」是**同一个** `/authorize` 跳转，而登录弹窗只在未登录时可达
 * ——「有没有会话」正好等价于用户的心智，不需要额外状态。
 *
 * 它同时堵掉一个隐患：已登录的浏览器经书签/旧标签页直接访问 `/authorize` 时，
 * 原先会静默建出第二个账号并**覆盖会话 cookie**（用户在自己没察觉的情况下换了账号）。
 *
 * 三种「没有有效会话」的情形一律回落登录（原逻辑）：
 * - 根本没带 cookie（未登录，登录正是用户想要的）；
 * - cookie 已失效（过期/已注销）——本产品里「会话失效」就等于「已登出」，
 *   此时点微信登录的语义就是登录，报错只会无谓拦住一个已经登出的用户；
 * - 账号被冻结（交给 `loginWithWechat` 抛 ACCOUNT_FROZEN，走统一错误通道）。
 */
/**
 * GET /api/auth/wechat/callback
 * 微信回跳落点：校验 state → （有会话 ? 绑定 : 登录）→ 302 回主应用。
 *
 * 顺序是安全契约的一部分：state 不匹配时**必须在任何外呼之前 return**，
 * 否则一个跨站诱导的回调就能消耗掉我们的微信调用额度。
 */
wechatRouter.get(
  '/callback',
  wechatCallbackRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const cookieState = readWechatStateCookie(req);
    // state 一次性：进门就作废，避免重放
    clearWechatStateCookie(res);

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!stateMatches(cookieState, req.query.state) || !code) {
      res.redirect(errorRedirect('STATE'));
      return;
    }

    const sessionUser = await resolveSessionUser(extractSessionToken(req));
    const userAgent = req.headers['user-agent'];

    if (sessionUser) {
      try {
        const bindResult = await bindWechatAccount({
          code,
          sessionUserId: sessionUser.id,
          ip: req.ip,
          userAgent,
        });
        if (!bindResult.success) {
          res.redirect(bindErrorRedirect(bindResult.errorCode || 'WECHAT_ALREADY_BOUND'));
          return;
        }
        res.redirect(BOUND_REDIRECT);
      } catch (error: any) {
        const reason =
          error instanceof WechatAuthError
            ? 'EXCHANGE'
            : error instanceof AppError
              ? error.code
              : 'SERVER';
        await recordWechatBindFailure({
          userId: sessionUser.id,
          reason,
          errcode: error?.errcode ?? null,
          ip: req.ip,
          userAgent,
        });
        console.warn('[wechat] 绑定失败:', reason, error?.errcode ?? (error?.message || ''));
        res.redirect(bindErrorRedirect(reason));
      }
      return;
    }

    try {
      const { token } = await loginWithWechat({ code, ip: req.ip, userAgent });
      setSessionCookie(res, token);
      res.redirect(OK_REDIRECT);
    } catch (error: any) {
      // 只回一个可枚举的原因码，**绝不透出微信原始 errmsg**（可能含 appid 等细节）
      const reason =
        error instanceof WechatAuthError
          ? 'EXCHANGE'
          : error instanceof AppError
            ? error.code
            : 'SERVER';

      await recordWechatLoginFailure({
        reason,
        errcode: error?.errcode ?? null,
        ip: req.ip,
        userAgent,
      });
      console.warn('[wechat] 回调失败:', reason, error?.errcode ?? (error?.message || ''));

      res.redirect(errorRedirect(reason));
    }
  })
);

/**
 * GET /api/auth/wechat/status
 * 只回一个布尔值：前端据此决定是否渲染「微信扫码登录」按钮。兼作运维探针
 * （`curl` 一下即可确认线上凭据是否已生效，不必真走一遍扫码）。
 */
wechatRouter.get('/status', wechatStatusRateLimiter, (_req: Request, res: Response) => {
  res.json({ enabled: isWechatConfigured() });
});
