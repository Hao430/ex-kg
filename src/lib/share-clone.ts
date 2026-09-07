/**
 * Spec K6（跟踪清单 B1 方案 B）：分享画布一键克隆（注册/登录后自动执行）。
 *
 * 流程：分享页 CTA 点击 → recordCloneIntent 记录意图（localStorage，7 天过期）→
 * 访客进入主应用完成注册/登录 → App 检测到意图 → 拉取公开快照 → 构造
 * StoredBoard → saveBoard() 走既有同步队列落服务端（配额由 save 路径的
 * assertCanCreateBoard 拦截，与本客户端预检双保险）。
 *
 * 幂等：deepdive_cloned_codes 记录已克隆的 code，同一分享对同一浏览器只克隆一次。
 */

const CLONE_KEY = 'deepdive_clone_code';
const CLONED_CODES_KEY = 'deepdive_cloned_codes';
const CLONE_INTENT_TTL_MS = 7 * 24 * 3600 * 1000;

/** CTA 点击时记录克隆意图（含时间戳，过期自动失效） */
export function recordCloneIntent(shareCode: string): void {
  if (!shareCode) return;
  try {
    localStorage.setItem(CLONE_KEY, JSON.stringify({ code: shareCode, ts: Date.now() }));
  } catch {}
}

export interface CloneIntent {
  code: string;
}

/**
 * 取出克隆意图（读后即焚）。超过 7 天或数据损坏返回 null。
 * App 在「用户已登录且画板就绪」时调用一次。
 */
export function takeCloneIntent(): CloneIntent | null {
  try {
    const raw = localStorage.getItem(CLONE_KEY);
    if (!raw) return null;
    localStorage.removeItem(CLONE_KEY);
    const parsed = JSON.parse(raw) as { code?: string; ts?: number };
    if (!parsed?.code || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > CLONE_INTENT_TTL_MS) return null;
    return { code: parsed.code };
  } catch {
    return null;
  }
}

/** 该分享是否已在本地克隆过（防重复） */
export function isShareCloned(shareCode: string): boolean {
  try {
    const codes = JSON.parse(localStorage.getItem(CLONED_CODES_KEY) || '[]');
    return Array.isArray(codes) && codes.includes(shareCode);
  } catch {
    return false;
  }
}

/** 记录已克隆的分享 code */
export function markShareCloned(shareCode: string): void {
  try {
    const codes = JSON.parse(localStorage.getItem(CLONED_CODES_KEY) || '[]');
    if (Array.isArray(codes) && !codes.includes(shareCode)) {
      codes.push(shareCode);
      localStorage.setItem(CLONED_CODES_KEY, JSON.stringify(codes));
    }
  } catch {}
}
