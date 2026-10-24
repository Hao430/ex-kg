/**
 * Spec L1 / ADR-0015：画板分组本地视图 + 在线优先 CRUD。
 *
 * - 服务端 `/api/folders` 为权威，本地缓存按 scope 隔离（离线仍可见分组结构）
 * - 新建/改名/删除**在线优先**：乐观更新，失败回滚并返回错误供上层 toast；
 *   离线时直接拒绝（移动画板归属不走此模块，走 meta 队列，可离线）
 * - 依赖约定：只依赖 board-scope / board-store / uuid，避免与 storage 成环
 * - 订阅/视图/作用域骨架由 store-factory 提供（2026-10 反抽）
 */
import * as scope from './board-scope';
import * as boardStore from './board-store';
import { uuidv7 } from './uuid';
import { createScopedStore } from './store-factory';
import { extractErrorMessage } from './api';

export interface FolderMeta {
  id: string;
  name: string;
  sortOrder: number;
}

export interface FoldersView {
  folders: FolderMeta[];
  loaded: boolean;
  offline: boolean;
}

export type FolderOpResult = { ok: true } | { ok: false; error: string };

interface FolderState {
  folders: FolderMeta[];
  loaded: boolean;
  offline: boolean;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && (navigator as any).onLine === false;
}

function mapFolder(f: any): FolderMeta | null {
  if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') return null;
  return { id: f.id, name: f.name, sortOrder: Number(f.sort_order) || 0 };
}

function sortFolders(list: FolderMeta[]): FolderMeta[] {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
}

const store = createScopedStore<FolderState, FoldersView>({
  name: 'folder-store',
  initialState: () => ({ folders: [], loaded: false, offline: false }),
  buildView: (s) => ({ folders: s.folders, loaded: s.loaded, offline: s.offline }),
  /** 绑定作用域：载入本地缓存（离线可见），loaded 置 false 待服务端刷新 */
  onScopeBind: (key) => {
    const cached = scope.readJson<FolderMeta[]>(scope.foldersKey(key), []);
    return {
      folders: Array.isArray(cached)
        ? sortFolders(cached.filter((f) => f && typeof f.id === 'string'))
        : [],
      loaded: false,
      offline: false,
    };
  },
  writeCache: (s, key) => {
    try {
      scope.writeJson(scope.foldersKey(key ?? undefined), s.folders);
    } catch (e) {
      console.error('folder-store persist failed:', e);
    }
  },
});

export function subscribe(cb: () => void): () => void {
  return store.subscribe(cb);
}

/** useSyncExternalStore 的 getSnapshot：稳定引用 */
export function getFoldersView(): FoldersView {
  return store.getView();
}

export function getFolders(): FolderMeta[] {
  return store.getView().folders;
}

/** 绑定作用域（同 key 幂等，StrictMode 双跑安全） */
export function bindScope(scopeKey: scope.ScopeKey): void {
  store.bindScope(scopeKey);
}

/** 服务端快照水合；null/失败必须 no-op（离线不得清空缓存） */
export function hydrateFromServer(list: any[] | null): void {
  if (!Array.isArray(list)) return;
  store.setState({
    folders: sortFolders(list.map(mapFolder).filter((f): f is FolderMeta => f !== null)),
    loaded: true,
    offline: false,
  });
  store.persistNow();
}

export async function refreshFolders(): Promise<boolean> {
  try {
    const res = await fetch('/api/folders', { credentials: 'include' });
    if (res.status === 401) {
      store.setState({ ...store.getState(), offline: true });
      return false;
    }
    if (!res.ok) {
      store.setState({ ...store.getState(), offline: true });
      return false;
    }
    const body = (await res.json()) as any;
    hydrateFromServer(Array.isArray(body?.folders) ? body.folders : []);
    return true;
  } catch {
    store.setState({ ...store.getState(), offline: true });
    return false;
  }
}

export async function createFolder(name: string): Promise<FolderOpResult> {
  if (isOffline()) return { ok: false, error: '离线中，暂不支持新建分组' };
  const id = uuidv7();
  const prev = store.getState().folders;
  const { loaded, offline } = store.getState();
  store.setState({ folders: sortFolders([...prev, { id, name, sortOrder: prev.length }]), loaded, offline });
  store.persistNow();
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id, name }),
    });
    if (!res.ok) {
      const error = await extractErrorMessage(res, '新建分组失败，请稍后重试');
      store.setState({ ...store.getState(), folders: prev });
      store.persistNow();
      return { ok: false, error };
    }
    const body = await res.json().catch(() => null) as any;
    const created = mapFolder(body?.folder);
    if (created) {
      store.setState({
        ...store.getState(),
        folders: sortFolders([...store.getState().folders.filter((f) => f.id !== id), created]),
      });
      store.persistNow();
    }
    return { ok: true };
  } catch {
    store.setState({ ...store.getState(), folders: prev });
    store.persistNow();
    return { ok: false, error: '网络连接异常，请检查网络后重试' };
  }
}

export async function renameFolder(id: string, name: string): Promise<FolderOpResult> {
  if (isOffline()) return { ok: false, error: '离线中，暂不支持重命名分组' };
  const prev = store.getState().folders;
  store.setState({ ...store.getState(), folders: prev.map((f) => (f.id === id ? { ...f, name } : f)) });
  store.persistNow();
  try {
    const res = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const error = await extractErrorMessage(res, '重命名失败，请稍后重试');
      store.setState({ ...store.getState(), folders: prev });
      store.persistNow();
      return { ok: false, error };
    }
    const body = await res.json().catch(() => null) as any;
    const updated = mapFolder(body?.folder);
    if (updated) {
      store.setState({
        ...store.getState(),
        folders: sortFolders(store.getState().folders.map((f) => (f.id === id ? updated : f))),
      });
      store.persistNow();
    }
    return { ok: true };
  } catch {
    store.setState({ ...store.getState(), folders: prev });
    store.persistNow();
    return { ok: false, error: '网络连接异常，请检查网络后重试' };
  }
}

export async function deleteFolder(id: string): Promise<FolderOpResult> {
  if (isOffline()) return { ok: false, error: '离线中，暂不支持删除分组' };
  const prev = store.getState().folders;
  store.setState({ ...store.getState(), folders: prev.filter((f) => f.id !== id) });
  store.persistNow();
  try {
    const res = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok || res.status === 404) {
      // 服务端已解除组内画板归属，本地同步收敛
      boardStore.clearFolderOnBoards(id);
      return { ok: true };
    }
    const error = await extractErrorMessage(res, '删除分组失败，请稍后重试');
    store.setState({ ...store.getState(), folders: prev });
    store.persistNow();
    return { ok: false, error };
  } catch {
    store.setState({ ...store.getState(), folders: prev });
    store.persistNow();
    return { ok: false, error: '网络连接异常，请检查网络后重试' };
  }
}

/** 仅供测试 */
export function resetForTest(): void {
  store.resetForTest();
}
