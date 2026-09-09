import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * 本配置仅开发模式（npm run dev）生效：Express 以 Vite middleware 方式挂载 HMR
 * （server.ts）。生产构建走 `vite build` 产出 dist/，由 `express.static(dist)`
 * 静态托管——生产运行时不加载本文件、不存在 Vite 进程（技术债 #0081 口径澄清）。
 */
export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
