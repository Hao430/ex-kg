/**
 * Spec A5 — 断网重试队列 + 同步状态（框架无关核心，便于测试）
 * 2026-09-10 扩展：任务类型（upload / delete）+ 持久化续跑（绑 scope 后写 localStorage，刷新不丢）。
 * 2026-09-10 Spec L1 扩展：一板多操作（ops[]）——收藏/归档的 meta PATCH 可与内容 upload 共存；
 *   delete 独占并压制其余（防删除后复活）。
 *
 * 语义：
 * - enqueue(boardId)：待上传画布入队（去重），派发 'pending'
 * - enqueueMeta(boardId)：画板库元数据（收藏/归档）待同步，可与 upload 共存
 * - enqueueDelete(boardId)：待删除画布入队（服务端 DELETE），独占压制 upload/meta
 * - flush：按 delete→meta→upload 顺序执行对应 executor；'ok' → 'saved'；'conflict' → 'conflict'（不重试）；
 *   'fail' → 退避重试 min(2^n × 2s, 30s)，超过 MAX_RETRIES 派发 'error'
 * - window 'online' 事件 → 立即 flush（断网恢复自动补传）
 */
import * as boardScope from './board-scope';

export type SyncOutcome = 'ok' | 'conflict' | 'fail';
export type SyncState = 'pending' | 'saved' | 'conflict' | 'error';
/** 执行器可选参数：keepalive = 页面卸载前的最后补传（请求需在页面消失后仍送达） */
export interface SyncExecOpts {
  keepalive?: boolean;
}
export type SyncExecutor = (boardId: string, opts?: SyncExecOpts) => Promise<SyncOutcome>;
export type QueueOp = 'upload' | 'delete' | 'meta';
/** @deprecated 兼容旧字段命名（新代码用 QueueOp） */
export type QueueTaskType = QueueOp;

export interface QueueTask {
  boardId: string;
  /** 待执行操作集合；delete 存在时其余操作被忽略（hydrate 时归一为 ['delete']） */
  ops: QueueOp[];
  attempts: number;
  /** 已派发过 error 提示：转入慢速自愈后不再重复打扰用户（成功后清除） */
  errorNotified?: boolean;
}

/** 旧持久化格式（一板一 type），hydrateQueue 兼容归一 */
interface LegacyQueueTask {
  boardId: string;
  type?: QueueOp;
  ops?: QueueOp[];
  attempts?: number;
}

export const MAX_RETRIES = 5;

/**
 * 快退避耗尽后的**慢速自愈**间隔。
 * 旧行为：耗尽即把任务移出队列并停摆，只能等下次启动 `recoverDirtyDrafts` 补传——
 * 页面长时间挂着 + 网络反复抖动 = 「半天不上传」。现改为保留任务、按此间隔持续重试。
 * 只对 'fail'（网络/5xx）生效；'conflict' 是用户决策路径，仍不自动重试。
 */
export const ERROR_RETRY_MS = 60_000;

/** boardId -> 任务（操作集合 + 尝试次数） */
const pending = new Map<string, QueueTask>();
let timer: ReturnType<typeof setTimeout> | null = null;
let nextFlushAt = 0;
const inFlight = new Set<string>();
let uploadExecutor: SyncExecutor | null = null;
let deleteExecutor: SyncExecutor | null = null;
let metaExecutor: SyncExecutor | null = null;
const listeners = new Set<(state: SyncState, boardId: string) => void>();
let onlineAttached = false;
/** 绑定 scope 后才持久化；未绑定（如既有单测）零 localStorage 访问 */
let boundScope: boardScope.ScopeKey | null = null;

export function bindQueueScope(scope: boardScope.ScopeKey): void {
  boundScope = scope;
}

function persist(): void {
  if (!boundScope) return;
  try {
    boardScope.writeJson(boardScope.queueKey(boundScope), snapshotQueue());
  } catch (e) {
    console.error('sync-queue persist failed:', e);
  }
}

function emit(state: SyncState, boardId: string): void {
  for (const cb of listeners) {
    try {
      cb(state, boardId);
    } catch (e) {
      console.error('sync-queue listener error:', e);
    }
  }
}

export function setSyncExecutor(fn: SyncExecutor): void {
  uploadExecutor = fn;
}

export function setDeleteExecutor(fn: SyncExecutor): void {
  deleteExecutor = fn;
}

/** Spec L1：meta（收藏/归档）执行器 */
export function setMetaExecutor(fn: SyncExecutor): void {
  metaExecutor = fn;
}

function executorFor(op: QueueOp): SyncExecutor | null {
  if (op === 'delete') return deleteExecutor;
  if (op === 'meta') return metaExecutor;
  return uploadExecutor;
}

