/**
 * Spec L1 / ADR-0015：画板分组本地视图 + 在线优先 CRUD。
 *
 * - 服务端 `/api/folders` 为权威，本地缓存按 scope 隔离（离线仍可见分组结构）
 * - 新建/改名/删除**在线优先**：乐观更新，失败回滚并返回错误供上层 toast；
 *   离线时直接拒绝（移动画板归属不走此模块，走 meta 队列，可离线）
 * - 依赖约定：只依赖 board-scope / board-store / uuid，避免与 storage 成环
 */
import * as scope from './board-scope';
import * as boardStore from './board-store';
import { uuidv7 } from './uuid';

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

let folders: FolderMeta[] = [];
let loaded = false;
let offline = false;
let boundScope: scope.ScopeKey | null = null;
let view: FoldersView = { folders: [], loaded: false, offline: false };
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error('folder-store listener error:', e);
    }
  }
}

function rebuild(): void {
  view = { folders, loaded, offline };
  notify();
}

function persist(): void {
  try {
    scope.writeJson(scope.foldersKey(boundScope ?? undefined), folders);
  } catch (e) {
    console.error('folder-store persist failed:', e);
  }
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

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** useSyncExternalStore 的 getSnapshot：稳定引用 */
export function getFoldersView(): FoldersView {
  return view;
}

export function getFolders(): FolderMeta[] {
  return view.folders;
}

/** 绑定作用域：载入本地缓存（离线可见），loaded 置 false 待服务端刷新 */
export function bindScope(scopeKey: scope.ScopeKey): void {
  if (boundScope === scopeKey) return;
  boundScope = scopeKey;
  const cached = scope.readJson<FolderMeta[]>(scope.foldersKey(scopeKey), []);
  folders = Array.isArray(cached) ? sortFolders(cached.filter((f) => f && typeof f.id === 'string')) : [];
  loaded = false;
  offline = false;
  rebuild();
}

/** 服务端快照水合；null/失败必须 no-op（离线不得清空缓存） */
export function hydrateFromServer(list: any[] | null): void {
  if (!Array.isArray(list)) return;
  folders = sortFolders(list.map(mapFolder).filter((f): f is FolderMeta => f !== null));
  loaded = true;
  offline = false;
  persist();
  rebuild();
}

export async function refreshFolders(): Promise<boolean> {
  try {
    const res = await fetch('/api/folders', { credentials: 'include' });
    if (res.status === 401) {
      offline = true;
      rebuild();
      return false;
    }
    if (!res.ok) {
      offline = true;
      rebuild();
      return false;
    }
    const body = (await res.json()) as any;
    hydrateFromServer(Array.isArray(body?.folders) ? body.folders : []);
    return true;
  } catch {
    offline = true;
    rebuild();
    return false;
  }
}

export async function createFolder(name: string): Promise<FolderOpResult> {
  if (isOffline()) return { ok: false, error: '离线中，暂不支持新建分组' };
  const id = uuidv7();
  const prev = folders;
  folders = sortFolders([...folders, { id, name, sortOrder: folders.length }]);
  persist();
  rebuild();
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id, name }),
    });
    const body = await res.json().catch(() => null) as any;
    if (res.ok) {
      const created = mapFolder(body?.folder);
      if (created) {
        folders = sortFolders([...folders.filter((f) => f.id !== id), created]);
        persist();
        rebuild();
      }
      return { ok: true };
    }
    folders = prev;
    persist();
    rebuild();
    return { ok: false, error: body?.error || '新建分组失败，请稍后重试' };
  } catch {
    folders = prev;
    persist();
    rebuild();
    return { ok: false, error: '网络连接异常，请检查网络后重试' };
  }
}

export async function renameFolder(id: string, name: string): Promise<FolderOpResult> {
  if (isOffline()) return { ok: false, error: '离线中，暂不支持重命名分组' };
  const prev = folders;
  folders = folders.map((f) => (f.id === id ? { ...f, name } : f));
  persist();
  rebuild();
  try {
    const res = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null) as any;
      const updated = mapFolder(body?.folder);
      if (updated) {
        folders = sortFolders(folders.map((f) => (f.id === id ? updated : f)));
        persist();
        rebuild();
      }
      return { ok: true };
    }
    const body = await res.json().catch(() => null) as any;
    folders = prev;
    persist();
    rebuild();
    return { ok: false, error: body?.error || '重命名失败，请稍后重试' };
  } catch {
    folders = prev;
    persist();
    rebuild();
    return { ok: false, error: '网络连接异常，请检查网络后重试' };
  }
}

export async function deleteFolder(id: string): Promise<FolderOpResult> {
  if (isOffline()) return { ok: false, error: '离线中，暂不支持删除分组' };
  const prev = folders;
  folders = folders.filter((f) => f.id !== id);
  persist();
  rebuild();
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
    const body = await res.json().catch(() => null) as any;
    folders = prev;
    persist();
    rebuild();
    return { ok: false, error: body?.error || '删除分组失败，请稍后重试' };
  } catch {
    folders = prev;
    persist();
    rebuild();
    return { ok: false, error: '网络连接异常，请检查网络后重试' };
  }
}

/** 仅供测试 */
export function resetForTest(): void {
  folders = [];
  loaded = false;
  offline = false;
  boundScope = null;
  listeners.clear();
  view = { folders: [], loaded: false, offline: false };
}
