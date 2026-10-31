/**
 * Spec R1 — 做题记录保留期清理（内存模式）。
 *
 * 口径（2026-10-25 用户确认）：
 * - completed：按 completed_at（缺失回落 created_at）保留 180 天；
 * - in_progress：按 created_at 保留 24 小时（防止「点了出题从不交卷」永久堆积）；
 * - 0 = 全清；清理是跨租户系统任务，按时间而非用户。
 *
 * tests/ 只读：本文件为新增（用户 2026-10-25 授权）。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryStore } from '../server/core/memory-store.js';
import { cleanupOldQuizAttempts, createAttempt } from '../server/repositories/quiz.repository.js';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

async function seed(opts: {
  userId: string;
  status: 'completed' | 'in_progress';
  createdAgoMs: number;
  completedAgoMs?: number | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await createAttempt({
    id,
    userId: opts.userId,
    topic: '保留期主题',
    difficulty: 'beginner',
    questions: [],
    review: {},
  });
  const row = inMemoryStore.quizAttempts.get(id)!;
  row.status = opts.status;
  row.created_at = new Date(Date.now() - opts.createdAgoMs).toISOString();
  row.completed_at = opts.status === 'completed'
    ? (opts.completedAgoMs === null ? null : new Date(Date.now() - (opts.completedAgoMs ?? opts.createdAgoMs)).toISOString())
    : null;
  return id;
}

beforeEach(() => {
  inMemoryStore.quizAttempts.clear();
});

describe('R1 做题记录保留期', () => {
  test('completed 超 180 天、in_progress 超 24h 删除；新记录保留', async () => {
    const oldCompleted = await seed({ userId: 'u1', status: 'completed', createdAgoMs: 200 * DAY, completedAgoMs: 199 * DAY });
    const newCompleted = await seed({ userId: 'u1', status: 'completed', createdAgoMs: 10 * DAY, completedAgoMs: 9 * DAY });
    const oldInProgress = await seed({ userId: 'u2', status: 'in_progress', createdAgoMs: 25 * HOUR });
    const newInProgress = await seed({ userId: 'u2', status: 'in_progress', createdAgoMs: 1 * HOUR });
    // completed_at 缺失：按 created_at 判定
    const nullCompletedOld = await seed({ userId: 'u3', status: 'completed', createdAgoMs: 200 * DAY, completedAgoMs: null });

    const deleted = await cleanupOldQuizAttempts(180, 24);
    assert.equal(deleted, 3, '应删除两条旧 completed + 一条旧 in_progress');

    assert.equal(inMemoryStore.quizAttempts.has(oldCompleted), false);
    assert.equal(inMemoryStore.quizAttempts.has(oldInProgress), false);
    assert.equal(inMemoryStore.quizAttempts.has(nullCompletedOld), false);
    assert.equal(inMemoryStore.quizAttempts.has(newCompleted), true);
    assert.equal(inMemoryStore.quizAttempts.has(newInProgress), true);
  });

  test('跨用户都按时间清理（系统任务不是只清自己）', async () => {
    const a = await seed({ userId: 'alice', status: 'completed', createdAgoMs: 200 * DAY, completedAgoMs: 200 * DAY });
    const b = await seed({ userId: 'bob', status: 'completed', createdAgoMs: 200 * DAY, completedAgoMs: 200 * DAY });

    assert.equal(await cleanupOldQuizAttempts(180, 24), 2);
    assert.equal(inMemoryStore.quizAttempts.has(a), false);
    assert.equal(inMemoryStore.quizAttempts.has(b), false);
  });

  test('0 表示全清', async () => {
    await seed({ userId: 'u1', status: 'completed', createdAgoMs: 1 * DAY, completedAgoMs: 1 * DAY });
    await seed({ userId: 'u2', status: 'in_progress', createdAgoMs: 1 * HOUR });

    assert.equal(await cleanupOldQuizAttempts(0, 0), 2);
    assert.equal(inMemoryStore.quizAttempts.size, 0);
  });
});
