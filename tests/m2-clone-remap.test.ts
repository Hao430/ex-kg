/**
 * Spec M2 — 画板 id 重映射（分享克隆 + JSON 导入共用，纯函数）。
 *
 * 覆盖：全量 id 重映射、端点/父子引用改写（含前向引用）、悬挂引用剔除、
 * 去重、边字段保真、输入不可变。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { remapBoardIds } from '../src/lib/board-remap.ts';

/** 顺序 id 生成器：imp-1, imp-2 … 保证唯一且可预测 */
function seqGen(): () => string {
  let i = 0;
  return () => `imp-${++i}`;
}

function nodeByTitle(nodes: any[], title: string): any {
  const n = nodes.find((x) => x?.data?.title === title);
  assert.ok(n, `未找到标题为「${title}」的节点`);
  return n;
}

describe('M2 remapBoardIds · 重映射与引用改写', () => {
  test('board/node/edge id 全部重映射，端点指向新节点 id', () => {
    const nodes = [
      { id: 'n1', type: 'chat', position: { x: 1, y: 2 }, data: { title: '根' } },
      { id: 'n2', type: 'note', position: { x: 3, y: 4 }, data: { title: '便签' } },
    ];
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];

    const r = remapBoardIds(nodes as any, edges as any, { generateId: seqGen() });

    assert.notEqual(r.boardId, 'n1');
    const ids = r.nodes.map((n) => n.id);
    assert.ok(!ids.includes('n1') && !ids.includes('n2'), '节点 id 必须重映射');
    assert.equal(new Set(ids).size, 2, '节点 id 唯一');
    assert.notEqual(r.edges[0].id, 'e1');

    const rootId = nodeByTitle(r.nodes, '根').id;
    const noteId = nodeByTitle(r.nodes, '便签').id;
    assert.equal(r.edges[0].source, rootId);
    assert.equal(r.edges[0].target, noteId);
  });

  test('data.parentId 改写，且支持父节点在数组靠后的前向引用', () => {
    const nodes = [
      { id: 'child', type: 'chat', position: { x: 0, y: 0 }, data: { title: '子', parentId: 'parent' } },
      { id: 'parent', type: 'chat', position: { x: 0, y: 0 }, data: { title: '父' } },
    ];
    const r = remapBoardIds(nodes as any, [], { generateId: seqGen() });
    const parentId = nodeByTitle(r.nodes, '父').id;
    assert.equal(nodeByTitle(r.nodes, '子').data.parentId, parentId);
  });

  test('不可达 data.parentId 被删除，不保留悬挂父指针', () => {
    const nodes = [
      { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a', parentId: 'ghost' } },
    ];
    const r = remapBoardIds(nodes as any, [], { generateId: seqGen() });
    assert.equal((r.nodes[0].data as any).parentId, undefined);
  });
});

describe('M2 remapBoardIds · 去重、悬挂与保真', () => {
  test('重复 node/edge 旧 id 保留首个', () => {
    const nodes = [
      { id: 'dup', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'first' } },
      { id: 'dup', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'second' } },
    ];
    const edges = [
      { id: 'e1', source: 'dup', target: 'dup', label: 'first-edge' },
      { id: 'e1', source: 'dup', target: 'dup', label: 'second-edge' },
    ];
    const r = remapBoardIds(nodes as any, edges as any, { generateId: seqGen() });
    assert.equal(r.nodes.length, 1);
    assert.equal((r.nodes[0].data as any).title, 'first');
    assert.equal(r.edges.length, 1);
    assert.equal(r.edges[0].label, 'first-edge');
  });

  test('端点不可达的边被丢弃并计入 droppedEdges', () => {
    const nodes = [
      { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a' } },
    ];
    const edges = [
      { id: 'ok', source: 'n1', target: 'n1' },
      { id: 'dangling', source: 'n1', target: 'ghost' },
    ];
    const r = remapBoardIds(nodes as any, edges as any, { generateId: seqGen() });
    assert.equal(r.edges.length, 1);
    assert.equal(r.droppedEdges, 1);
  });

  test('边字段与节点字段保真', () => {
    const nodes = [{ id: 'n1', type: 'chat', position: { x: 5, y: 6 }, data: { title: 'a' } }];
    const edges = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n1',
        type: 'default',
        animated: true,
        style: { stroke: '#6366f1' },
        markerEnd: { type: 'arrowclosed' },
        label: 'L',
        sourceHandle: 's',
        targetHandle: 't',
      },
    ];
    const r = remapBoardIds(nodes as any, edges as any, { generateId: seqGen() });
    assert.equal(r.nodes[0].type, 'chat');
    assert.deepEqual(r.nodes[0].position, { x: 5, y: 6 });
    assert.equal(r.edges[0].type, 'default');
    assert.equal(r.edges[0].animated, true);
    assert.deepEqual(r.edges[0].style, { stroke: '#6366f1' });
    assert.deepEqual(r.edges[0].markerEnd, { type: 'arrowclosed' });
    assert.equal(r.edges[0].label, 'L');
    assert.equal(r.edges[0].sourceHandle, 's');
    assert.equal(r.edges[0].targetHandle, 't');
  });

  test('输入数组/对象不被修改（纯函数）', () => {
    const nodes = [
      { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a', parentId: 'ghost' } },
    ];
    const edges = [{ id: 'e1', source: 'n1', target: 'n1' }];
    const nodesSnapshot = JSON.parse(JSON.stringify(nodes));
    const edgesSnapshot = JSON.parse(JSON.stringify(edges));

    remapBoardIds(nodes as any, edges as any, { generateId: seqGen() });

    assert.deepEqual(nodes, nodesSnapshot);
    assert.deepEqual(edges, edgesSnapshot);
  });

  test('节点缺失 data 不抛错', () => {
    const nodes = [{ id: 'n1', type: 'chat', position: { x: 0, y: 0 } }];
    const r = remapBoardIds(nodes as any, [], { generateId: seqGen() });
    assert.equal(r.nodes.length, 1);
    assert.notEqual(r.nodes[0].id, 'n1');
  });
});