/** 执行优先级：delete 压制一切；内容上传前先落 meta（先拿服务端最新 updated_at，避免无谓 409） */
const OP_ORDER: QueueOp[] = ['delete', 'meta', 'upload'];
function orderedOps(ops: QueueOp[]): QueueOp[] {
  return OP_ORDER.filter((op) => ops.includes(op));
}

export function onSyncState(cb: (state: SyncState, boardId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPendingIds(): string[] {
  return Array.from(pending.keys());
}

export function hasPending(boardId: string): boolean {
  return pending.has(boardId);
}

export function isDeleteQueued(boardId: string): boolean {
  return pending.get(boardId)?.ops.includes('delete') ?? false;
}

/**
 * 持久化快照。**刻意不落 errorNotified**：进程重启是新的会话，队列若仍失败，
 * 用户有权再被提醒一次；持久化它反而会让「一直没传上去」变成无声状态。
 */
export function snapshotQueue(): QueueTask[] {
  return Array.from(pending.values()).map((t) => ({
    boardId: t.boardId,
    ops: [...t.ops],
    attempts: t.attempts,
  }));
}

/** 载入持久化任务（boot 续跑）：仅补入内存不自动 flush，由调用方 flush() */
export function hydrateQueue(tasks: LegacyQueueTask[]): void {
  if (!Array.isArray(tasks)) return;
  for (const t of tasks) {
    if (!t || typeof t.boardId !== 'string') continue;
    const rawOps: unknown[] = Array.isArray(t.ops) ? t.ops : [t.type];
    let ops = rawOps.filter(
      (o): o is QueueOp => o === 'upload' || o === 'delete' || o === 'meta'
    );
    if (ops.length === 0) continue;
    if (ops.includes('delete')) ops = ['delete']; // 删除独占，压制其余（含旧格式误共存）

    const existing = pending.get(t.boardId);
    if (existing) {
      for (const op of ops) if (!existing.ops.includes(op)) existing.ops.push(op);
      if (existing.ops.includes('delete')) existing.ops = ['delete'];
      continue;
    }
    pending.set(t.boardId, { boardId: t.boardId, ops, attempts: Number(t.attempts) || 0 });
    emit('pending', t.boardId);
  }
  if (pending.size > 0) scheduleFlush(0);
  attachOnlineListener();
}

/** dirty 兜底：队列持久化写失败时，把脏画板补入上传队列 */
export function recoverDirtyDrafts(ids: string[]): void {
  for (const id of ids) {
    const task = pending.get(id);
    if (task) {
      if (!task.ops.includes('upload') && !task.ops.includes('delete')) {
        task.ops.push('upload');
        emit('pending', id);
      }
      continue;
    }
    pending.set(id, { boardId: id, ops: ['upload'], attempts: 0 });
    emit('pending', id);
  }
  if (pending.size > 0) {
    persist();
    scheduleFlush(0);
  }
  attachOnlineListener();
}

let baseBackoffMs = 2000;

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * baseBackoffMs, 30000);
}

/** 仅供测试：缩小退避基准，避免真实定时器拖慢用例 */
export function setBackoffBaseForTest(ms: number): void {
  baseBackoffMs = ms;
}

function scheduleFlush(delayMs: number): void {
  const at = Date.now() + delayMs;
  if (timer !== null) {
    if (at < nextFlushAt) {
      clearTimeout(timer);
      timer = setTimeout(runFlush, delayMs);
      nextFlushAt = at;
    }
    return;
  }
  timer = setTimeout(runFlush, delayMs);
  nextFlushAt = at;
}

async function runFlush(): Promise<void> {
  timer = null;
  nextFlushAt = 0;
  await flush();
}

/** 入队一个操作；delete 已排队时新操作被压制（删除后不得复活） */
function addOp(boardId: string, op: 'upload' | 'meta'): void {
  const task = pending.get(boardId);
  if (task) {
    if (task.ops.includes('delete')) {
      emit('pending', boardId);
      attachOnlineListener();
      return;
    }
    if (!task.ops.includes(op)) {
      task.ops.push(op);
      persist();
    }
  } else {
    pending.set(boardId, { boardId, ops: [op], attempts: 0 });
    persist();
  }
  emit('pending', boardId);
  scheduleFlush(0);
  attachOnlineListener();
}

export function enqueue(boardId: string): void {
  addOp(boardId, 'upload');
}

/** Spec L1：收藏/归档等元数据入队（可与 upload 共存） */
export function enqueueMeta(boardId: string): void {
  addOp(boardId, 'meta');
}

