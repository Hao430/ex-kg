/**
 * Spec K4（跟踪清单 B3）：Umami 自托管埋点接入。
 *
 * 部署：仓库根 `docker-compose.umami.yml`（独立 3001 端口，自带专用 Postgres，不占应用 3000）。
 * 配置：前端环境变量两个（.env）——
 *   VITE_UMAMI_SRC        Umami 的 script.js 完整 URL（如 https://统计域名/script.js）
 *   VITE_UMAMI_WEBSITE_ID Umami 后台为「枝想」创建站点后生成的 website id
 * 两者任一缺失时全部埋点函数静默 no-op（开发环境零依赖、零报错）。
 *
 * 隐私红线（审计约定）：事件 data 只允许枚举/计数（format、remaining 等），
 * 禁止携带邮箱、画板标题、节点问答内容等任何 PII；事件名仅内部口径，不出现在用户文案。
 *
 * Umami 未加载完成前的事件进入待发队列（上限 50 条），脚本 load 后统一冲刷。
 */

type EventData = Record<string, string | number | boolean>;

const UMAMI_SRC = import.meta.env.VITE_UMAMI_SRC as string | undefined;
const UMAMI_WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined;

declare global {
  interface Window {
    umami?: {
      track?: (event?: string, data?: EventData) => void;
    };
  }
}

let pendingEvents: Array<{ name: string; data?: EventData }> = [];

function flushPendingEvents() {
  if (!window.umami?.track) return; // 脚本异常时丢弃队列，避免无限积压
  for (const { name, data } of pendingEvents) {
    try {
      window.umami.track(name, data);
    } catch {
      // 单条上报失败不影响其余事件
    }
  }
  pendingEvents = [];
}

/** 幂等注入 Umami 统计脚本（main.tsx 启动时调用一次） */
export function initAnalytics(): void {
  if (!UMAMI_SRC || !UMAMI_WEBSITE_ID) return;
  if (typeof document === 'undefined') return;
  if (document.querySelector(`script[src="${UMAMI_SRC}"]`)) return;

  const script = document.createElement('script');
  script.defer = true;
  script.src = UMAMI_SRC;
  script.setAttribute('data-website-id', UMAMI_WEBSITE_ID);
  script.addEventListener('load', flushPendingEvents);
  document.head.appendChild(script);
}

/** 上报自定义事件；Umami 未配置/未就绪时静默降级（队列或丢弃） */
export function trackEvent(name: string, data?: EventData): void {
  try {
    if (window.umami?.track) {
      window.umami.track(name, data);
    } else if (pendingEvents.length < 50) {
      pendingEvents.push({ name, data });
    }
  } catch {
    // 埋点永不影响业务流程
  }
}

/**
 * 一次性去重事件（localStorage 标记）：
 * - daily=false：按 key 终身一次（如每画板首次 AI 生成）
 * - daily=true：标记含日期，自然日重置（如每日活跃）
 */
export function trackOnce(
  key: string,
  name: string,
  data?: EventData,
  daily = false
): void {
  try {
    const storageKey = `umami_once_${key}`;
    const marker = daily ? new Date().toISOString().slice(0, 10) : '1';
    if (localStorage.getItem(storageKey) === marker) return;
    localStorage.setItem(storageKey, marker);
    trackEvent(name, data);
  } catch {
    // localStorage 不可用（隐私模式等）时按普通事件上报，宁可多计不可漏计
    trackEvent(name, data);
  }
}
