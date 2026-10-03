/**
 * 画板本地作用域（scope）与旧键迁移（2026-09-10 画布列表/同步重构）。
 *
 * 目标：修「localStorage 不按账号隔离」——列表索引/墓碑/脏标记/待建/同步队列按 scope
 * 命名空间（guest 或 userId），画板内容 blob 仍按 UUIDv7 id 全局存放（id 不可枚举，
 * 列表不泄漏即内容不泄漏）。
 *
 * 2026-09-12 云优先收口后，**列表索引（indexKey）只是绘制缓存**：冷启动先把上次的画面
 * 画出来、以及游客认领时判定哪些是纯本地草稿；它不是真相，服务端列表一到即被整体替换
 * （见 board-store.recompute/hydrateFromServer）。真相判定不得再依赖此索引。
 *
 * 本模块保持零内部依赖，供 board-store / quota-store / sync-queue / storage 共享，避免循环引用。
 */
import type { DeepDiveBoardMeta } from '../types';

export type ScopeKey = string; // 'guest' | userId

const SCOPE_VERSION = 'deepdive_v2';

/**
 * 旧版「全局共享默认板」id：客户端曾把它硬编码成「新板 id」。
 * 阶段 5b（ADR-0018）起客户端不再用它新建画板——新板一律生成 uuidv7；只有存量用户、以及
 * 服务端私有化后的首个认领者，列表里才会再出现它（存量内容的再落位见 board-migrate.ts）。
 */
export const LEGACY_DEFAULT_BOARD_ID = 'default-board';

/** 全局共享默认画板 id：可见但不参与配额/认领/幽灵判定 */
export const SHARED_BOARD_IDS = new Set([LEGACY_DEFAULT_BOARD_ID, 'default-canvas']);

/** 旧版无作用域索引键（迁移来源） */
export const LEGACY_INDEX_KEYS = ['deepdive_boards_index_v1', 'rabbithole_boards_index_v1'];
const LEGACY_BACKUP_KEY = `${SCOPE_VERSION}:legacy_backup`;

/** 画板内容 blob 键前缀（全局，不随 scope 变化） */
export const BOARD_BLOB_PREFIX = 'deepdive_board_';
export const LEGACY_BOARD_BLOB_PREFIX = 'rabbithole_board_';
/** 服务端版本号小键前缀（全局） */
export const SERVER_TS_PREFIX = 'deepdive_board_server_ts_';
/** 节点级合并基线小键前缀（全局；ADR-0017 差分用，随画板删除一并清理，见 purgeBoardBlobs） */
export const BOARD_BASE_PREFIX = 'deepdive_board_base_';
/**
 * 已废弃的「冲突副本复用表」键前缀（`deepdive_conflict_copy_<源画板 id>`）。
 * 冲突副本机制已由 ADR-0025 整条删除，历史用户浏览器里可能残留这些孤儿键——
 * 在 bindScope 时清一次，见 `purgeLegacyConflictCopyKeys`。
 */
export const CONFLICT_COPY_KEY_PREFIX = 'deepdive_conflict_copy_';

let activeScope: ScopeKey = 'guest';

export function scopeKeyFor(userId: string | null | undefined): ScopeKey {
  return userId && String(userId).trim() ? String(userId) : 'guest';
}

export function getActiveScopeKey(): ScopeKey {
  return activeScope;
}

export function setActiveScopeKey(scope: ScopeKey): void {
  activeScope = scope;
}

export function scopedKey(base: string, scope: ScopeKey = activeScope): string {
  return `${SCOPE_VERSION}:${scope}:${base}`;
}

