/**
 * 画布变更分类（`src/lib/canvas-change.ts`）——自动保存走「防抖」还是「立即」的判据。
 *
 * 结构操作（新增/删除节点或边）必须立即落库，否则会白留未上传窗口；而
 * 「载入以服务端为准」（ADR-0025）会丢弃窗口里的内容，所以这条判据是行为保证的一部分。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotStructure,
  isStructuralChange,
} from '../src/lib/canvas-change.ts';

const node = (id: string) => ({ id, type: 'chat', position: { x: 0, y: 0 }, data: {} }) as any;
const edge = (id: string, source: string, target: string) =>
  ({ id, source, target }) as any;

describe('画布变更分类：结构变更应立即落库', () => {
  test('首次快照（prev 为 null）不算结构变更', () => {
    const next = snapshotStructure([node('a')], []);
    assert.equal(isStructuralChange(null, next), false);
    assert.equal(isStructuralChange(undefined, next), false);
  });

  test('新增节点 → 结构变更', () => {
    const prev = snapshotStructure([node('a')], []);
    const next = snapshotStructure([node('a'), node('b')], []);
    assert.equal(isStructuralChange(prev, next), true);
  });

  test('删除节点 → 结构变更', () => {
    const prev = snapshotStructure([node('a'), node('b')], []);
    const next = snapshotStructure([node('a')], []);
    assert.equal(isStructuralChange(prev, next), true);
  });

  test('新增边 → 结构变更（只有边变了也算）', () => {
    const prev = snapshotStructure([node('a'), node('b')], []);
    const next = snapshotStructure([node('a'), node('b')], [edge('e1', 'a', 'b')]);
    assert.equal(isStructuralChange(prev, next), true);
  });

  test('删除边 → 结构变更', () => {
    const prev = snapshotStructure([node('a'), node('b')], [edge('e1', 'a', 'b')]);
    const next = snapshotStructure([node('a'), node('b')], []);
    assert.equal(isStructuralChange(prev, next), true);
  });

  test('仅内容变化（打字 / AI 流式回答）→ 不是结构变更，走防抖', () => {
    const prev = snapshotStructure([node('a')], []);
    const next = snapshotStructure(
      [{ ...node('a'), data: { question: '边打边存', answer: '流式……' } }],
      []
    );
    assert.equal(isStructuralChange(prev, next), false);
  });

  test('仅位置变化（拖拽中的逐帧上报）→ 不是结构变更', () => {
    const prev = snapshotStructure([node('a')], []);
    const next = snapshotStructure([{ ...node('a'), position: { x: 120, y: 40 } }], []);
    assert.equal(isStructuralChange(prev, next), false);
  });

  test('仅顺序变化（同一批 id）→ 不是结构变更', () => {
    const prev = snapshotStructure([node('a'), node('b')], [edge('e1', 'a', 'b')]);
    const next = snapshotStructure([node('b'), node('a')], [edge('e1', 'a', 'b')]);
    assert.equal(isStructuralChange(prev, next), false);
  });

  test('空/undefined 输入安全：undefined 与空数组同视为空集合', () => {
    const prev = snapshotStructure(undefined, undefined);
    const next = snapshotStructure([], []);
    assert.equal(isStructuralChange(prev, next), false);

    const withNode = snapshotStructure([node('a')], undefined);
    assert.equal(isStructuralChange(prev, withNode), true);
  });

  test('缺 id 的脏节点被忽略（不制造伪结构变更）', () => {
    const prev = snapshotStructure([node('a')], []);
    const next = snapshotStructure([node('a'), { type: 'chat', position: { x: 0, y: 0 } } as any], []);
    assert.equal(isStructuralChange(prev, next), false);
  });
});
