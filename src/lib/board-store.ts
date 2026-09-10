/**
 * 画板列表唯一真相（2026-09-10 画布列表/同步重构）。
 *
 * 列表 = 服务端快照 ∪ 本地未同步草稿 − 墓碑，按 id 去重；内存为权威、localStorage 为投影。
 * 修「列表缩水」（服务端列表从不落本地索引）与「幽灵板」（远端已删仍留在列表）。
 *
 * 依赖约定：本模块只依赖 board-scope（无 storage/sync-queue 引用，避免循环）。
 */
import type { DeepDiveBoardMeta } from '../types';
import * as scope from './board-scope';

export interface BoardStoreState {
  metas: DeepDiveBoardMeta[];
  serverIds: ReadonlySet<string>;
  dirty: ReadonlySet<string>;
  metaDirty: ReadonlySet<string>;
  tombstones: ReadonlySet<string>;
}

const EMPTY: DeepDiveBoardMeta[] = Object.freeze([]) as unknown as DeepDiveBoardMeta[];

let snapshot: DeepDiveBoardMeta[] = EMPTY;
let serverMetas: DeepDiveBoardMeta[] = [];
let serverIds = new Set<string>();
let localIndex = new Map<string, DeepDiveBoardMeta>();
let tombstones = new Set<string>();
let dirty = new Set<string>();
/** Spec L1：收藏/归档等元数据待同步（与内容 dirty 分离，避免触发全量上传） */
let metaDirty = new Set<string>();
let serverHydrated = false;
let boundScope: scope.ScopeKey | null = null;
const ghostsEmitted = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error('board-store listener error:', e);
    }
  }
}

function persist(): void {
  try {
    scope.writeScopedIndex(snapshot, boundScope ?? undefined);
    scope.writeStringSet(scope.dirtyKey(boundScope ?? undefined), dirty);
    scope.writeStringSet(scope.metaDirtyKey(boundScope ?? undefined), metaDirty);
    scope.saveTombstones(tombstones, boundScope ?? undefined);
  } catch (e) {
    // localStorage 配额/隐私模式：不静默失败，交由控制台与上层提示
    console.error('board-store persist failed:', e);
  }
}

function dispatchRemoteDeleted(boardId: string, name: string): void {
  if (ghostsEmitted.has(boardId)) return;
  ghostsEmitted.add(boardId);
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('deepdive:board-remote-deleted', { detail: { boardId, name } })
    );
  } catch {
    /* ignore */
  }
}

