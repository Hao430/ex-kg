import type { NextFunction, Request, Response } from 'express';
import { assertCanInfer } from '../services/quota.service.js';
import { ForbiddenError } from '../lib/errors.js';

/**
 * AI 推理配额中间件（Spec B1/B2，替换旧版 quotaMiddleware）：
 * - VIP 过期 → 403 VIP_EXPIRED（禁推理）
 * - 体验版目标画布 chat 节点 ≥ 10 → 403 NODE_LIMIT_REACHED
 * - VIP 有效 / Admin → 放行
 */
export async function chatQuotaMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = req.user;
  if (!user) return next(new ForbiddenError('未登录', 'UNAUTHORIZED'));

  const canvasId = typeof req.body?.canvasId === 'string' ? req.body.canvasId : undefined;
  try {
    await assertCanInfer(user, canvasId);
    next();
  } catch (e) {
    next(e);
  }
}
