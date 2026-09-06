import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { canvasesRouter } from './routes/canvases.js';
import { chatRouter } from './routes/chat.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { errorHandler } from './middleware/error-handler.js';
import { checkDbStatus } from './core/db-status.js';

/**
 * Express 应用工厂：中间件、健康检查与 API 路由挂载。
 * 监听与静态资源/Vite 中间件由 server.ts 负责，便于测试中独立实例化。
 */
export function createApp(): express.Express {
  const app = express();

  // Trust the reverse proxy (required for express-rate-limit in production/cloud)
  app.set('trust proxy', 1);

  // Security headers with Helmet (per Spec 1.2)
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allow inline styles/scripts for Vite & Math rendering
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));

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
      res.json(status);
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

  // Unified error handling (must be after all API routes)
  app.use(errorHandler);

  return app;
}
