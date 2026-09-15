import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ResetPasswordPage, VerifyEmailPage } from './components/auth/ResetPasswordPage.tsx';
import { SharePage } from './components/share/SharePage.tsx';
import { initAnalytics, trackOnce } from './lib/analytics.ts';
import './index.css';
import 'katex/dist/katex.min.css';

// Spec K4（B3）：Umami 自托管埋点——启动注入（VITE_UMAMI_SRC/WEBSITE_ID 未配置时 no-op），
// 每日活跃在主应用内去重上报（分享页等独立页不计入，其浏览量由 share_view 事件单独统计）。
initAnalytics();

// Root fix for ResizeObserver loop completed with undelivered notifications in React Flow
if (typeof window !== 'undefined' && window.ResizeObserver) {
  const OriginalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class PatchedResizeObserver extends OriginalResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => {
          try {
            callback(entries, observer);
          } catch {
            // Ignore benign frame overrun
          }
        });
      });
    }
  };

  const isResizeObserverError = (msg?: string) =>
    typeof msg === 'string' &&
    (msg.includes('ResizeObserver') || msg.includes('resize observer'));

  window.addEventListener(
    'error',
    (event) => {
      if (isResizeObserverError(event.message)) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true
  );

  window.addEventListener(
    'unhandledrejection',
    (event) => {
      if (isResizeObserverError(event.reason?.message)) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true
  );
}

// 独立落地页分流：/reset-password（Spec F1）、/verify-email（Spec D3）、
// /share/:code（Spec K2 公开只读分享）。
// 生产由 server.ts SPA fallback、开发由 vite appType:'spa' 兜底到本应用。
const pathname = window.location.pathname;
let StandalonePage: ComponentType | null = null;
if (pathname === '/reset-password') StandalonePage = ResetPasswordPage;
else if (pathname === '/verify-email') StandalonePage = VerifyEmailPage;
else if (pathname.startsWith('/share/')) StandalonePage = SharePage;

// 服务端注入的静态回退块（仅供不执行 JS 的爬虫读取，见 server/lib/seo.ts）在 React 接管前
// 整体移除：留着会同时出现两个 H1 与一份隐藏正文。移除后稳态 DOM 里只有 React 内容。
document.querySelectorAll('[data-seo-fallback]').forEach((el) => el.remove());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {StandalonePage ? <StandalonePage /> : <App />}
  </StrictMode>
);

// 每日活跃（K4 事件 7）：仅主应用（含落地页/画布），localStorage 按日去重
if (!StandalonePage) trackOnce('daily_active', 'daily_active', undefined, true);
