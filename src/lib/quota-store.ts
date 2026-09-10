/**
 * 配额快照与「新建画板」闸门（2026-09-10 画布列表/同步重构）。
 *
 * 服务端 /api/quota 为唯一权威；前端不再用本地索引硬拦。展示用量 = 服务端快照
 * （或游客本地板数）+ 本地 pendingCreates，用于顶栏「画板 X/3」。
 */
import * as scope from './board-scope';
import * as boardStore from './board-store';

export const CLIENT_BOARD_LIMIT = 3;

export type Plan = 'trial' | 'vip' | 'admin';
export type CreateGate = 'allow' | 'block' | 'optimistic';

export interface QuotaSnapshot {
  plan: Plan;
  vipExpired: boolean;
  board: { used: number; limit: number | null };
  loadedAt: number;
  offline: boolean;
}

export interface QuotaView {
  used: number;
  limit: number | null;
  unlimited: boolean;
  offline: boolean;
  plan: Plan;
  vipExpired: boolean;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && (navigator as any).onLine === false;
}

let snapshot: QuotaSnapshot | null = null;
/** 服务端已计入的板数（乐观校正：确认创建 +1 / 删板 -1），refresh 时重置 */
let serverUsedOverride: number | null = null;
let pending = new Set<string>();
let boundScope: scope.ScopeKey | null = null;
let view: QuotaView = {
  used: 0,
  limit: CLIENT_BOARD_LIMIT,
  unlimited: false,
  offline: false,
  plan: 'trial',
  vipExpired: false,
};
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error('quota-store listener error:', e);
    }
  }
}

function persistPending(): void {
  try {
    scope.writeStringSet(scope.pendingCreateKey(boundScope ?? undefined), pending);
  } catch (e) {
    console.error('quota-store persist failed:', e);
  }
}

function rebuildView(): void {
  const unlimited = snapshot?.plan === 'admin' || snapshot?.plan === 'vip';
  const base = snapshot
    ? serverUsedOverride ?? snapshot.board.used
    : boardStore.getBoardList().length;
  view = {
    used: Math.max(0, base + pending.size),
    limit: snapshot ? snapshot.board.limit : CLIENT_BOARD_LIMIT,
    unlimited,
    offline: snapshot?.offline ?? isOffline(),
    plan: snapshot?.plan ?? 'trial',
    vipExpired: snapshot?.vipExpired ?? false,
  };
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** useSyncExternalStore 的 getSnapshot：稳定引用 */
export function getQuotaView(): QuotaView {
  return view;
}

export function getQuotaSnapshot(): QuotaSnapshot | null {
  return snapshot;
}

export function getPendingCreateIds(): string[] {
  return Array.from(pending);
}

/** 绑定账号作用域并载入 pendingCreates */
export function setScope(scopeKey: scope.ScopeKey): void {
  boundScope = scopeKey;
  pending = scope.readStringSet(scope.pendingCreateKey(scopeKey));
  snapshot = null;
  serverUsedOverride = null;
  rebuildView();
  notify();
}

export async function refreshQuota(): Promise<void> {
  try {
    const res = await fetch('/api/quota', { credentials: 'include' });
    if (res.status === 401) {
      // 未登录：无服务端配额，回退本地板数
      snapshot = null;
      serverUsedOverride = null;
      rebuildView();
      notify();
      return;
    }
    if (!res.ok) return;
    const body = (await res.json()) as any;
    snapshot = {
      plan: (body?.plan as Plan) || 'trial',
      vipExpired: Boolean(body?.vipExpired),
      board: {
        used: Number(body?.board?.used) || 0,
        limit: body?.board?.limit == null ? null : Number(body.board.limit),
      },
      loadedAt: Date.now(),
      offline: false,
    };
    serverUsedOverride = snapshot.board.used;
    rebuildView();
    notify();
  } catch {
    // 网络失败：保留旧快照并标记离线，绝不清空
    snapshot = snapshot ? { ...snapshot, offline: true } : null;
    rebuildView();
    notify();
  }
}

/** 新建画板闸门：block=在线且额度已满；optimistic=离线/快照不可信，先建后补 */
export function canCreate(isVip: boolean): CreateGate {
  if (isVip || view.unlimited) return 'allow';
  if (isOffline()) return 'optimistic';
  if (!snapshot) return 'optimistic';
  if (view.limit != null && view.used >= view.limit) return 'block';
  return 'allow';
}

export function markPendingCreate(id: string): void {
  // 无服务端快照（游客/未拉取）时展示基数已是本地板数，再叠加会重复计数
  if (snapshot === null) return;
  if (pending.has(id)) return;
  pending.add(id);
  persistPending();
  rebuildView();
  notify();
}

export function unmarkPendingCreate(id: string): void {
  if (!pending.delete(id)) return;
  persistPending();
  rebuildView();
  notify();
}

/** 服务端确认创建：pending 出列，服务端已计数 +1（净展示不变） */
export function confirmCreate(id: string): void {
  if (!pending.delete(id)) return;
  if (serverUsedOverride != null) serverUsedOverride += 1;
  persistPending();
  rebuildView();
  notify();
}

/** 服务端确认删除：已计板数 -1（净展示回落） */
export function confirmDelete(): void {
  if (serverUsedOverride != null) serverUsedOverride = Math.max(0, serverUsedOverride - 1);
  rebuildView();
  notify();
}

/** 仅供测试 */
export function resetForTest(): void {
  snapshot = null;
  serverUsedOverride = null;
  pending = new Set();
  boundScope = null;
  rebuildView();
  notify();
}
