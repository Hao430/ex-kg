import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, quotaRateLimiter } from '../middleware/auth.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { effectiveEntitlements, NODE_LIMIT, BOARD_LIMIT } from '../services/quota.service.js';
import { countCanvasNodes, getCanvasOwnerInfo } from '../repositories/canvas.repository.js';
import { listCanvases } from '../repositories/canvas.repository.js';

export const quotaRouter = Router();

/**
 * Spec J2（跟踪清单 D2）：配额余量 API——服务端单一事实源。
 * 返回与 chatQuotaMiddleware / assertCanCreateBoard 完全同口径的余量数据，
 * 前端删除本地预检只做展示；后端保持唯一裁判。
 *
 * GET /api/quota?canvasId=xxx（canvasId 可选）
 * → {
 *     plan: 'trial' | 'vip' | 'admin',
 *     vipExpired: boolean,
 *     board: { used, limit: number | null },          // limit null = 不受限
 *     node:  { used, limit: number | null, remaining: number | null } | null,
 *   }
 * node 仅在携带 canvasId 时返回；计数为已保存画布的 chat 节点全量（含 suggested 占位）。
 * 归属校验：canvasId 存在但不属于当前用户 → 404（严格属主制，不泄露存在性）。
 */
const QuotaQuerySchema = z.object({
  canvasId: z.string().min(1, 'canvasId 不能为空').optional(),
});

quotaRouter.get(
  '/',
  authMiddleware,
  quotaRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const ent = effectiveEntitlements(user);
    const { canvasId } = validate(QuotaQuerySchema, req.query);

    const unlimited = ent.plan === 'admin' || ent.plan === 'vip';
    const boardLimit = unlimited ? null : ent.boardLimit ?? BOARD_LIMIT;
    const nodeLimit = unlimited ? null : ent.nodeLimit ?? NODE_LIMIT;

    const canvases = await listCanvases(user.id, user.role === 'admin');
    const board = { used: canvases.length, limit: boardLimit };

    let node: { used: number; limit: number | null; remaining: number | null } | null = null;
    if (canvasId) {
      const info = await getCanvasOwnerInfo(canvasId);
      if (info.exists && info.ownerId !== user.id && user.role !== 'admin') {
        return res.status(404).json({ error: '画布不存在', code: 'NOT_FOUND' });
      }
      const used = info.exists ? await countCanvasNodes(canvasId) : 0;
      node = {
        used,
        limit: nodeLimit,
        remaining: nodeLimit === null ? null : Math.max(0, nodeLimit - used),
      };
    }

    res.json({
      plan: ent.plan,
      vipExpired: ent.vipExpired,
      vipGraceDaysRemaining: ent.vipGraceDaysRemaining ?? null,
      board,
      node,
    });
  })
);
