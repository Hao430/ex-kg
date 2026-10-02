import type { NextFunction, Request, Response } from 'express';
import { assertCanInfer } from '../services/quota.service.js';
import { getAiModelConfig } from '../services/ai.service.js';
import { getCanvasOwnerInfo, isSharedDefaultCanvas } from '../repositories/canvas.repository.js';
import { ForbiddenError } from '../lib/errors.js';
import { QuotaPolicy } from '../policies/quota.policy.js';
import { AccessPolicy } from '../policies/access.policy.js';

/**
 * AI 推理配额与准入中间件（Spec B1/B2 + E4）：
 * - 未验证邮箱 → 403 EMAIL_NOT_VERIFIED（委托 QuotaPolicy）
 * - 声明的 canvasId 若已存在且非本人画板（共享默认板除外）→ 404 NOT_FOUND（委托 AccessPolicy）
 * - E4 模型白名单：体验版请求 vip_only_models 命中模型 → 403 MODEL_VIP_ONLY（委托 QuotaPolicy）
 * - VIP 过期 → 403 VIP_EXPIRED（禁推理）
 * - 体验版目标画布 chat 节点 ≥ 10 → 403 NODE_LIMIT_REACHED
 * - VIP 有效 / Admin → 放行
 */
export async function chatQuotaMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = req.user;
  if (!user) return next(new ForbiddenError('未登录', 'UNAUTHORIZED'));

  const canvasId = typeof req.body?.canvasId === 'string' ? req.body.canvasId : undefined;
  try {
    // Spec D3：未验证邮箱禁推理（admin 豁免；VIP 同受限于注册验证）
    QuotaPolicy.assertCanInferWithEmail(user);

    // 归属校验：已存在的他人画板不可作为推理归因目标（防审计归因污染 + 配额口径串画布，ADR-0016）
    if (canvasId && canvasId.trim()) {
      const info = await getCanvasOwnerInfo(canvasId);
      AccessPolicy.assertCanvasAttributable(user.id, info, isSharedDefaultCanvas(canvasId));
    }

    // Spec E4：模型白名单校验（独立于 canvasId，先于节点数校验）。
    // 有效模型与 chat.ts 解析一致：请求体 model 缺省时回落到系统配置的 gemini_model
    const ent = QuotaPolicy.calculateEntitlements(user);
    if (ent.plan === 'trial') {
      const config = await getAiModelConfig();
      const requested = typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim()
        : config.gemini_model || '';
      QuotaPolicy.assertCanUseModel(ent, requested, config.vip_only_models);
    }

    await assertCanInfer(user, canvasId);
    next();
  } catch (e) {
    next(e);
  }
}
