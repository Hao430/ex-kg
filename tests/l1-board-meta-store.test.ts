/**
 * L1 — board-store 元数据脏标记（metaDirty）合并语义
 *
 * 覆盖：内容保存不抹掉收藏/归档偏好、updateMetaLocal 标脏并持久化、
 * 服务端水合不回退本地待同步 meta、confirmServerMeta 收敛并清零、
 * 墓碑/远端删除清理 metaDirty。
 */
import { test, describe, beforeEach } from 'node:test';
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

const bs = await import('../src/lib/board-store.js');
const scope = await import('../src/lib/board-scope.js');

function find(id: string) {
  return bs.getBoardList().find((b) => b.id === id);
}

describe('L1 board-store metaDirty', () => {
  beforeEach(() => {
    store.clear();
    bs.resetForTest();
    bs.bindScope('u1');
    bs.upsertLocal({ id: 'a', name: 'A', updatedAt: 1, nodeCount: 0 }, { dirty: false });
  });

  test('内容保存（upsertLocal）不抹掉已有收藏/归档偏好', () => {
    bs.updateMetaLocal('a', { isFavorite: true, isArchived: false });
    // 模拟随后一次内容自动保存：传入的 meta 不含管理字段
    bs.upsertLocal({ id: 'a', name: 'A2', updatedAt: 2, nodeCount: 3 }, { dirty: true });
    const meta = find('a')!;
    assert.equal(meta.name, 'A2');
    assert.equal(meta.isFavorite, true, '收藏偏好应保留');
  });

  test('updateMetaLocal 标 metaDirty 并持久化到 scoped key', () => {
    bs.updateMetaLocal('a', { isFavorite: true });
    assert.equal(find('a')!.isFavorite, true);
    assert.ok(bs.getState().metaDirty.has('a'));
    const raw = store.get(scope.metaDirtyKey('u1'));
    assert.ok(raw && raw.includes('a'), 'metaDirty 应持久化');
  });

  test('服务端水合不回退本地待同步 meta（本地版胜出）', () => {
    bs.updateMetaLocal('a', { isFavorite: true });
    bs.hydrateFromServer([{ id: 'a', name: 'A', updatedAt: 99, nodeCount: 0, isFavorite: false }]);
    assert.equal(find('a')!.isFavorite, true, '服务端旧值不得覆盖本地待同步收藏');
  });

  test('confirmServerMeta 清 metaDirty 并采纳服务端权威字段', () => {
    bs.updateMetaLocal('a', { isFavorite: true });
    bs.confirmServerMeta('a', {
      title: '服务端名',
      isFavorite: true,
      isArchived: true,
      updatedAt: new Date(5000).toISOString(),
    });
    const meta = find('a')!;
    assert.equal(bs.getState().metaDirty.has('a'), false);
    assert.equal(meta.name, '服务端名');
    assert.equal(meta.isArchived, true);
    assert.equal(meta.updatedAt, 5000);
  });

  test('墓碑清理 metaDirty 且画板移出列表', () => {
    bs.updateMetaLocal('a', { isFavorite: true });
    bs.addTombstone('a');
    assert.equal(bs.getState().metaDirty.has('a'), false);
    assert.equal(find('a'), undefined);
  });

  test('reconcileRemoteDeletion 清理 metaDirty', () => {
    bs.updateMetaLocal('a', { isFavorite: true });
    bs.reconcileRemoteDeletion('a');
    assert.equal(bs.getState().metaDirty.has('a'), false);
    assert.equal(find('a'), undefined);
  });
});