export function indexKey(scope?: ScopeKey): string {
  return scopedKey('boards_index', scope);
}
export function tombstonesKey(scope?: ScopeKey): string {
  return scopedKey('tombstones', scope);
}
export function dirtyKey(scope?: ScopeKey): string {
  return scopedKey('dirty', scope);
}
/** Spec L1：待同步的画板库元数据（收藏/归档）脏标记，与内容 dirty 分开 */
export function metaDirtyKey(scope?: ScopeKey): string {
  return scopedKey('meta_dirty', scope);
}
/** Spec L1：分组本地缓存（按 scope 隔离，离线可见） */
export function foldersKey(scope?: ScopeKey): string {
  return scopedKey('folders', scope);
}
/** Spec R1：练习历史本地缓存（按 scope 隔离，离线可见） */
export function quizCacheKey(scope?: ScopeKey): string {
  return scopedKey('quiz_cache', scope);
}
/** Spec R1：未提交的作答草稿（sessionStorage 之外的跨刷新草稿；按 scope 隔离） */
export function quizDraftKey(scope?: ScopeKey): string {
  return scopedKey('quiz_draft', scope);
}
export function pendingCreateKey(scope?: ScopeKey): string {
  return scopedKey('pending_creates', scope);
}
export function queueKey(scope?: ScopeKey): string {
  return scopedKey('sync_queue', scope);
}
export function legacyMarkerKey(scope: ScopeKey): string {
  return scopedKey('legacy_migrated', scope);
}

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const store = ls();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 配额/隐私模式下写失败：抛出由上层提示，绝不静默吞掉造成数据丢失
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** 本地持久化失败的通知节流间隔（配额抖动时避免刷屏） */
const PERSIST_FAILURE_NOTIFY_INTERVAL_MS = 60_000;
let lastPersistFailureAt = 0;

/**
 * 本地持久化失败上报：localStorage 写失败意味着**用户的编辑可能保不住**，必须让用户看见。
 * 旧实现只 console.error，UI 无感知。按 scope 调用，1 分钟节流；非浏览器环境静默降级为日志。
 */
export function reportPersistFailure(where: string, err: unknown): void {
  console.error(`[persist] ${where} failed:`, err);
  const now = Date.now();
  if (now - lastPersistFailureAt < PERSIST_FAILURE_NOTIFY_INTERVAL_MS) return;
  lastPersistFailureAt = now;
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('deepdive:local-persist-failed', { detail: { where } })
    );
  } catch {
    /* ignore */
  }
}

/** 仅供测试：重置节流窗口 */
export function resetPersistFailureThrottleForTest(): void {
  lastPersistFailureAt = 0;
}

export function readStringSet(key: string): Set<string> {
  const arr = readJson<string[]>(key, []);
  return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
}

export function writeStringSet(key: string, values: Iterable<string>): void {
  writeJson(key, Array.from(values));
}

export function readScopedIndex(scope?: ScopeKey): DeepDiveBoardMeta[] {
  const arr = readJson<DeepDiveBoardMeta[]>(indexKey(scope), []);
  return Array.isArray(arr) ? arr.filter((m) => m && typeof m.id === 'string') : [];
}

export function writeScopedIndex(metas: DeepDiveBoardMeta[], scope?: ScopeKey): void {
  writeJson(indexKey(scope), metas);
}

export function loadTombstones(scope?: ScopeKey): Set<string> {
  return readStringSet(tombstonesKey(scope));
}
export function saveTombstones(ids: Iterable<string>, scope?: ScopeKey): void {
  writeStringSet(tombstonesKey(scope), ids);
}

/** 画板是否存在服务端权威版本（用于区分「纯本地草稿」与「已同步」） */
export function hasServerVersion(boardId: string): boolean {
  const store = ls();
  if (!store) return false;
  try {
    return store.getItem(`${SERVER_TS_PREFIX}${boardId}`) != null;
  } catch {
    return false;
  }
}

/** 清除画板内容 blob 与版本小键（服务端已确认删除后调用） */
export function purgeBoardBlobs(boardId: string): void {
  const store = ls();
  if (!store) return;
  try {
    store.removeItem(`${BOARD_BLOB_PREFIX}${boardId}`);
    store.removeItem(`${LEGACY_BOARD_BLOB_PREFIX}${boardId}`);
    store.removeItem(`${SERVER_TS_PREFIX}${boardId}`);
    store.removeItem(`${BOARD_BASE_PREFIX}${boardId}`);
  } catch {
    /* ignore */
  }
}

/**
 * 清理已废弃的「冲突副本复用表」孤儿键（ADR-0025 删除了该机制）。
 * 幂等、按前缀扫描；localStorage 不可用或读键枚举失败时静默 no-op。
 * @returns 实际删除的键数（供测试断言）
 */
