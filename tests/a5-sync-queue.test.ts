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
  flushForPageHide,
  getPendingIds,
  hasPending,
  MAX_RETRIES,
  onSyncState,
  resetForTest,
  setBackoffBaseForTest,
  setSyncExecutor,
  SyncExecOpts,
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

  test('超过 MAX_RETRIES：派发一次 error，但任务留在队列转入慢速自愈', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'fail';
    });

    enqueue('b1');
    for (let i = 0; i < MAX_RETRIES; i++) {
      await flush();
    }

    assert.equal(executorCalls.length, MAX_RETRIES);
    // 旧行为：耗尽即移出队列、只能等下次启动补传（「半天不上传」的根因之一）
    assert.ok(hasPending('b1'), '快退避耗尽后任务必须保留，等待慢速自愈');
    assert.equal(events.filter((e) => e.state === 'error').length, 1);

    // 慢速自愈：任务仍在，flush 仍会重试（online/visibility 事件即走此路径）
    await flush();
    assert.equal(executorCalls.length, MAX_RETRIES + 1);
    // 但不再重复打扰用户
    assert.equal(events.filter((e) => e.state === 'error').length, 1);
  });

  test('慢速自愈期间恢复成功：任务清空、error 状态可再次派发', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return executorCalls.length <= MAX_RETRIES ? 'fail' : 'ok';
    });

    enqueue('b1');
    for (let i = 0; i < MAX_RETRIES; i++) await flush();
    assert.ok(hasPending('b1'));

    await flush(); // 第 MAX_RETRIES+1 次：成功，自愈完成
    assert.equal(hasPending('b1'), false);
    assert.equal(events.filter((e) => e.state === 'saved').length, 1);
  });

  test('flushForPageHide 透传 keepalive=true；常规 flush 不传', async () => {
    // 按 boardId 记录首次调用参数：enqueue 会排一个 0ms 定时器，并发下不能靠调用顺序断言
    const seen = new Map<string, SyncExecOpts | undefined>();
    setSyncExecutor(async (id, opts) => {
      executorCalls.push(id);
      if (!seen.has(id)) seen.set(id, opts);
      return 'ok';
    });

    enqueue('b-normal');
    await flush();
    assert.equal(seen.get('b-normal')?.keepalive, undefined, '常规同步不得带 keepalive（有 64KB 体积上限）');

    enqueue('b-hide');
    flushForPageHide(); // 页面卸载路径：同步进入执行器，不 await
    assert.equal(seen.get('b-hide')?.keepalive, true);
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

  test('rejected（服务端确定性拒绝）派发 error 且不重试——这正是与 fail 的分水岭', async () => {
    setSyncExecutor(async (id) => {
      executorCalls.push(id);
      return 'rejected';
    });

    enqueue('b1');
    await flush();

    assert.equal(executorCalls.length, 1);
    assert.equal(hasPending('b1'), false, '确定性拒绝必须摘除任务，不能留着无限重试');
    assert.deepEqual(events.map((e) => e.state), ['pending', 'error']);

    await flush();
    assert.equal(executorCalls.length, 1); // 不重试

    // 对照：同样只失败一次，'fail' 会留在队列里（见「失败退避重试」与「超过 MAX_RETRIES」两例）
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
