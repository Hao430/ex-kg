/**
 * 画板列表：服务端快照（唯一真相）+ 本地未确认缓冲（乐观显示）。
 *
 * 2026-09-12 云优先收口（画板同步重构阶段 4b）：
 * - **真相只有服务端**。列表 = 服务端快照，叠加「服务端尚未确认」的本地 meta（内容 dirty /
 *   meta dirty / 纯本地草稿）。本地不再有「胜出」裁决——服务端确认过的字段只能由服务端回包
 *   推进；旧实现的 `confirmServerSave` 拿本地 meta 顶替服务端条目，正是这条残留。
 * - localStorage 索引降级为**绘制缓存**：冷启动先出画面、游客认领判定要用它，但它不参与裁决。
 *   服务端列表一到就整体替换，曾同步过（有版本小键）却不在快照里的条目 = 他端已删 → 收敛并提示。
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

/** 服务端确认保存后回传的权威字段（取 save 响应，缺字段则保留快照原值） */
export interface ServerConfirm {
  title?: string;
  nodeCount?: number;
  updatedAt?: string;
}

const EMPTY: DeepDiveBoardMeta[] = Object.freeze([]) as unknown as DeepDiveBoardMeta[];

let snapshot: DeepDiveBoardMeta[] = EMPTY;
/** 服务端快照（真相 + 顺序基准）。冷启动时暂由绘制缓存填充，水合后整体替换 */
let serverMetas: DeepDiveBoardMeta[] = [];
let serverIds = new Set<string>();
/**
 * 未确认缓冲：本地已改但服务端还没确认的 meta。
 * - 服务端已知的画板：只存「待上行的那份 meta」，展示时叠加在服务端快照之上
 * - 服务端未知的画板（纯本地草稿 / 游客板 / 认领后待上传）：整条都在这里
 * 服务端一确认（confirmServerSave / confirmServerMeta）就出列，本地投影绝不留存为真相。
 */
let pending = new Map<string, DeepDiveBoardMeta>();
let dirty = new Set<string>();
/** Spec L1：收藏/归档等元数据待同步（与内容 dirty 分离，避免触发全量上传） */
let metaDirty = new Set<string>();
let tombstones = new Set<string>();
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
    // localStorage 配额/隐私模式：必须让用户看见（dirty 标记丢失会导致改动静默消失）
    scope.reportPersistFailure('board-store', e);
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

/** 本地当前认知里该画板的 meta：未确认缓冲优先，其次服务端快照 */
function currentMeta(id: string): DeepDiveBoardMeta | null {
  return pending.get(id) ?? serverMetas.find((m) => m.id === id) ?? null;
}

/**
 * 服务端快照（顺序基准）+ 未确认缓冲 → 展示投影。
 * 服务端已确认的条目，只有未确认缓冲能改写其展示字段；缓冲出列后即回到服务端值。
 */
function recompute(): void {
  const list: DeepDiveBoardMeta[] = [];
  const seen = new Set<string>();

  for (const sm of serverMetas) {
    if (tombstones.has(sm.id)) continue;
    seen.add(sm.id);
    const overlay = pending.get(sm.id);
    // isShared 是服务端授权口径（ADR-0018），**必须**在叠加后强制回服务端值：
    // 本地缓冲里可能是旧版本写下的（或旧服务端缺字段时的默认值），让它盖住就是客户端替我
    // 们决定授权——private 模式下会把认领者自己的板锁成共享板。
    list.push(overlay ? { ...sm, ...overlay, isShared: sm.isShared } : { ...sm });
  }

  // 服务端还不知道的条目（纯本地草稿 / 游客板 / 认领后待上传）
  for (const [id, meta] of pending) {
    if (seen.has(id) || tombstones.has(id)) continue;
    list.push({ ...meta });
  }

  serverIds = new Set(serverMetas.map((m) => m.id));
  snapshot = list;
  persist();
  notify();
}

/**
 * 缓存收敛判据：曾同步过（有服务端版本小键）、本次服务端快照里没有、且本地没有未确认改动
 * 的条目 = 他端已删。纯本地草稿（无版本小键）服务端本就不该有，不收敛；共享默认板不收敛。
 */
