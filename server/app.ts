import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { canvasesRouter } from './routes/canvases.js';
import { chatRouter } from './routes/chat.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { quotaRouter } from './routes/quota.js';
import { sharesRouter } from './routes/shares.js';
import { foldersRouter } from './routes/folders.js';
import { errorHandler } from './middleware/error-handler.js';
import { checkDbStatus } from './core/db-status.js';

/**
 * Express 应用工厂：中间件、健康检查与 API 路由挂载。
 * 监听与静态资源/Vite 中间件由 server.ts 负责，便于测试中独立实例化。
 */
export function createApp(): express.Express {
  const app = express();

  // Trust proxy（技术债 #0010）：仅信任回环/私网段代理跳数。
  // 反代/CDN 后限流器按 X-Forwarded-For 末端可信跳取真实 IP；
  // 若前端挂公网 CDN，需在此显式枚举 CDN 出口 IP 段，不可放宽为 true/更大跳数。
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // Security headers with Helmet (per Spec 1.2)
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allow inline styles/scripts for Vite & Math rendering
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  // form-urlencoded 解析：支付宝异步通知（POST /api/subscriptions/notify）以该格式回调（ADR-0014）
  app.use(express.urlencoded({ extended: false }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
      timestamp: new Date().toISOString(),
    });
  });

  // Database Diagnostics
  app.get('/api/db/status', async (_req, res) => {
    try {
      const status = await checkDbStatus();
      if (process.env.NODE_ENV === 'production') {
        // 审计修复（数据隔离排查 2026-09-09）：生产环境剥离全库聚合计数，
        // 防止公开端点探测平台规模；探活所需的 connected/degraded/type 保留。
        const { userCount: _u, canvasCount: _c, nodeCount: _n, ...safe } = status;
        res.json(safe);
      } else {
        res.json(status);
      }
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to check database status' });
    }
  });

  // Mount modular sub-routers
  app.use('/api/auth', authRouter);
  app.use('/api/feedback', (req, res, next) => {
    req.url = '/feedback';
    authRouter(req, res, next);
  });
  app.use('/api/admin', adminRouter);
  app.use('/api/canvases', canvasesRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/quota', quotaRouter);
  app.use('/api/shares', sharesRouter);
  app.use('/api/folders', foldersRouter);

  // Unified error handling (must be after all API routes)
  app.use(errorHandler);

  return app;
}
