import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';

import { initDbSchema } from './server/core/schema.js';
import { checkRuntimeDbRoleInvariants } from './server/core/pool.js';
import { dropDefaultSeedUsers } from './server/core/memory-store.js';
import { startLogCleanupJob } from './server/jobs/log-cleanup.js';
import { createApp } from './server/app.js';
import { injectSeo, resolveOrigin, routeForPath, SEO_SHELL_ROUTES, type SeoRoute } from './server/lib/seo.js';

dotenv.config();

// 安全审查 M2：生产进程不得残留演示种子账号（`admin@deepdive.ai` 等，口令是源码常量）。
// 播种在 memory-store 的模块导入期执行，**早于**上一行的 dotenv.config()——这是本仓已踩三次
// 的时序坑。若 NODE_ENV 只写在 .env 里（而非由进程管理器显式给出），导入期读到的
// process.env.NODE_ENV 是 undefined，`if (production) return` 判定必然落空、种子已经建好。
// 此处 process.env 已就绪，清除是确定性的。
if (process.env.NODE_ENV === 'production') {
  const removedSeedUsers = dropDefaultSeedUsers();
  if (removedSeedUsers > 0) {
    console.error(
      `❌ 已清除 ${removedSeedUsers} 个演示种子账号：生产环境不得存在公开口令账号（安全审查 M2）`
    );
  }
}

// 数据库角色不变量（ADR-0019）：owner 凭据不得出现在运行期进程；生产必须显式配
// DATABASE_SYSTEM_URL。响亮拒绝启动，好过带着静默错误（跨租户路径被 RLS 拦成零行）对外服务。
const roleProblems = checkRuntimeDbRoleInvariants();
if (roleProblems.length > 0) {
  for (const problem of roleProblems) console.error(`❌ ${problem}`);
  process.exit(1);
}

// CJS 兼容：esbuild bundle 下 import.meta.url 为空，用 process.cwd() 代替
const __dirname = process.cwd();

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

/**
 * 生产 HTML 输出（SEO 注入层）。
 *
 * 背景：本站是纯客户端渲染的 SPA，`express.static` 对 `/share/:code`、任意乱路径与 `/`
 * 一律回同一份 index.html。对不执行 JS 的爬虫（百度/搜狗等）来说，整站等于没有正文；
 * 未知路径回 200 又构成软 404 与无限重复内容。这里按路由注入 head + 落地页静态正文，
 * 并把「非 SPA 路径」修正为真 404。
 *
 * 分工：本函数只管 IO 与状态码，字符串拼装全在 `server/lib/seo.ts`（纯函数、可单测）。
 */
function registerProductionRoutes(expressApp: express.Express, distPath: string) {
  const htmlPath = path.join(distPath, 'index.html');

  // 启动即读（而不是按请求读）：缺文件/缺标记属构建产物问题，宁可拒绝启动，
  // 也不要对外吐出一份没有 title 的 HTML。部署流程必然重启进程，故此缓存不会陈旧
  // （唯一会陈旧的场景是有人手工 rsync dist 而不重启）。
  let shellHtml: string;
  try {
    shellHtml = fs.readFileSync(htmlPath, 'utf-8');
    // 试注入一次：Vite 若在升级中丢了 HTML 注释标记，要在启动时就发现
    injectSeo(shellHtml, 'home', { origin: 'https://example.invalid', pathname: '/' });
  } catch (error: any) {
    console.error(`❌ 无法加载 SEO 模板 ${htmlPath}：${error?.message || error}`);
    console.error('   请完整重新构建部署（npm run build 产物须含 <!--seo:head--> 与 <!--seo:body--> 标记）');
    process.exit(1);
  }

  const sendShell = (
    req: express.Request,
    res: express.Response,
    route: SeoRoute,
    status: number
  ) => {
    const origin = resolveOrigin(req);
    let html: string;
    try {
      html = injectSeo(shellHtml, route, { origin, pathname: req.path });
    } catch (error: any) {
      console.error('❌ SEO 注入失败：', error?.message || error);
      res.status(500).type('text/plain').send('页面模板异常，请稍后重试');
      return;
    }
    res.status(status).type('html').send(html);
  };

  // ⚠️ 必须注册在 express.static 之前：static 默认 index:'index.html'，否则 `/` 会被它抢先服务。
  expressApp.get(
    [...SEO_SHELL_ROUTES],
    (req, res, next) => {
      const route = routeForPath(req.path);
      if (!route) {
        next();
        return;
      }
      sendShell(req, res, route, 200);
    }
  );

  expressApp.use(express.static(distPath, { index: false }));

  expressApp.get('*', (req, res) => {
    // 静态资源缺失时明确 404，而非把 index.html 当 CSS/JS 返回（避免 MIME type 报错掩盖真相）
    if (req.path.startsWith('/assets/')) {
      res.status(404).json({ error: 'Static asset not found: dist 与 index.html 不一致，请完整重新构建部署' });
      return;
    }
    // 未匹配的 API 路径回 JSON 404：今天会落到 200 + index.html，客户端 JSON 解析失败后
    // 报出的是一个与真因无关的错误
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // 其余是拼错的路径：回真 404（不再是软 404 的 200 + 落地页），并 noindex。
    // 仍返回 SPA 壳，用户看到正常界面而不至于撞上裸文本错误页。
    sendShell(req, res, 'not-found', 404);
  });
}

async function start() {
  // schema 迁移已移出生产进程（ADR-0019）：生产由部署期 `npm run migrate` 以 owner 角色执行，
  // 应用进程零 DDL 权限。非生产保留启动兜底，保住 `npm run dev` 与既有 PG 冒烟套件的现状
  // （它们不设 NODE_ENV，且需要「起来即有表」）。
  if (process.env.NODE_ENV !== 'production') {
    initDbSchema().catch((err) => console.warn('Background initDbSchema warning:', err?.message || err));
  }

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // 开发模式**不做** SEO 注入：localhost 无收录价值，注入会与 Vite 的 HTML 转换互相干扰。
    // 代价是 SEO 产物只能在 NODE_ENV=production 下验收（见 docs 与本轮验收步骤）。
    registerProductionRoutes(app, path.join(process.cwd(), 'dist'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Arborize (枝想) enterprise server listening on http://0.0.0.0:${PORT}`);
    // 技术债 #0011：清理任务延后到监听成功之后启动（原在 initDbSchema 之前立即首跑，
    // PG 启动慢时首跑必失败，要等 24h 下一周期才真正清理）
    startLogCleanupJob();
  });
}

start();
