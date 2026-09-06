import type { NextFunction, Request, Response } from 'express';
import { assertCanInfer, effectiveEntitlements } from '../services/quota.service.js';
import { getAiModelConfig } from '../services/ai.service.js';
import { ForbiddenError } from '../lib/errors.js';

/**
 * AI 推理配额中间件（Spec B1/B2 + E4）：
 * - VIP 过期 → 403 VIP_EXPIRED（禁推理）
 * - 体验版目标画布 chat 节点 ≥ 10 → 403 NODE_LIMIT_REACHED
 * - E4 模型白名单：体验版/过期 VIP 请求 vip_only_models 命中模型 → 403 MODEL_VIP_ONLY
 *   （校验独立于 canvasId，无画布上下文的自由提问同样受限；VIP/Admin 不限）
 * - VIP 有效 / Admin → 放行
 */
export async function chatQuotaMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = req.user;
  if (!user) return next(new ForbiddenError('未登录', 'UNAUTHORIZED'));

  const canvasId = typeof req.body?.canvasId === 'string' ? req.body.canvasId : undefined;
  try {
    // Spec E4：模型白名单校验（独立于 canvasId，先于节点数校验）。
    // 有效模型与 chat.ts 解析一致：请求体 model 缺省时回落到系统配置的 gemini_model，
    // 默认模型在白名单内同样拦截（审计修复：默认模型绕过）。
    const ent = effectiveEntitlements(user);
    if (ent.plan === 'trial') {
      const config = await getAiModelConfig();
      const whitelist = (config.vip_only_models || []).map((m) => m.trim().toLowerCase());
      if (whitelist.length > 0) {
        const requested = typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim().toLowerCase()
          : (config.gemini_model || '').trim().toLowerCase();
        if (requested && whitelist.includes(requested)) {
          return next(
            new ForbiddenError('该模型为 VIP 专享，请升级会员后使用', 'MODEL_VIP_ONLY')
          );
        }
      }
    }

    await assertCanInfer(user, canvasId);
    next();
  } catch (e) {
    next(e);
  }
}