export function purgeLegacyConflictCopyKeys(): number {
  const store = ls();
  if (!store) return 0;
  let removed = 0;
  try {
    // 测试桩可能没有实现 length/key（只要能 get/set 即可满足其他用例），先判能力再枚举
    if (typeof store.length !== 'number' || typeof store.key !== 'function') return 0;
    // 先收集再删：边遍历边 removeItem 在部分实现下会跳键
    const victims: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(CONFLICT_COPY_KEY_PREFIX)) victims.push(key);
    }
    for (const key of victims) {
      store.removeItem(key);
      removed++;
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * 一次性旧键迁移：把旧版无作用域索引迁入首个绑定的 scope。
 * - 已有 scoped 索引 / 已迁移 / 无旧键 → no-op
 * - 旧索引解析成功后写 backup 再删除旧键；写 scoped 失败则保留旧键下次重试（不丢数据）
 */
export function adoptLegacyIndex(scope: ScopeKey): { migrated: boolean; count: number } {
  const store = ls();
  if (!store) return { migrated: false, count: 0 };
  try {
    if (store.getItem(legacyMarkerKey(scope)) === '1') return { migrated: false, count: 0 };
    if (store.getItem(indexKey(scope)) != null) {
      store.setItem(legacyMarkerKey(scope), '1');
      return { migrated: false, count: 0 };
    }
    let raw: string | null = null;
    for (const k of LEGACY_INDEX_KEYS) {
      const v = store.getItem(k);
      if (v != null) {
        raw = v;
        break;
      }
    }
    if (raw == null) {
      store.setItem(legacyMarkerKey(scope), '1');
      return { migrated: false, count: 0 };
    }
    let parsed: DeepDiveBoardMeta[];
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('legacy index not array');
    } catch {
      // 解析失败：原样不动，避免数据丢失
      return { migrated: false, count: 0 };
    }
    store.setItem(LEGACY_BACKUP_KEY, raw);
    writeScopedIndex(parsed, scope); // 失败会抛，旧键尚未删，下次重试
    for (const k of LEGACY_INDEX_KEYS) store.removeItem(k);
    store.setItem(legacyMarkerKey(scope), '1');
    return { migrated: true, count: parsed.length };
  } catch {
    return { migrated: false, count: 0 };
  }
}

/**
 * 游客 → 账号认领计划：只返回「纯本地草稿」（无服务端版本、非共享板），调用方执行迁移。
 * 不在此处 mutate，便于幂等与测试。
 */
export function planGuestClaim(userId: string): { claimable: DeepDiveBoardMeta[] } {
  if (scopeKeyFor(userId) === 'guest') return { claimable: [] };
  const guestMetas = readScopedIndex('guest');
  const claimable = guestMetas.filter(
    (m) => !SHARED_BOARD_IDS.has(m.id) && !hasServerVersion(m.id)
  );
  return { claimable };
}

/** 认领幂等标记：同一 (scope, userId) 只迁移一次 */
export function guestClaimMarkerKey(userId: string): string {
  return `${SCOPE_VERSION}:guest_claimed:${userId}`;
}
export function markGuestClaimed(userId: string): void {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(guestClaimMarkerKey(userId), '1');
  } catch {
    /* ignore */
  }
}
export function isGuestClaimed(userId: string): boolean {
  const store = ls();
  if (!store) return false;
  try {
    return store.getItem(guestClaimMarkerKey(userId)) === '1';
  } catch {
    return false;
  }
}

/**
 * 旧共享默认板存量再落位的幂等标记（阶段 5b，见 board-migrate.ts）：按账号只搬一次。
 * 与游客认领标记一样按 userId 而非 scope 命名——换账号登录是另一个人的一次迁移。
 */
export function defaultBoardMigratedKey(userId: string): string {
  return `${SCOPE_VERSION}:default_board_migrated:${userId}`;
}
export function markDefaultBoardMigrated(userId: string): void {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(defaultBoardMigratedKey(userId), '1');
  } catch {
    /* ignore */
  }
}
export function isDefaultBoardMigrated(userId: string): boolean {
  const store = ls();
  if (!store) return false;
  try {
    return store.getItem(defaultBoardMigratedKey(userId)) === '1';
  } catch {
    return false;
  }
}
