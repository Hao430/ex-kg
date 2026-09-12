import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';

import { initDbSchema } from './server/core/schema.js';
import { checkRuntimeDbRoleInvariants } from './server/core/pool.js';
import { startLogCleanupJob } from './server/jobs/log-cleanup.js';
import { createApp } from './server/app.js';

dotenv.config();

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
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // 静态资源缺失时明确 404，而非把 index.html 当 CSS/JS 返回（避免 MIME type 报错掩盖真相）
      if (req.path.startsWith('/assets/')) {
        res.status(404).json({ error: 'Static asset not found: dist 与 index.html 不一致，请完整重新构建部署' });
        return;
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Arborize (枝想) enterprise server listening on http://0.0.0.0:${PORT}`);
    // 技术债 #0011：清理任务延后到监听成功之后启动（原在 initDbSchema 之前立即首跑，
    // PG 启动慢时首跑必失败，要等 24h 下一周期才真正清理）
    startLogCleanupJob();
  });
}

start();
