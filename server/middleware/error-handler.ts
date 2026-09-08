import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { recordEventLog } from '../repositories/event-log.repository.js';

/**
 * Spec I：业务错误埋点白名单（code → event_logs category）。
 * 错误类事件在 errorHandler 集中埋点，单点覆盖 repository 抛错 + middleware 拒绝全路径，
 * 零业务侵入；成功类事件（画布删除/分享等）已走 user_audit_logs，此处不双写。
 */
const OBSERVABILITY_EVENT_CODES: Record<string, string> = {
  CANVAS_SAVE_CONFLICT: 'canvas',
  CANVAS_FORBIDDEN: 'canvas',
  BOARD_LIMIT_REACHED: 'quota',
  NODE_LIMIT_REACHED: 'quota',
  EMAIL_NOT_VERIFIED: 'auth',
  MODEL_VIP_ONLY: 'quota',
  VIP_EXPIRED: 'quota',
  MODEL_NOT_CONFIGURED: 'chat',
};

/**
 * 统一错误处理中间件：
 * - AppError（service 层抛出的业务错误）→ 对应 status + { error, code, ...details }
 * - 其他未知错误 → console.error + 500
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    // Spec I：白名单内错误异步落 event_logs（recordEventLog 内部吞异常，绝不改变错误响应）
    const category = OBSERVABILITY_EVENT_CODES[err.code || ''];
    if (category) {
      // 注意：Express 4 错误传播到应用级错误中间件时 req.params 已被重置为 {}，
      // 画布 id 需从 body/query（chat、quota 链路）或 originalUrl（canvas 路由）提取
      const canvasPathMatch =
        typeof req.originalUrl === 'string' ? req.originalUrl.match(/\/api\/canvases\/([^/?]+)/) : null;
      const entityId =
        (typeof req.body?.canvasId === 'string' && req.body.canvasId) ||
        (typeof req.query?.canvasId === 'string' && req.query.canvasId) ||
        (canvasPathMatch ? decodeURIComponent(canvasPathMatch[1]) : null);
      void recordEventLog({
        category,
        event: err.code.toLowerCase(),
        entityType: entityId ? 'canvas' : null,
        entityId,
        userId: req.user?.id || null,
        ip: req.ip || null,
        details: { method: req.method, path: req.originalUrl },
      });
    }
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.details || {}) });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: '服务器内部错误，请稍后重试' });
}