/** 删除入队：独占任务，覆盖/压制同 id 的待上传与 meta，杜绝「删了又被写回」 */
export function enqueueDelete(boardId: string): void {
  pending.set(boardId, { boardId, ops: ['delete'], attempts: 0 });
  persist();
  emit('pending', boardId);
  scheduleFlush(0);
  attachOnlineListener();
}

/**
 * 移除某画布的待同步任务（删除时调用；in-flight 结果由 runOne 的 pending 检查丢弃）。
 */
export function dequeue(boardId: string): void {
  if (pending.delete(boardId)) persist();
}

export function dequeueDelete(boardId: string): void {
  if (pending.get(boardId)?.ops.includes('delete')) {
    pending.delete(boardId);
    persist();
  }
}

/** 断网恢复后立即补传；等待本次全部执行完成 */
export async function flush(opts?: SyncExecOpts): Promise<void> {
  if (pending.size === 0) return;
  const ids = getPendingIds().filter((id) => !inFlight.has(id));
  await Promise.all(ids.map((id) => runOne(id, opts)));
}

/**
 * 页面隐藏/卸载前的最后补传：透传 keepalive，让请求在页面消失后仍能送达
 * （旧实现用普通 fetch，浏览器会掐掉，注释写的「尽力 flush」实际保不住）。
 * 单次尝试、不等待、失败不重试——本地 blob 与 dirty 已落盘，持久化队列会在下次启动续跑。
 */
export function flushForPageHide(): void {
  void flush({ keepalive: true });
}

async function runOne(boardId: string, opts?: SyncExecOpts): Promise<void> {
  if (inFlight.has(boardId)) return;
  const task = pending.get(boardId);
  if (!task) return;
  // 尚无任何可执行 executor（如单测只接线了 upload）：不占用 in-flight，留待接线后重试
  if (!task.ops.some((op) => executorFor(op))) return;

  inFlight.add(boardId);
  let anyFail = false;
  try {
    for (const op of orderedOps([...task.ops])) {
      const current = pending.get(boardId);
      if (!current || !current.ops.includes(op)) continue; // 期间被移除
      if (op !== 'delete' && current.ops.includes('delete')) continue; // 删除压制其余

      const executor = executorFor(op);
      if (!executor) {
        anyFail = true;
        continue;
      }

      let outcome: SyncOutcome;
      try {
        outcome = await executor(boardId, opts);
      } catch (e) {
        console.error('sync executor threw:', e);
        outcome = 'fail';
      }

      const after = pending.get(boardId);
      if (!after || !after.ops.includes(op)) continue; // 期间被移除/改型，丢弃本次结果

      if (outcome === 'ok') {
        after.ops = after.ops.filter((o) => o !== op);
        after.errorNotified = false; // 自愈成功，恢复正常节奏
        emit('saved', boardId);
      } else if (outcome === 'conflict') {
        after.ops = after.ops.filter((o) => o !== op);
        emit('conflict', boardId);
      } else {
        anyFail = true;
      }
    }

    const final = pending.get(boardId);
    if (!final) {
      persist();
      return;
    }
    if (final.ops.length === 0) {
      pending.delete(boardId);
      persist();
      return;
    }
    // 执行期间任务被追加（如上传途中又收藏）：立即再排一次，避免遗漏
    if (!anyFail && final.ops.some((op) => executorFor(op))) {
      persist();
      scheduleFlush(0);
      return;
    }
    if (!anyFail) {
      persist();
      return;
    }

    // 已进入慢速自愈：不再走快速退避，只按固定长间隔重试（防重试风暴）
    if (final.errorNotified) {
      persist();
      scheduleFlush(ERROR_RETRY_MS);
      return;
    }
    const attempts = (final.attempts || 0) + 1;
    if (attempts >= MAX_RETRIES) {
      // 快退避耗尽：保留任务、转入慢速自愈（旧行为是移出队列停摆，只能等下次启动补传）
      final.attempts = 0;
      final.errorNotified = true;
      persist();
      emit('error', boardId);
      scheduleFlush(ERROR_RETRY_MS);
      return;
    }
    final.attempts = attempts;
    persist();
    scheduleFlush(backoffMs(attempts));
  } finally {
    inFlight.delete(boardId);
  }
}

function attachOnlineListener(): void {
  if (onlineAttached || typeof window === 'undefined') return;
  onlineAttached = true;
  window.addEventListener('online', () => flush());
}

/** 仅供测试：清空内部状态 */
export function resetForTest(): void {
  pending.clear();
  inFlight.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  nextFlushAt = 0;
  listeners.clear();
  boundScope = null;
}
