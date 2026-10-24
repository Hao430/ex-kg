/**
 * 配额快照与「新建画板」闸门（2026-09-10 画布列表/同步重构）。
 *
 * 服务端 /api/quota 为唯一权威；前端不再用本地索引硬拦。展示用量 = 服务端快照
 * （或游客本地板数）+ 本地 pendingCreates，用于顶栏「画板 X/3」。
 * 订阅/视图/作用域骨架由 store-factory 提供（2026-10 反抽）。
 */
import * as scope from './board-scope';
import * as boardStore from './board-store';
import { createScopedStore } from './store-factory';

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

interface QuotaState {
  snapshot: QuotaSnapshot | null;
  /** 服务端已计入的板数（乐观校正：确认创建 +1 / 删板 -1），refresh 时重置 */
  serverUsedOverride: number | null;
  pending: Set<string>;
}

const store = createScopedStore<QuotaState, QuotaView>({
  name: 'quota-store',
  initialState: () => ({ snapshot: null, serverUsedOverride: null, pending: new Set<string>() }),
  buildView: (s) => {
    const { snapshot, serverUsedOverride, pending } = s;
    const unlimited = snapshot?.plan === 'admin' || snapshot?.plan === 'vip';
    const base = snapshot
      ? serverUsedOverride ?? snapshot.board.used
      : boardStore.getBoardList().length;
    return {
      used: Math.max(0, base + pending.size),
      limit: snapshot ? snapshot.board.limit : CLIENT_BOARD_LIMIT,
      unlimited,
      offline: snapshot?.offline ?? isOffline(),
      plan: snapshot?.plan ?? 'trial',
      vipExpired: snapshot?.vipExpired ?? false,
    };
  },
  /** 绑定账号作用域并载入 pendingCreates */
  onScopeBind: (key) => ({
    snapshot: null,
    serverUsedOverride: null,
    pending: scope.readStringSet(scope.pendingCreateKey(key)),
  }),
  writeCache: (s, key) => {
    try {
      scope.writeStringSet(scope.pendingCreateKey(key ?? undefined), s.pending);
    } catch (e) {
      console.error('quota-store persist failed:', e);
    }
  },
});

export function subscribe(cb: () => void): () => void {
  return store.subscribe(cb);
}

/** useSyncExternalStore 的 getSnapshot：稳定引用 */
export function getQuotaView(): QuotaView {
  return store.getView();
}

export function getQuotaSnapshot(): QuotaSnapshot | null {
  return store.getState().snapshot;
}

export function getPendingCreateIds(): string[] {
  return Array.from(store.getState().pending);
}

/** 绑定账号作用域并载入 pendingCreates（同 key 幂等；App 侧已按 scopeChanged 门控） */
export function setScope(scopeKey: scope.ScopeKey): void {
  store.bindScope(scopeKey);
}

export async function refreshQuota(): Promise<void> {
  try {
    const res = await fetch('/api/quota', { credentials: 'include' });
    if (res.status === 401) {
      // 未登录：无服务端配额，回退本地板数
      store.setState({ ...store.getState(), snapshot: null, serverUsedOverride: null });
      return;
    }
    if (!res.ok) return;
    const body = (await res.json()) as any;
    const snapshot: QuotaSnapshot = {
      plan: (body?.plan as Plan) || 'trial',
      vipExpired: Boolean(body?.vipExpired),
      board: {
        used: Number(body?.board?.used) || 0,
        limit: body?.board?.limit == null ? null : Number(body.board.limit),
      },
      loadedAt: Date.now(),
      offline: false,
    };
    store.setState({ ...store.getState(), snapshot, serverUsedOverride: snapshot.board.used });
  } catch {
    // 网络失败：保留旧快照并标记离线，绝不清空
    const { snapshot } = store.getState();
    store.setState({
      ...store.getState(),
      snapshot: snapshot ? { ...snapshot, offline: true } : null,
    });
  }
}

/** 新建画板闸门：block=在线且额度已满；optimistic=离线/快照不可信，先建后补 */
export function canCreate(isVip: boolean): CreateGate {
  const view = store.getView();
  if (isVip || view.unlimited) return 'allow';
  if (isOffline()) return 'optimistic';
  if (store.getState().snapshot === null) return 'optimistic';
  if (view.limit != null && view.used >= view.limit) return 'block';
  return 'allow';
}

export function markPendingCreate(id: string): void {
  // 无服务端快照（游客/未拉取）时展示基数已是本地板数，再叠加会重复计数
  if (store.getState().snapshot === null) return;
  const pending = store.getState().pending;
  if (pending.has(id)) return;
  pending.add(id);
  store.persistNow();
  store.setState({ ...store.getState(), pending });
}

export function unmarkPendingCreate(id: string): void {
  const pending = store.getState().pending;
  if (!pending.delete(id)) return;
  store.persistNow();
  store.setState({ ...store.getState(), pending });
}

/** 服务端确认创建：pending 出列，服务端已计数 +1（净展示不变） */
export function confirmCreate(id: string): void {
  const pending = store.getState().pending;
  if (!pending.delete(id)) return;
  const override = store.getState().serverUsedOverride;
  store.setState({
    ...store.getState(),
    serverUsedOverride: override != null ? override + 1 : null,
  });
  store.persistNow();
}

/** 服务端确认删除：已计板数 -1（净展示回落） */
export function confirmDelete(): void {
  const override = store.getState().serverUsedOverride;
  store.setState({
    ...store.getState(),
    serverUsedOverride: override != null ? Math.max(0, override - 1) : null,
  });
}

/** 仅供测试 */
export function resetForTest(): void {
  store.resetForTest();
}
