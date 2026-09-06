import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

/**
 * 统一错误处理中间件：
 * - AppError（service 层抛出的业务错误）→ 对应 status + { error, code, ...details }
 * - 其他未知错误 → console.error + 500
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.details || {}) });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: '服务器内部错误，请稍后重试' });
}
