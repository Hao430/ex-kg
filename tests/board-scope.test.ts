/**
 * 前端 — board-scope 作用域 / 旧键迁移 / 游客认领计划（2026-09-10 画布列表/同步重构）。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DeepDiveBoardMeta } from '../src/types.ts';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const boardScope = await import('../src/lib/board-scope.js');

function meta(id: string, name = id): DeepDiveBoardMeta {
  return { id, name, updatedAt: 1000, nodeCount: 0 };
}

const LEGACY = 'deepdive_boards_index_v1';

describe('board-scope 旧键迁移', () => {
  beforeEach(() => {
    store.clear();
    boardScope.setActiveScopeKey('guest');
  });

  test('旧无作用域索引迁入首个 scope（backup + 删旧键 + marker 幂等）', () => {
    store.set(LEGACY, JSON.stringify([meta('old1'), meta('old2')]));
    const r = boardScope.adoptLegacyIndex('guest');
    assert.equal(r.migrated, true);
    assert.equal(r.count, 2);
    assert.deepEqual(boardScope.readScopedIndex('guest').map((m) => m.id), ['old1', 'old2']);
    assert.equal(store.has(LEGACY), false, '旧键应删除');
    assert.ok(store.get('deepdive_v2:legacy_backup'), '应保留备份');

    const r2 = boardScope.adoptLegacyIndex('guest');
    assert.equal(r2.migrated, false, 'marker 应保证幂等');
  });

  test('已存在 scoped 索引时不迁移旧键（不覆盖新数据）', () => {
    boardScope.writeScopedIndex([meta('new1')], 'u1');
    store.set(LEGACY, JSON.stringify([meta('old1')]));
    const r = boardScope.adoptLegacyIndex('u1');
    assert.equal(r.migrated, false);
    assert.deepEqual(boardScope.readScopedIndex('u1').map((m) => m.id), ['new1']);
    assert.ok(store.has(LEGACY), '旧键应保留，交其他 scope 或人工处理');
  });

  test('旧索引损坏：原样不动，不丢数据', () => {
    store.set(LEGACY, '{not-json');
    const r = boardScope.adoptLegacyIndex('guest');
    assert.equal(r.migrated, false);
    assert.equal(store.get(LEGACY), '{not-json');
  });
});

describe('board-scope 游客认领计划', () => {
  beforeEach(() => {
    store.clear();
    boardScope.setActiveScopeKey('guest');
  });

  test('只认领纯本地草稿：排除共享板与已有服务端版本者', () => {
    boardScope.writeScopedIndex(
      [meta('g1'), meta('default-board'), meta('g2'), meta('g3')],
      'guest'
    );
    store.set(`${boardScope.SERVER_TS_PREFIX}g2`, '2026-09-10T00:00:00.000Z');

    const { claimable } = boardScope.planGuestClaim('user-1');
    assert.deepEqual(claimable.map((m) => m.id).sort(), ['g1', 'g3']);
  });

  test('guest 作用域本身不产生认领', () => {
    boardScope.writeScopedIndex([meta('g1')], 'guest');
    assert.deepEqual(boardScope.planGuestClaim('guest').claimable, []);
  });
});
