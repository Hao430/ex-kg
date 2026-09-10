/**
 * L1 — sync-queue 一板多操作（ops[]）行为锁定
 *
 * 覆盖：meta 与 upload 共存、执行顺序（meta 先于 upload）、delete 独占压制、
 * 旧持久化格式（type）hydrate 兼容、多操作中单操作失败仅重试未完成项。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

import {
  enqueue,
  enqueueMeta,
  enqueueDelete,
  flush,
  getPendingIds,
  hasPending,
  hydrateQueue,
  isDeleteQueued,
  resetForTest,
  setBackoffBaseForTest,
  setSyncExecutor,
  setDeleteExecutor,
  setMetaExecutor,
  snapshotQueue,
  SyncOutcome,
} from '../src/lib/sync-queue.ts';

describe('L1 sync-queue 一板多操作', () => {
  let calls: string[];
  let uploadOutcome: SyncOutcome;
  let metaOutcome: SyncOutcome;
  let deleteOutcome: SyncOutcome;

  beforeEach(() => {
    resetForTest();
    setBackoffBaseForTest(10000);
    calls = [];
    uploadOutcome = 'ok';
    metaOutcome = 'ok';
    deleteOutcome = 'ok';
    setSyncExecutor(async (id) => {
      calls.push(`up:${id}`);
      return uploadOutcome;
    });
    setMetaExecutor(async (id) => {
      calls.push(`meta:${id}`);
      return metaOutcome;
    });
    setDeleteExecutor(async (id) => {
      calls.push(`del:${id}`);
      return deleteOutcome;
    });
  });
  afterEach(() => {
    resetForTest();
    setBackoffBaseForTest(2000);
  });

  test('meta 与 upload 共存：同板一个任务、两个 op；执行顺序 meta 先于 upload', async () => {
    enqueue('b');
    enqueueMeta('b');
    assert.deepEqual(getPendingIds(), ['b'], '同板只保留一个任务');
    assert.deepEqual(snapshotQueue()[0].ops.sort(), ['meta', 'upload']);

    await flush();
    assert.deepEqual(calls, ['meta:b', 'up:b']);
    assert.equal(hasPending('b'), false, '全部完成后任务出队');
  });

  test('delete 独占：压制同板 upload/meta，只执行 delete', async () => {
    enqueue('b');
    enqueueMeta('b');
    enqueueDelete('b');
    assert.equal(isDeleteQueued('b'), true);
    assert.deepEqual(snapshotQueue()[0].ops, ['delete']);

    await flush();
    assert.deepEqual(calls, ['del:b']);
  });

  test('delete 排队后新 enqueue / enqueueMeta 被忽略（防删后复活）', () => {
    enqueueDelete('b');
    enqueue('b');
    enqueueMeta('b');
    assert.deepEqual(snapshotQueue()[0].ops, ['delete']);
  });

  test('旧格式 hydrate（type 字段）归一为 ops 并分别派发', async () => {
    hydrateQueue([
      { boardId: 'a', type: 'upload', attempts: 0 },
      { boardId: 'b', type: 'delete', attempts: 0 },
    ] as any);
    assert.equal(hasPending('a'), true);
    assert.equal(isDeleteQueued('b'), true);

    await flush();
    assert.ok(calls.includes('up:a'));
    assert.ok(calls.includes('del:b'));
  });

  test('新格式 hydrate（ops 数组）保留多操作', async () => {
    hydrateQueue([{ boardId: 'a', ops: ['upload', 'meta'], attempts: 0 }] as any);
    await flush();
    assert.deepEqual(calls, ['meta:a', 'up:a']);
  });

  test('多操作中 upload 失败：仅重试 upload，已完成的 meta 不重复执行', async () => {
    uploadOutcome = 'fail';
    enqueue('b');
    enqueueMeta('b');

    await flush(); // meta ok 出列；upload fail 保留
    assert.deepEqual(calls, ['meta:b', 'up:b']);
    assert.equal(hasPending('b'), true);

    uploadOutcome = 'ok';
    await flush(); // 只重试 upload
    assert.deepEqual(calls, ['meta:b', 'up:b', 'up:b']);
    assert.equal(hasPending('b'), false);
  });
});
