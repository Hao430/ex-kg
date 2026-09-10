/**
 * L1 — 顶栏快捷切换分段构造（纯函数）
 *
 * 覆盖：无分组退化为扁平列表（收藏置顶）、归档隐藏、收藏独立成段、
 * 未分组回落（含指向已删分组的画板）、空分组不渲染。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuickSections } from '../src/lib/board-sections.ts';
import type { DeepDiveBoardMeta } from '../src/types.ts';

function board(id: string, opts: Partial<DeepDiveBoardMeta> = {}): DeepDiveBoardMeta {
  return { id, name: id, updatedAt: 0, nodeCount: 0, ...opts };
}

describe('L1 顶栏画板分段', () => {
  test('无分组：单段扁平列表，收藏置顶，段内按最近排序', () => {
    const sections = buildQuickSections(
      [
        board('a', { updatedAt: 1 }),
        board('b', { updatedAt: 3, isFavorite: true }),
        board('c', { updatedAt: 2 }),
        board('d', { updatedAt: 9, isFavorite: true }),
      ],
      []
    );
    assert.equal(sections.length, 1);
    assert.equal(sections[0].key, '__none');
    assert.equal(sections[0].label, undefined, '无分组时不显示分组标题');
    assert.deepEqual(sections[0].boards.map((b) => b.id), ['d', 'b', 'c', 'a']);
  });

  test('有分组：收藏独立成段，其余按未分组/各分组分段', () => {
    const sections = buildQuickSections(
      [
        board('fav', { isFavorite: true, updatedAt: 5 }),
        board('u1', { updatedAt: 4 }),
        board('f1', { folderId: 'F1', updatedAt: 3 }),
        board('f2', { folderId: 'F2', updatedAt: 2 }),
      ],
      [
        { id: 'F1', name: '论文', sortOrder: 0 },
        { id: 'F2', name: '项目', sortOrder: 1 },
      ]
    );
    assert.deepEqual(sections.map((s) => s.key), ['__fav', '__none', 'F1', 'F2']);
    assert.deepEqual(sections[0].boards.map((b) => b.id), ['fav']);
    assert.deepEqual(sections[1].boards.map((b) => b.id), ['u1']);
    assert.equal(sections[2].label, '论文');
    assert.equal(sections[3].label, '项目');
  });

  test('归档画板不进入快捷切换', () => {
    const sections = buildQuickSections(
      [board('live'), board('dead', { isArchived: true })],
      []
    );
    const ids = sections.flatMap((s) => s.boards.map((b) => b.id));
    assert.deepEqual(ids, ['live']);
  });

  test('指向已删/未知分组的画板回落到未分组（不消失）', () => {
    const sections = buildQuickSections(
      [board('ghost', { folderId: 'GONE' })],
      [{ id: 'F1', name: '论文', sortOrder: 0 }]
    );
    const ungrouped = sections.find((s) => s.key === '__none');
    assert.ok(ungrouped);
    assert.deepEqual(ungrouped!.boards.map((b) => b.id), ['ghost']);
  });

  test('空分组不渲染；全部收藏时不产生空的未分组段', () => {
    const sections = buildQuickSections(
      [board('only', { isFavorite: true })],
      [{ id: 'F-empty', name: '空组', sortOrder: 0 }]
    );
    assert.deepEqual(sections.map((s) => s.key), ['__fav']);
  });
});
