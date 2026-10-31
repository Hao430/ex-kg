/**
 * Spec R1 — 练习详情深链的 URL 契约（纯函数，不读 window）。
 *
 * 路由形态：
 * - 练习列表：/?view=practice（沿用现有 query 口径）
 * - 练习详情：/practice/<attemptId>（独立深链，私有 noindex）
 *
 * 分两个解析入口是为了处理浏览器后退：
 * - resolveInitialLocation：首屏允许回落 sessionStorage（刷新保持上次产品）
 * - resolvePopLocation：popstate 绝不读 sessionStorage，否则后退到 / 会被残留状态拦住
 */

export type AppView = 'landing' | 'canvas' | 'practice';

export interface AppLocation {
  view: AppView;
  /** 仅 view=practice 且处于详情路径时非空 */
  attemptId: string | null;
}

/** 与服务端 seo.ts 保持同一字符集：UUID / 短 id 均可，禁止嵌套路径 */
const PRACTICE_DETAIL_RE = /^\/practice\/([A-Za-z0-9_-]{1,64})$/;

export function parsePracticePath(pathname: string): string | null {
  const m = PRACTICE_DETAIL_RE.exec(pathname);
  return m ? m[1] : null;
}

function viewFromSearch(search: string): AppView | null {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const v = params.get('view');
  if (v === 'canvas') return 'canvas';
  if (v === 'practice' || v === 'quiz') return 'practice';
  return null;
}

/** 首屏：详情 > ?view > sessionStorage > landing */
export function resolveInitialLocation(
  pathname: string,
  search: string,
  storedView: string | null | undefined,
): AppLocation {
  const attemptId = parsePracticePath(pathname);
  if (attemptId) return { view: 'practice', attemptId };

  const fromQuery = viewFromSearch(search);
  if (fromQuery) return { view: fromQuery, attemptId: null };

  if (storedView === 'canvas' || storedView === 'practice' || storedView === 'quiz') {
    return { view: storedView === 'canvas' ? 'canvas' : 'practice', attemptId: null };
  }
  return { view: 'landing', attemptId: null };
}

/** popstate：只信当前 URL，不读 sessionStorage */
export function resolvePopLocation(pathname: string, search: string): AppLocation {
  const attemptId = parsePracticePath(pathname);
  if (attemptId) return { view: 'practice', attemptId };
  return { view: viewFromSearch(search) ?? 'landing', attemptId: null };
}

export function practiceDetailHref(attemptId: string): string {
  return `/practice/${encodeURIComponent(attemptId)}`;
}

export const PRACTICE_LIST_HREF = '/?view=practice';
export const CANVAS_HREF = '/?view=canvas';
export const HOME_HREF = '/';
