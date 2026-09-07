import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ResetPasswordPage, VerifyEmailPage } from './components/auth/ResetPasswordPage.tsx';
import './index.css';
import 'katex/dist/katex.min.css';

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

// 邮件链接落地页分流：/reset-password（Spec F1）与 /verify-email（Spec D3）
// 生产由 server.ts SPA fallback、开发由 vite appType:'spa' 兜底到本应用。
const pathname = window.location.pathname;
const StandalonePage =
  pathname === '/reset-password' ? ResetPasswordPage :
  pathname === '/verify-email' ? VerifyEmailPage :
  null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {StandalonePage ? <StandalonePage /> : <App />}
  </StrictMode>
);
