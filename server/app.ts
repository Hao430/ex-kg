import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { authRouter } from './routes/auth.js';
import { wechatRouter } from './routes/wechat.js';
import { adminRouter } from './routes/admin.js';
import { canvasesRouter } from './routes/canvases.js';
import { chatRouter } from './routes/chat.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { quotaRouter } from './routes/quota.js';
import { sharesRouter } from './routes/shares.js';
import { foldersRouter } from './routes/folders.js';
import { errorHandler } from './middleware/error-handler.js';
import { sameOriginGuard } from './middleware/same-origin.js';
import { checkDbStatus } from './core/db-status.js';
import { buildRobotsTxt, buildSitemapXml, resolveOrigin } from './lib/seo.js';

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
  // form-urlencoded 解析**只挂给支付宝异步通知**（POST /api/subscriptions/notify，ADR-0014）——
  // 全仓唯一消费方（tests/alipay-payment.test.ts 实证）。此前是全局挂载，等于给所有端点
  // 开了一道表单编码面（技术债 #0013 加固项），收窄后 JSON 端点不再接受表单体。
  app.use('/api/subscriptions/notify', express.urlencoded({ extended: false }));

  // 变更方法同源守卫（技术债 #0013，ADR-0020）：必须在所有路由之前、body parser 之后。
  // 只作用于 POST/PUT/PATCH/DELETE，不带 Origin 的非浏览器客户端一律放行。
  app.use(sameOriginGuard);

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
  // 微信登录（ADR-0022）：必须在同一守卫之下。authRouter 无 `/wechat/*` 路由，
  // 未命中即 next() 落到这里；两条挂载共用 `/api/auth` 前缀互不干扰。
  app.use('/api/auth/wechat', wechatRouter);
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

  // SEO 基础文件：`/robots.txt` 与 `/sitemap.xml`。
  // 动态生成而非塞进 public/ —— 仓库里就不必硬编码生产域名，且 sitemap 的 loc 与
  // canonical 恒同源（都走 resolveOrigin：APP_URL 优先，未配置才按请求推导）。
  // 必须挂在 errorHandler 之前，否则这两个端点的异常会绕过统一 JSON 错误处理。
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(buildRobotsTxt(resolveOrigin(req)));
  });

  app.get('/sitemap.xml', (req, res) => {
    res.set('Content-Type', 'application/xml; charset=utf-8').send(buildSitemapXml(resolveOrigin(req)));
  });

  // Unified error handling (must be after all API routes)
  app.use(errorHandler);

  return app;
}