function isRemoteDeleted(id: string, serverIdsNow: ReadonlySet<string>): boolean {
  if (serverIdsNow.has(id) || tombstones.has(id)) return false;
  if (scope.SHARED_BOARD_IDS.has(id)) return false;
  if (dirty.has(id) || metaDirty.has(id)) return false; // 有未确认改动：等上传，不当作已删
  return scope.hasServerVersion(id);
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

/** 绑定作用域：迁移旧索引 → 载入绘制缓存/墓碑/脏标记 → 按「是否已同步」拆成快照与未确认缓冲 */
export function bindScope(scopeKey: scope.ScopeKey): void {
  if (boundScope === scopeKey) return;
  scope.setActiveScopeKey(scopeKey);
  scope.adoptLegacyIndex(scopeKey);
  boundScope = scopeKey;
  tombstones = scope.loadTombstones(scopeKey);
  dirty = scope.readStringSet(scope.dirtyKey(scopeKey));
  metaDirty = scope.readStringSet(scope.metaDirtyKey(scopeKey));
  serverMetas = [];
  pending = new Map();
  for (const m of scope.readScopedIndex(scopeKey)) {
    const entry = { ...m };
    if (dirty.has(entry.id) || metaDirty.has(entry.id) || !scope.hasServerVersion(entry.id)) {
      pending.set(entry.id, entry);
    } else {
      serverMetas.push(entry); // 暂定快照：等 fetchBoardListFromServer 用服务端列表替换
    }
  }
  ghostsEmitted.clear();
  recompute();
}

/** 服务端列表水合；null/失败必须 no-op（离线不得清空缓存） */
export function hydrateFromServer(metas: DeepDiveBoardMeta[] | null): void {
  if (!Array.isArray(metas)) return;
  const seen = new Set<string>();
  const next = metas.filter((m) => {
    if (!m || typeof m.id !== 'string' || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  const nextIds = new Set(next.map((m) => m.id));

  // 整体替换前先收敛：曾同步过却不在新快照里的条目（他端删除）
  const removed: DeepDiveBoardMeta[] = [];
  for (const sm of serverMetas) {
    if (isRemoteDeleted(sm.id, nextIds)) removed.push(sm);
  }
  for (const [id, meta] of pending) {
    if (isRemoteDeleted(id, nextIds)) removed.push(meta);
  }
  for (const m of removed) {
    pending.delete(m.id);
    dirty.delete(m.id);
    metaDirty.delete(m.id);
    dispatchRemoteDeleted(m.id, m.name ?? m.id);
  }

  serverMetas = next;
  // 服务端未确认的本地改动留在缓冲里，等各自的上行链路确认
  recompute();
}

/**
 * 本地保存后更新该条 meta；dirty 默认 true（进未确认缓冲，等服务端确认）。
 *
 * `dirty: false` 只在「本地内容就是服务端那份」时使用（采用服务端版落盘等）：此时若该板已同步，
 * 直接写服务端快照——留在缓冲里会变成一份永不失效的陈旧覆盖，他端改名再也显示不出来。
 */
export function upsertLocal(meta: DeepDiveBoardMeta, opts?: { dirty?: boolean }): void {
  const unsynced = opts?.dirty !== false;
  // 合并而非覆盖：内容保存路径传入的 meta 不含收藏/归档字段，直接覆盖会抹掉用户偏好
  const prev = currentMeta(meta.id);
  const next = prev ? { ...prev, ...meta } : { ...meta };
  if (unsynced || !scope.hasServerVersion(meta.id)) {
    pending.set(meta.id, next);
  } else {
    serverMetas = [next, ...serverMetas.filter((m) => m.id !== meta.id)];
  }
  if (unsynced) dirty.add(meta.id);
  recompute();
}

/**
 * 采用服务端内容后写回该条 meta：条目归入**服务端快照**，不进未确认缓冲。
 *
 * 与 `upsertLocal(..., {dirty:false})` 的区别是显式的：这里的内容来源就是服务端（fetch 落盘 /
 * 冲突后采用服务端版），不是「本地改完还没传」。靠 `hasServerVersion` 小键去猜来源的话，
 * 新设备首次拉取（版本小键尚未写入）会被误判成本地草稿，留成一份永不失效的陈旧覆盖。
 */
export function upsertServerMeta(meta: DeepDiveBoardMeta): void {
  const prev = currentMeta(meta.id);
  serverMetas = [{ ...prev, ...meta }, ...serverMetas.filter((m) => m.id !== meta.id)];
  recompute();
}

/**
 * Spec L1：本地更新画板库元数据（收藏/归档/改名），标 metaDirty 待后台 PATCH。
 * 不触碰内容 dirty，故不会触发整板上传；未知画板 no-op。
 */
export function updateMetaLocal(id: string, patch: Partial<DeepDiveBoardMeta>): void {
  const cur = currentMeta(id);
  if (!cur) return;
  pending.set(id, { ...cur, ...patch });
  metaDirty.add(id);
  recompute();
}

/**
 * 服务端确认 meta 变更：清 metaDirty、出未确认缓冲，并以服务端回包收敛权威字段
 * （nodeCount 回包无此字段，保留快照值）。updatedAt 同步写入列表，供内容保存推进乐观锁版本。
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
  const local = pending.get(id);
  // 内容侧仍未确认（dirty）时保留缓冲，否则出列
  if (!dirty.has(id)) pending.delete(id);
  const prev = serverMetas.find((m) => m.id === id);
  const parsedUpdatedAt = server.updatedAt ? Date.parse(server.updatedAt) : NaN;
  const meta: DeepDiveBoardMeta = {
    id,
    name: server.title ?? prev?.name ?? local?.name ?? id,
    updatedAt: Number.isNaN(parsedUpdatedAt)
      ? prev?.updatedAt ?? local?.updatedAt ?? Date.now()
      : parsedUpdatedAt,
    nodeCount: prev?.nodeCount ?? local?.nodeCount ?? 0,
    isFavorite: server.isFavorite ?? prev?.isFavorite ?? local?.isFavorite ?? false,
    isArchived: server.isArchived ?? prev?.isArchived ?? local?.isArchived ?? false,
    // null 是有效值（移出分组），不能用 ?? 把 null 吞成旧值
    folderId:
      server.folderId !== undefined ? server.folderId : prev?.folderId ?? local?.folderId ?? null,
    // isShared 是服务端授权口径（ADR-0018），本地缓冲不得改写：只跟随上一个服务端快照值
    isShared: prev?.isShared,
  };
  serverMetas = [meta, ...serverMetas.filter((m) => m.id !== id)];
  recompute();
}

/**
 * 服务端确认保存：清 dirty、出未确认缓冲，条目归入服务端快照并置顶。
 *
 * **字段以服务端回包为准**（`confirmServer`）：本地投影只代表「我以为的」，服务端才是真相——
 * 拿本地 meta 顶替服务端条目会让「他端改名 + 本端保存」把列表名永久停在旧值上。
 * 回包缺字段（旧路径/测试）时保留快照原值，都没有才退回本地（新建板第一次保存）。
 */
export function confirmServerSave(id: string, server?: ServerConfirm): void {
  dirty.delete(id);
  const local = pending.get(id);
  if (!metaDirty.has(id)) pending.delete(id); // 元数据仍有未确认改动时保留缓冲（见下）
  const prev = serverMetas.find((m) => m.id === id);
  const parsedUpdatedAt = server?.updatedAt ? Date.parse(server.updatedAt) : NaN;
  const meta: DeepDiveBoardMeta = {
    id,
    name: server?.title ?? prev?.name ?? local?.name ?? id,
    updatedAt: Number.isNaN(parsedUpdatedAt)
      ? prev?.updatedAt ?? local?.updatedAt ?? Date.now()
      : parsedUpdatedAt,
    nodeCount: server?.nodeCount ?? prev?.nodeCount ?? local?.nodeCount ?? 0,
    isFavorite: prev?.isFavorite ?? local?.isFavorite ?? false,
    isArchived: prev?.isArchived ?? local?.isArchived ?? false,
    folderId: prev?.folderId ?? local?.folderId ?? null,
    isShared: prev?.isShared, // 服务端口径，本地投影不得改写（ADR-0018）
  };
  if (metaDirty.has(id) && local) {
    // 改名/收藏的 PATCH 还没落：内容保存的回包里没有这些改动，用本地未确认值顶住。
    // 丢掉它不只是显示回退——meta 执行器是从列表读 PATCH body 的，会把改名一起吞掉。
    meta.name = local.name ?? meta.name;
    meta.isFavorite = local.isFavorite ?? meta.isFavorite;
    meta.isArchived = local.isArchived ?? meta.isArchived;
    meta.folderId = local.folderId !== undefined ? local.folderId : meta.folderId;
  }
  serverMetas = [meta, ...serverMetas.filter((m) => m.id !== id)];
  recompute();
}

export function markDirty(id: string, value = true): void {
  if (value) {
    dirty.add(id);
  } else {
    dirty.delete(id);
    // 内容已与服务端一致：这条不该再留未确认投影——留着会永久遮蔽服务端后续的改名/计数更新
    // （除非还有未确认的 meta 改动，那部分仍要顶住，等 PATCH 确认）
    if (!metaDirty.has(id) && scope.hasServerVersion(id)) pending.delete(id);
  }
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

/**
 * 本地摘除一条条目：出列（含未确认缓冲）、清 dirty/metaDirty、清内容 blob，不留墓碑、不上行。
 * 两个调用方语义不同但动作一致：
 * - 服务端删除确认（2xx/404）：这条画板已经没了；
 * - 阶段 5b：旧共享默认板的内容已搬到自己新板，这条缓存已不属于本账号（见 board-migrate.ts）。
 */
export function dropLocalEntry(id: string): void {
  tombstones.delete(id);
  pending.delete(id);
  serverMetas = serverMetas.filter((m) => m.id !== id);
  dirty.delete(id);
  metaDirty.delete(id);
  scope.purgeBoardBlobs(id);
  recompute();
}

/** 服务端删除确认（2xx/404）或本地草稿删除 */
export function confirmServerDelete(id: string): void {
  dropLocalEntry(id);
}

/** 403 回滚：取消墓碑，画板重新可见（缓冲/快照未删，天然可恢复） */
export function restoreFromTombstone(id: string): void {
  tombstones.delete(id);
  recompute();
}

/** Spec L1：删除分组后本地解除所有画板归属（服务端已 SET NULL，属已确认状态，故不标脏） */
export function clearFolderOnBoards(folderId: string): void {
  let changed = false;
  const clear = (m: DeepDiveBoardMeta): DeepDiveBoardMeta => {
    if (m.folderId !== folderId) return m;
    changed = true;
    return { ...m, folderId: null };
  };
  serverMetas = serverMetas.map(clear);
  for (const [id, m] of pending) {
    const next = clear(m);
    if (next !== m) pending.set(id, next);
  }
  if (changed) recompute();
}

/** 幽灵收敛：远端已删（save 404），移出列表、保留 blob */
export function reconcileRemoteDeletion(id: string): void {
  pending.delete(id);
  serverMetas = serverMetas.filter((m) => m.id !== id);
  dirty.delete(id);
  metaDirty.delete(id);
  tombstones.delete(id);
  recompute();
}

/** 游客→账号认领：把纯本地草稿并入当前 scope 的未确认缓冲，标 dirty，清空 guest 索引 */
export function hydrateClaimedDrafts(metas: DeepDiveBoardMeta[], userId: string): void {
  if (!metas.length) return;
  for (const m of metas) {
    pending.set(m.id, { ...m });
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
  pending = new Map();
  tombstones = new Set();
  dirty = new Set();
  metaDirty = new Set();
  boundScope = null;
  ghostsEmitted.clear();
  scope.setActiveScopeKey('guest');
}
