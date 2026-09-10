/**
 * 前端 — sync-queue 持久化续跑 / 删除任务 / dirty 兜底（2026-09-10 画布列表/同步重构）。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const qs = await import('../src/lib/sync-queue.js');
const boardScope = await import('../src/lib/board-scope.js');

let calls: string[] = [];

describe('sync-queue 持久化与删除任务', () => {
  beforeEach(() => {
    store.clear();
    calls = [];
    qs.resetForTest();
    qs.setBackoffBaseForTest(10000);
    qs.setSyncExecutor(async (id) => {
      calls.push(`up:${id}`);
      return 'ok';
    });
    qs.setDeleteExecutor(async (id) => {
      calls.push(`del:${id}`);
      return 'ok';
    });
  });
  afterEach(() => {
    qs.resetForTest();
    qs.setBackoffBaseForTest(2000);
  });

  test('绑 scope 后入队/删除任务持久化到 scoped key', () => {
    qs.bindQueueScope('u1');
    qs.enqueue('a');
    qs.enqueueDelete('b');
    const raw = store.get(boardScope.queueKey('u1'));
    assert.ok(raw, '应写入持久化队列');
    const tasks = JSON.parse(raw!);
    assert.deepEqual(
      tasks.map((t: any) => `${t.boardId}:${t.type}`).sort(),
      ['a:upload', 'b:delete']
    );
  });

  test('刷新后 hydrateQueue 续跑：上传与删除分别派发对应 executor', async () => {
    qs.bindQueueScope('u1');
    qs.enqueue('a');
    qs.enqueueDelete('b');
    const persisted = JSON.parse(store.get(boardScope.queueKey('u1'))!);

    // 模拟刷新：清内存，再从未绑定的新队列状态水合
    qs.resetForTest();
    qs.bindQueueScope('u1');
    qs.hydrateQueue(persisted);
    assert.equal(qs.hasPending('a'), true);
    assert.equal(qs.isDeleteQueued('b'), true);

    await qs.flush();
    assert.ok(calls.includes('up:a'), '上传任务应执行 upload executor');
    assert.ok(calls.includes('del:b'), '删除任务应执行 delete executor');
    assert.equal(qs.hasPending('a'), false);
    assert.equal(qs.hasPending('b'), false);
  });

  test('recoverDirtyDrafts：脏画板补入上传队列并执行', async () => {
    qs.bindQueueScope('u1');
    qs.recoverDirtyDrafts(['dirty-1']);
    assert.equal(qs.hasPending('dirty-1'), true);
    await qs.flush();
    assert.ok(calls.includes('up:dirty-1'));
  });

  test('未绑 scope 时零 localStorage 访问（既有单测环境兼容）', () => {
    qs.resetForTest(); // boundScope 归 null
    store.clear();
    qs.enqueue('x');
    qs.enqueueDelete('y');
    assert.equal(store.size, 0, '未绑定作用域不应触碰 localStorage');
    assert.equal(qs.hasPending('x'), true);
    assert.equal(qs.isDeleteQueued('y'), true);
  });
});
