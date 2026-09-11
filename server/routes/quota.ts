import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, quotaRateLimiter } from '../middleware/auth.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { effectiveEntitlements, NODE_LIMIT, BOARD_LIMIT } from '../services/quota.service.js';
import { countCanvasNodes, getCanvasOwnerInfo } from '../repositories/canvas.repository.js';
import { listCanvases } from '../repositories/canvas.repository.js';
import { getAiModelConfig } from '../services/ai.service.js';

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
 *     vipOnlyModelCount: number,                      // VIP 专享模型数（Spec K7/D3，未配置为 0）
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

    const canvases = await listCanvases(user.id);
    const board = { used: canvases.length, limit: boardLimit };

    // Spec K7（D3）：VIP 专享模型数量（与 chatQuotaMiddleware 同源的配置读取），
    // 前端升级弹窗据此展示「专享模型」权益行；未配置时为 0，前端隐藏该行不展示空气权益。
    const aiConfig = await getAiModelConfig();
    const vipOnlyModelCount = (aiConfig.vip_only_models || []).filter(
      (m) => typeof m === 'string' && m.trim()
    ).length;

    let node: { used: number; limit: number | null; remaining: number | null } | null = null;
    if (canvasId) {
      const info = await getCanvasOwnerInfo(canvasId);
      if (info.exists && info.ownerId !== user.id) {
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
      vipOnlyModelCount,
    });
  })
);
