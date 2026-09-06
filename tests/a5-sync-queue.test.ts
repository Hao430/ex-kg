/**
 * Spec A5 — 重试队列行为测试（确定性驱动：不依赖定时器，手动 flush 推进）
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// node:test 环境无 window；sync-queue 对 window 做了存在性守卫，这里补一个最小 stub 以覆盖 online 分支
const onlineListeners: ((...args: any[]) => void)[] = [];
(globalThis as any).window = {
  addEventListener: (type: string, cb: (...args: any[]) => void) => {
    if (type === 'online') onlineListeners.push(cb);
  },
  removeEventListener: () => {},
};

import {
  enqueue,
  flush,
  getPendingIds,
  hasPending,
  MAX_RETRIES,
  onSyncState,
  resetForTest,
  setBackoffBaseForTest,
  setSyncExecutor,
  SyncOutcome,
  SyncState,
} from '../src/lib/sync-queue.ts';

describe('A5 重试队列', () => {
  let events: Array<{ state: SyncState; boardId: string }>;
  let executorCalls: string[];

  beforeEach(() => {
    resetForTest();
    // 退避基准放大到 10s：测试期间定时器不触发，全部由手动 flush 驱动，保证确定性
    setBackoffBaseForTest(10000);
    events = [];
    executorCalls = [];
    onSyncState((state, boardId) => events.push({ state, boardId }));
  });
  afterEach(() => {
    resetForTest();
    setBackoffBaseForTest(2000);
  });

  test('成功路径：enqueue → flush → ok → saved，队列清空', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'ok';
    });

    enqueue('b1');
    assert.deepEqual(events.map((e) => e.state), ['pending']);
    await flush();

    assert.deepEqual(executorCalls, ['b1']);
    assert.equal(hasPending('b1'), false);
    assert.deepEqual(events.map((e) => e.state), ['pending', 'saved']);
  });

  test('失败退避重试：fail×2 后 ok（三次手动 flush）', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return executorCalls.length < 3 ? 'fail' : 'ok';
    });

    enqueue('b1');
    await flush();
    assert.equal(executorCalls.length, 1);
    assert.deepEqual(events.map((e) => e.state), ['pending']);

    await flush();
    assert.equal(executorCalls.length, 2);
    assert.ok(hasPending('b1')); // 仍在队列等待下次退避

    await flush();
    assert.equal(executorCalls.length, 3);
    assert.deepEqual(events.map((e) => e.state), ['pending', 'saved']);
  });

  test('超过 MAX_RETRIES 派发 error 且不再重试', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'fail';
    });

    enqueue('b1');
    for (let i = 0; i < MAX_RETRIES; i++) {
      await flush();
    }

    assert.equal(executorCalls.length, MAX_RETRIES);
    assert.equal(hasPending('b1'), false);
    assert.ok(events.some((e) => e.state === 'error'));

    // 再次 flush 不产生新调用（已移出队列）
    await flush();
    assert.equal(executorCalls.length, MAX_RETRIES);
  });

  test('conflict 派发 conflict 且不重试', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'conflict';
    });

    enqueue('b1');
    await flush();

    assert.equal(executorCalls.length, 1);
    assert.equal(hasPending('b1'), false);
    assert.deepEqual(events.map((e) => e.state), ['pending', 'conflict']);

    await flush();
    assert.equal(executorCalls.length, 1); // 不重试
  });

  test('去重：同 id 重复 enqueue 只保留一个条目且尝试计数不重置', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'fail';
    });

    enqueue('b1');
    await flush(); // attempts=1
    enqueue('b1'); // 重复入队不覆盖计数
    assert.equal(getPendingIds().length, 1);

    for (let i = 0; i < MAX_RETRIES - 1; i++) await flush();
    assert.equal(executorCalls.length, MAX_RETRIES);
    assert.ok(events.some((e) => e.state === 'error'));
  });

  test('window online 事件触发 flush 补传', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'ok';
    });

    const id = 'b-online';
    enqueue(id);
    assert.equal(executorCalls.length, 0); // 仅入队，尚未 flush（定时器被放大未触发）

    for (const cb of onlineListeners) cb(); // 模拟恢复网络
    await waitFor(() => executorCalls.length >= 1);

    assert.ok(executorCalls.includes(id));
    assert.equal(hasPending(id), false);
  });

  test('flush() 空队列安全', async () => {
    await flush();
    assert.equal(getPendingIds().length, 0);
  });
});

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
