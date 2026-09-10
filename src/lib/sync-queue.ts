/**
 * Spec A5 — 断网重试队列 + 同步状态（框架无关核心，便于测试）
 * 2026-09-10 扩展：任务类型（upload / delete）+ 持久化续跑（绑 scope 后写 localStorage，刷新不丢）。
 *
 * 语义：
 * - enqueue(boardId)：待上传画布入队（去重），派发 'pending'
 * - enqueueDelete(boardId)：待删除画布入队（服务端 DELETE），防删除后上传复活
 * - flush：执行对应 executor；'ok' → 'saved'；'conflict' → 'conflict'（不重试）；
 *   'fail' → 退避重试 min(2^n × 2s, 30s)，超过 MAX_RETRIES 派发 'error'
 * - window 'online' 事件 → 立即 flush（断网恢复自动补传）
 */
import * as boardScope from './board-scope';

export type SyncOutcome = 'ok' | 'conflict' | 'fail';
export type SyncState = 'pending' | 'saved' | 'conflict' | 'error';
export type SyncExecutor = (boardId: string) => Promise<SyncOutcome>;
export type QueueTaskType = 'upload' | 'delete';

export interface QueueTask {
  type: QueueTaskType;
  boardId: string;
  attempts: number;
}

export const MAX_RETRIES = 5;

/** boardId -> 任务（类型 + 尝试次数） */
const pending = new Map<string, QueueTask>();
let timer: ReturnType<typeof setTimeout> | null = null;
let nextFlushAt = 0;
const inFlight = new Set<string>();
let uploadExecutor: SyncExecutor | null = null;
let deleteExecutor: SyncExecutor | null = null;
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
  return pending.get(boardId)?.type === 'delete';
}

export function snapshotQueue(): QueueTask[] {
  return Array.from(pending.values()).map((t) => ({ ...t }));
}

/** 载入持久化任务（boot 续跑）：仅补入内存不自动 flush，由调用方 flush() */
export function hydrateQueue(tasks: QueueTask[]): void {
  if (!Array.isArray(tasks)) return;
  for (const t of tasks) {
    if (!t || typeof t.boardId !== 'string') continue;
    if (t.type !== 'upload' && t.type !== 'delete') continue;
    if (pending.has(t.boardId)) continue;
    pending.set(t.boardId, { type: t.type, boardId: t.boardId, attempts: Number(t.attempts) || 0 });
    emit('pending', t.boardId);
  }
  if (pending.size > 0) scheduleFlush(0);
  attachOnlineListener();
}

/** dirty 兜底：队列持久化写失败时，把脏画板补入上传队列 */
export function recoverDirtyDrafts(ids: string[]): void {
  for (const id of ids) {
    if (pending.has(id)) continue;
    pending.set(id, { type: 'upload', boardId: id, attempts: 0 });
    emit('pending', id);
  }
  if (pending.size > 0) scheduleFlush(0);
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

export function enqueue(boardId: string): void {
  if (!pending.has(boardId)) {
    pending.set(boardId, { type: 'upload', boardId, attempts: 0 });
    persist();
  }
  emit('pending', boardId);
  scheduleFlush(0);
  attachOnlineListener();
}

/** 删除入队：覆盖同 id 的待上传任务，杜绝「删了又被保存写回」 */
export function enqueueDelete(boardId: string): void {
  pending.set(boardId, { type: 'delete', boardId, attempts: 0 });
  persist();
  emit('pending', boardId);
  scheduleFlush(0);
  attachOnlineListener();
}

/**
 * 移除某画布的待同步任务（删除时调用；in-flight 结果由 runOne 的 pending 类型检查丢弃）。
 */
export function dequeue(boardId: string): void {
  if (pending.delete(boardId)) persist();
}

export function dequeueDelete(boardId: string): void {
  if (pending.get(boardId)?.type === 'delete') {
    pending.delete(boardId);
    persist();
  }
}

/** 断网恢复后立即补传；等待本次全部执行完成 */
export async function flush(): Promise<void> {
  if (pending.size === 0) return;
  const ids = getPendingIds().filter((id) => !inFlight.has(id));
  await Promise.all(ids.map((id) => runOne(id)));
}

async function runOne(boardId: string): Promise<void> {
  if (inFlight.has(boardId)) return;
  const task = pending.get(boardId);
  if (!task) return;
  const executor = task.type === 'delete' ? deleteExecutor : uploadExecutor;
  if (!executor) return;
  inFlight.add(boardId);
  try {
    let outcome: SyncOutcome;
    try {
      outcome = await executor(boardId);
    } catch (e) {
      console.error('sync executor threw:', e);
      outcome = 'fail';
    }

    const current = pending.get(boardId);
    if (!current || current.type !== task.type) return; // 期间被移除/改型

    if (outcome === 'ok') {
      pending.delete(boardId);
      persist();
      emit('saved', boardId);
      return;
    }
    if (outcome === 'conflict') {
      pending.delete(boardId);
      persist();
      emit('conflict', boardId);
      return;
    }

    const attempts = (current.attempts || 0) + 1;
    if (attempts >= MAX_RETRIES) {
      pending.delete(boardId);
      persist();
      emit('error', boardId);
      return;
    }
    current.attempts = attempts;
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
