import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, publicShareReadLimiter, mySharesReadRateLimiter } from '../middleware/auth.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { resolveRequestOrigin } from '../lib/origin.js';
import { getShareView, listMyShares } from '../services/share.service.js';
import { runWithSystem } from '../core/db-context.js';

export const sharesRouter = Router();

/**
 * GET /api/shares（「我的分享」2026-09-09）
 * 列出当前登录用户生效中的分享（未撤销 + 画布未软删），含浏览次数。
 * 无入参（无注入面）；admin 同样只看自己的；列表读取不递增浏览计数。
 */
sharesRouter.get(
  '/',
  authMiddleware,
  mySharesReadRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const appUrl = resolveRequestOrigin(req);
    const result = await listMyShares(req.user!, appUrl);
    res.json(result);
  })
);

/**
 * GET /api/shares/:shareCode（Spec K1 / B1）
 * 公开读取分享快照——无需登录；无效（不存在/已撤销/画布已删）统一 404 不泄露原因。
 * shareCode 为 base64url 随机串（12 字符），不可枚举；另有独立公开限流防扫描。
 */
const ShareCodeSchema = z.object({
  shareCode: z
    .string()
    .min(8, '分享码格式错误')
    .max(64, '分享码格式错误')
    .regex(/^[A-Za-z0-9_-]+$/, '分享码格式错误'),
});

// countViews=0：克隆钩子等非浏览场景读取快照时不递增浏览计数（防统计虚高）
const ShareQuerySchema = z.object({
  countViews: z.string().optional(),
});

sharesRouter.get(
  '/:shareCode',
  publicShareReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { shareCode } = validate(ShareCodeSchema, req.params);
    const { countViews } = validate(ShareQuerySchema, req.query);
    // 公开只读分享：无登录态，按 shareCode（不可枚举随机串）跨租户寻址，读的是快照
    const view = await runWithSystem('shares: 公开分享按 shareCode 读快照（无登录态）', () =>
      getShareView(shareCode, countViews !== '0')
    );
    res.json(view);
  })
);
