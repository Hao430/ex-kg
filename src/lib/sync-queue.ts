/**
 * Spec A5 — 断网重试队列 + 同步状态（框架无关核心，便于测试）
 *
 * 语义：
 * - enqueue(boardId)：待同步画布入队（去重），派发 'pending'
 * - flush：执行 executor；'ok' → 'saved'；'conflict' → 'conflict'（不重试）；
 *   'fail' → 退避重试 min(2^n × 2s, 30s)，超过 MAX_RETRIES 派发 'error'
 * - window 'online' 事件 → 立即 flush（断网恢复自动补传）
 */

export type SyncOutcome = 'ok' | 'conflict' | 'fail';
export type SyncState = 'pending' | 'saved' | 'conflict' | 'error';
export type SyncExecutor = (boardId: string) => Promise<SyncOutcome>;

export const MAX_RETRIES = 5;

const pending = new Map<string, number>(); // boardId -> attempts
let timer: ReturnType<typeof setTimeout> | null = null;
let nextFlushAt = 0;
const inFlight = new Set<string>(); // 正在执行 executor 的 boardId，防止并发双跑
let executor: SyncExecutor | null = null;
const listeners = new Set<(state: SyncState, boardId: string) => void>();
let onlineAttached = false;

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
  executor = fn;
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
    // 已有待执行 flush：若本次 deadline 更早，则重排
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
    pending.set(boardId, 0);
  }
  emit('pending', boardId);
  scheduleFlush(0);
  attachOnlineListener();
}

/**
 * 删除画板时移除其待同步任务（H1 竞态修复）：防止删除后自动保存把画板写回远端复活。
 * in-flight 的保存结果由 runOne 的 pending.has 检查丢弃；后端对已删除画布的 save
 * 也会拒绝（软删防复活），双保险。
 */
export function dequeue(boardId: string): void {
  pending.delete(boardId);
}

/** 断网恢复后立即补传；等待本次全部执行完成（runOne 内部不会抛出） */
export async function flush(): Promise<void> {
  if (pending.size === 0 || !executor) return;
  const ids = getPendingIds().filter((id) => !inFlight.has(id));
  await Promise.all(ids.map((id) => runOne(id)));
}

async function runOne(boardId: string): Promise<void> {
  if (inFlight.has(boardId)) return; // 同一画布并发去重
  if (!pending.has(boardId) || !executor) return;
  inFlight.add(boardId);
  try {
    let outcome: SyncOutcome;
    try {
      outcome = await executor(boardId);
    } catch (e) {
      console.error('sync executor threw:', e);
      outcome = 'fail';
    }

    if (!pending.has(boardId)) return; // 期间被移除

    if (outcome === 'ok') {
      pending.delete(boardId);
      emit('saved', boardId);
      return;
    }
    if (outcome === 'conflict') {
      pending.delete(boardId); // 冲突需用户介入，不自动重试
      emit('conflict', boardId);
      return;
    }

    const attempts = (pending.get(boardId) || 0) + 1;
    if (attempts >= MAX_RETRIES) {
      pending.delete(boardId);
      emit('error', boardId);
      return;
    }
    pending.set(boardId, attempts);
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
}
