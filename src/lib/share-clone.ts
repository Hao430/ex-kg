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
/** CTA 本次会话新鲜标记：克隆成功后仅在「刚点过 CTA」时才切入画布视图，不打断落地页浏览 */
const CLONE_FRESH_KEY = 'deepdive_clone_fresh';

/** CTA 点击时记录克隆意图（含时间戳，过期自动失效） */
export function recordCloneIntent(shareCode: string): void {
  if (!shareCode) return;
  try {
    localStorage.setItem(CLONE_KEY, JSON.stringify({ code: shareCode, ts: Date.now() }));
    sessionStorage.setItem(CLONE_FRESH_KEY, '1');
  } catch {}
}

export interface CloneIntent {
  code: string;
}

function readIntent(): CloneIntent | null {
  try {
    const raw = localStorage.getItem(CLONE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: string; ts?: number };
    if (!parsed?.code || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > CLONE_INTENT_TTL_MS) return null;
    return { code: parsed.code };
  } catch {
    return null;
  }
}

/**
 * 读取但不焚毁克隆意图（Spec K6 修复）：配额预检失败/网络失败时意图保留，
 * 充值成功、删板腾位或下次就绪后可自动重试；仅在克隆成功（markShareCloned 后）
 * 或分享确认失效时才 takeCloneIntent() 焚毁。
 */
export function peekCloneIntent(): CloneIntent | null {
  return readIntent();
}

/**
 * 取出克隆意图（读后即焚）。超过 7 天或数据损坏返回 null。
 * 仅在克隆成功后调用，作为清理。
 */
export function takeCloneIntent(): CloneIntent | null {
  try {
    localStorage.removeItem(CLONE_KEY);
  } catch {}
  return readIntent();
}

/**
 * 是否「本次会话刚点过 CTA」（fresh 标记，读后即焚）。
 * 克隆成功时仅 fresh 才切入画布视图，避免打断正在浏览落地页的已登录用户。
 */
export function takeCloneFreshFlag(): boolean {
  try {
    if (sessionStorage.getItem(CLONE_FRESH_KEY) !== '1') return false;
    sessionStorage.removeItem(CLONE_FRESH_KEY);
    return true;
  } catch {
    return false;
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