/** 合并重算：服务端顺序为基准，本地草稿/幽灵判定，dirty 本地版胜出 */
function recompute(): void {
  const list: DeepDiveBoardMeta[] = [];
  const seen = new Set<string>();

  for (const sm of serverMetas) {
    if (seen.has(sm.id) || tombstones.has(sm.id)) continue;
    seen.add(sm.id);
    const local = localIndex.get(sm.id);
    // 内容脏或元数据脏：本地版胜出，服务端快照不得回退用户刚做的改动
    list.push((dirty.has(sm.id) || metaDirty.has(sm.id)) && local ? { ...local } : { ...sm });
  }

  const ghostIds: string[] = [];
  for (const [id, meta] of localIndex) {
    if (seen.has(id) || tombstones.has(id)) continue;
    const shared = scope.SHARED_BOARD_IDS.has(id);
    // 仅在成功水合过服务端列表后，才把「有服务端版本、非 dirty、服务端已无」判为幽灵
    if (!shared && serverHydrated && !dirty.has(id) && scope.hasServerVersion(id)) {
      ghostIds.push(id);
      continue;
    }
    seen.add(id);
    list.push({ ...meta });
  }

  for (const id of ghostIds) {
    const name = localIndex.get(id)?.name ?? id;
    localIndex.delete(id);
    serverIds.delete(id);
    dirty.delete(id);
    dispatchRemoteDeleted(id, name);
  }

  snapshot = list;
  persist();
  notify();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** useSyncExternalStore 的 getSnapshot：稳定引用，仅 recompute 时替换 */
export function getBoardList(): DeepDiveBoardMeta[] {
  return snapshot;
}

export function getState(): BoardStoreState {
  return { metas: snapshot, serverIds, dirty, metaDirty, tombstones };
}

/** 绑定作用域：迁移旧索引 → 载入 scoped 索引/墓碑/脏标记 → 重算 */
export function bindScope(scopeKey: scope.ScopeKey): void {
  if (boundScope === scopeKey) return;
  scope.setActiveScopeKey(scopeKey);
  scope.adoptLegacyIndex(scopeKey);
  boundScope = scopeKey;
  localIndex = new Map(scope.readScopedIndex(scopeKey).map((m) => [m.id, m]));
  tombstones = scope.loadTombstones(scopeKey);
  dirty = scope.readStringSet(scope.dirtyKey(scopeKey));
  metaDirty = scope.readStringSet(scope.metaDirtyKey(scopeKey));
  serverMetas = [];
  serverIds = new Set();
  serverHydrated = false;
  ghostsEmitted.clear();
  recompute();
}

/** 服务端列表水合；null/失败必须 no-op（离线不得清空缓存） */
export function hydrateFromServer(metas: DeepDiveBoardMeta[] | null): void {
  if (!Array.isArray(metas)) return;
  serverHydrated = true;
  const seen = new Set<string>();
  serverMetas = metas.filter((m) => {
    if (!m || typeof m.id !== 'string' || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  serverIds = new Set(serverMetas.map((m) => m.id));
  for (const sm of serverMetas) {
    if (tombstones.has(sm.id)) continue;
    const local = localIndex.get(sm.id);
    if ((dirty.has(sm.id) || metaDirty.has(sm.id)) && local) continue; // 本地有未同步改动，本地版胜出
    localIndex.set(sm.id, { ...sm });
  }
  recompute();
}

/** 本地保存后更新该条 meta；dirty 默认 true */
export function upsertLocal(meta: DeepDiveBoardMeta, opts?: { dirty?: boolean }): void {
  // 合并而非覆盖：内容保存路径传入的 meta 不含收藏/归档字段，直接覆盖会抹掉用户偏好
  const prev = localIndex.get(meta.id);
  localIndex.set(meta.id, prev ? { ...prev, ...meta } : { ...meta });
  if (opts?.dirty !== false) dirty.add(meta.id);
  recompute();
}

/**
 * Spec L1：本地更新画板库元数据（收藏/归档/改名），标 metaDirty 待后台 PATCH。
 * 不触碰内容 dirty，故不会触发整板上传；未知画板 no-op。
 */
export function updateMetaLocal(id: string, patch: Partial<DeepDiveBoardMeta>): void {
  const cur = localIndex.get(id);
  if (!cur) return;
  localIndex.set(id, { ...cur, ...patch });
  metaDirty.add(id);
  recompute();
}

/**
 * 服务端确认 meta 变更：清 metaDirty，并以服务端回包收敛权威字段（nodeCount 回包无此字段，
 * 保留本地值）。服务端回包的 updatedAt（触发器推进）同步写入列表，供内容保存推进乐观锁版本。
 */
export function confirmServerMeta(
  id: string,
  server: {
    title?: string;
    isFavorite?: boolean;
    isArchived?: boolean;
    folderId?: string | null;
    updatedAt?: string;
  }
): void {
  metaDirty.delete(id);
  const prev = localIndex.get(id);
  const parsedUpdatedAt = server.updatedAt ? Date.parse(server.updatedAt) : NaN;
  const meta: DeepDiveBoardMeta = {
    id,
    name: server.title ?? prev?.name ?? id,
    updatedAt: Number.isNaN(parsedUpdatedAt) ? prev?.updatedAt ?? Date.now() : parsedUpdatedAt,
    nodeCount: prev?.nodeCount ?? 0,
    isFavorite: server.isFavorite ?? prev?.isFavorite ?? false,
    isArchived: server.isArchived ?? prev?.isArchived ?? false,
    // null 是有效值（移出分组），不能用 ?? 把 null 吞成旧值
    folderId: server.folderId !== undefined ? server.folderId : prev?.folderId ?? null,
  };
  localIndex.set(id, meta);
  serverIds.add(id);
  serverMetas = serverMetas.map((m) => (m.id === id ? { ...meta } : m));
  if (!serverMetas.some((m) => m.id === id)) serverMetas = [{ ...meta }, ...serverMetas];
  recompute();
}

/** 服务端确认保存：清 dirty，并确保条目进入服务端集合（立即显示为已同步） */
export function confirmServerSave(id: string): void {
  dirty.delete(id);
  serverIds.add(id);
  // 刚保存成功：本地 meta 即最新服务端状态，置顶并替换（否则列表名/时间停留旧值）
  const meta = localIndex.get(id);
  if (meta) serverMetas = [{ ...meta }, ...serverMetas.filter((m) => m.id !== id)];
  recompute();
}

export function markDirty(id: string, value = true): void {
  if (value) dirty.add(id);
  else dirty.delete(id);
  recompute();
}

export function isDirty(id: string): boolean {
  return dirty.has(id);
}

export function getDirtyIds(): string[] {
  return Array.from(dirty);
}

export function addTombstone(id: string): void {
  tombstones.add(id);
  dirty.delete(id);
  metaDirty.delete(id);
  recompute();
}

/** 服务端删除确认（2xx/404）或本地草稿删除：清墓碑/索引/blob */
export function confirmServerDelete(id: string): void {
  tombstones.delete(id);
  localIndex.delete(id);
  serverIds.delete(id);
  serverMetas = serverMetas.filter((m) => m.id !== id);
  dirty.delete(id);
  metaDirty.delete(id);
  scope.purgeBoardBlobs(id);
  recompute();
}

/** 403 回滚：取消墓碑，画板重新可见（索引未删，天然可恢复） */
export function restoreFromTombstone(id: string): void {
  tombstones.delete(id);
  recompute();
}

/** Spec L1：删除分组后本地解除所有画板归属（服务端已 SET NULL） */
export function clearFolderOnBoards(folderId: string): void {
  let changed = false;
  for (const [id, meta] of localIndex) {
    if (meta.folderId === folderId) {
      localIndex.set(id, { ...meta, folderId: null });
      changed = true;
    }
  }
  if (changed) recompute();
}

/** 幽灵收敛：远端已删（save 404），移出列表、保留 blob */
export function reconcileRemoteDeletion(id: string): void {
  localIndex.delete(id);
  serverIds.delete(id);
  serverMetas = serverMetas.filter((m) => m.id !== id);
  dirty.delete(id);
  metaDirty.delete(id);
  tombstones.delete(id);
  recompute();
}

/** 游客→账号认领：把纯本地草稿并入当前 scope，标 dirty，清空 guest 索引 */
export function hydrateClaimedDrafts(metas: DeepDiveBoardMeta[], userId: string): void {
  if (!metas.length) return;
  for (const m of metas) {
    localIndex.set(m.id, { ...m });
    dirty.add(m.id);
  }
  // 只移除已认领条目，保留 guest 索引中其他条目（防误清数据）
  const claimed = new Set(metas.map((m) => m.id));
  const remainingGuest = scope.readScopedIndex('guest').filter((m) => !claimed.has(m.id));
  scope.writeScopedIndex(remainingGuest, 'guest');
  scope.markGuestClaimed(userId);
  recompute();
}

/** 仅供测试 */
export function resetForTest(): void {
  snapshot = EMPTY;
  serverMetas = [];
  serverIds = new Set();
  localIndex = new Map();
  tombstones = new Set();
  dirty = new Set();
  metaDirty = new Set();
  serverHydrated = false;
  boundScope = null;
  ghostsEmitted.clear();
  scope.setActiveScopeKey('guest');
}
