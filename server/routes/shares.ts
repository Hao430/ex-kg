import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { publicShareReadLimiter } from '../middleware/auth.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { getShareView } from '../services/share.service.js';

export const sharesRouter = Router();

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

sharesRouter.get(
  '/:shareCode',
  publicShareReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { shareCode } = validate(ShareCodeSchema, req.params);
    const view = await getShareView(shareCode);
    res.json(view);
  })
);
