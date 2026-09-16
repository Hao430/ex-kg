/**
 * ResizeObserver 噪声兜底。
 *
 * 原先是 index.html 里的内联 `<script>`，2026-09-16 安全审查（M5）外置到这里：
 * 生产启用 CSP 后 `script-src 'self'` 不再允许内联脚本，而这段逻辑必须在
 * React 之前执行（它要在应用监听之前把 error/unhandledrejection 抢下来）。
 *
 * 保持在 `<head>` 里以同步、阻塞的方式加载：浏览器会先执行它，再执行
 * `<script type="module" src="/src/main.tsx">`。
 *
 * 逻辑与内联版**逐字一致**（只把注释搬到文件头），不改行为：
 * ResizeObserver loop limit / undelivered notifications 是良性告警，
 * 不应冒泡成 unhandled exception 影响错误上报。
 */
window.addEventListener(
  'error',
  function (e) {
    if (
      e &&
      e.message &&
      (e.message.indexOf('ResizeObserver') !== -1 ||
        e.message.indexOf('resize observer') !== -1)
    ) {
      e.stopImmediatePropagation();
      if (e.preventDefault) e.preventDefault();
      return true;
    }
  },
  true
);
window.addEventListener(
  'unhandledrejection',
  function (e) {
    if (
      e &&
      e.reason &&
      e.reason.message &&
      (e.reason.message.indexOf('ResizeObserver') !== -1 ||
        e.reason.message.indexOf('resize observer') !== -1)
    ) {
      e.stopImmediatePropagation();
      if (e.preventDefault) e.preventDefault();
      return true;
    }
  },
  true
);
