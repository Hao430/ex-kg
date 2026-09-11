/**
 * Spec M1 — JSON 备份导入（纯函数 RED 测试，先行）。
 *
 * 被测模块 src/lib/board-import.ts 尚未实现，本文件当前应整体以
 * 「模块解析失败」呈红；实现后转 GREEN。
 *
 * id 生成器注入计数器保证确定性（不依赖 Date/随机）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBoardBackup,
  MAX_IMPORT_NODES,
  MAX_IMPORT_EDGES,
} from '../src/lib/board-import.ts';

/** 顺序 id 生成器：imp-1, imp-2 … 保证唯一且可预测 */
function seqGen(): () => string {
  let i = 0;
  return () => `imp-${++i}`;
}

const OPTS = { generateId: seqGen(), now: () => 1234567890 };

/** 取标题命中的导入节点（避免依赖生成器调用顺序） */
function nodeByTitle(nodes: any[], title: string): any {
  const n = nodes.find((x) => x?.data?.title === title);
  assert.ok(n, `未找到标题为「${title}」的节点`);
  return n;
}

describe('M1 JSON 导入 · 正常路径与内容保真', () => {
  test('合法备份导入成功，节点/边数量正确，updatedAt 取 now', () => {
    const raw = JSON.stringify({
      id: 'old-board',
      name: '我的备份',
      updatedAt: 111,
      nodes: [
        { id: 'n1', type: 'chat', position: { x: 1, y: 2 }, data: { title: '根', answer: 'A', status: 'idle' } },
        { id: 'n2', type: 'note', position: { x: 3, y: 4 }, data: { title: '便签', content: 'c' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', type: 'default', style: { stroke: '#6366f1' }, markerEnd: { type: 'arrowclosed' } },
      ],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.board.name, '我的备份');
    assert.equal(r.board.updatedAt, 1234567890);
    assert.equal(r.board.nodes.length, 2);
    assert.equal(r.board.edges.length, 1);
    assert.equal(r.stats.nodes, 2);
    assert.equal(r.stats.edges, 1);
    assert.equal(r.stats.droppedEdges, 0);
    // 内容保真
    assert.deepEqual(nodeByTitle(r.board.nodes, '根').position, { x: 1, y: 2 });
    assert.equal(nodeByTitle(r.board.nodes, '根').data.answer, 'A');
    assert.equal(nodeByTitle(r.board.nodes, '便签').data.content, 'c');
    assert.equal(r.board.edges[0].type, 'default');
    assert.deepEqual(r.board.edges[0].style, { stroke: '#6366f1' });
    assert.deepEqual(r.board.edges[0].markerEnd, { type: 'arrowclosed' });
  });

  test('board/node/edge id 全部重映射，唯一且不携带 serverUpdatedAt', () => {
    const raw = JSON.stringify({
      id: 'old-board',
      name: 'B',
      nodes: [
        { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a' } },
        { id: 'n2', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'b' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.notEqual(r.board.id, 'old-board');
    const ids = r.board.nodes.map((n) => n.id);
    assert.ok(!ids.includes('n1') && !ids.includes('n2'), '节点 id 必须重映射');
    assert.equal(new Set(ids).size, ids.length, '节点 id 必须唯一');
    assert.notEqual(r.board.edges[0].id, 'e1');
    assert.equal(r.board.serverUpdatedAt, undefined, '新画板不得带服务端版本号');
  });

  test('edge.source/target 与 data.parentId 指向重映射后的新节点 id', () => {
    const raw = JSON.stringify({
      name: 'B',
      nodes: [
        { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: '根' } },
        { id: 'n2', type: 'chat', position: { x: 0, y: 0 }, data: { title: '子', parentId: 'n1' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const rootId = nodeByTitle(r.board.nodes, '根').id;
    const childId = nodeByTitle(r.board.nodes, '子').id;
    assert.equal(r.board.edges[0].source, rootId);
    assert.equal(r.board.edges[0].target, childId);
    assert.equal(nodeByTitle(r.board.nodes, '子').data.parentId, rootId);
  });

  test('不可达的 data.parentId 被删除，不保留悬挂父指针', () => {
    const raw = JSON.stringify({
      name: 'B',
      nodes: [{ id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a', parentId: 'ghost' } }],
      edges: [],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.board.nodes[0].data.parentId, undefined);
  });
});

describe('M1 JSON 导入 · 归一化', () => {
  test('generating 态归一为 idle 并清 errorMessage；readOnly 被剥离', () => {
    const raw = JSON.stringify({
      name: 'B',
      nodes: [
        {
          id: 'n1',
          type: 'chat',
          position: { x: 0, y: 0 },
          data: { title: 'a', status: 'generating', errorMessage: 'boom', readOnly: true },
        },
      ],
      edges: [],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const d = r.board.nodes[0].data as any;
    assert.equal(d.status, 'idle');
    assert.equal(d.errorMessage, undefined);
    assert.equal(d.readOnly, undefined, '导入画板必须可编辑');
  });

  test('未知节点 type 归一为 chat；缺失 position 回落原点', () => {
    const raw = JSON.stringify({
      name: 'B',
      nodes: [{ id: 'n1', type: 'weird', data: { title: 'a' } }],
      edges: [],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.board.nodes[0].type, 'chat');
    assert.deepEqual(r.board.nodes[0].position, { x: 0, y: 0 });
  });

  test('messages 清洗：非字符串 content 剔除，缺失 id/timestamp 补齐，role 归一', () => {
    const raw = JSON.stringify({
      name: 'B',
      nodes: [
        {
          id: 'n1',
          type: 'chat',
          position: { x: 0, y: 0 },
          data: {
            title: 'a',
            messages: [
              { id: 'm1', role: 'user', content: 'hi', timestamp: 5 },
              { role: 'x', content: 42 },
              { role: 'assistant', content: 'yo' },
            ],
          },
        },
      ],
      edges: [],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const msgs = (r.board.nodes[0].data as any).messages;
    assert.equal(msgs.length, 2, 'content 非字符串的条目应被剔除');
    assert.equal(msgs[0].content, 'hi');
    assert.equal(msgs[0].timestamp, 5);
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'yo');
    assert.equal(typeof msgs[1].id, 'string');
    assert.ok(msgs[1].id.length > 0);
    assert.equal(typeof msgs[1].timestamp, 'number');
  });

  test('非法 viewport 与缺失 name 回落默认值，不报错', () => {
    const raw = JSON.stringify({
      nodes: [{ id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a' } }],
      edges: [],
      viewport: { x: 'bad', y: 0, zoom: 1 },
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.board.name, '导入的画板');
    assert.deepEqual(r.board.viewport, { x: 0, y: 0, zoom: 1 });
  });

  test('悬挂边被丢弃并计入 droppedEdges；重复 id 去重保留首个', () => {
    const raw = JSON.stringify({
      name: 'B',
      nodes: [
        { id: 'dup', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'first' } },
        { id: 'dup', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'second' } },
      ],
      edges: [
        { id: 'e-ok', source: 'dup', target: 'dup' },
        { id: 'e-dangling', source: 'dup', target: 'ghost' },
      ],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.board.nodes.length, 1, '重复节点 id 保留首个');
    assert.equal(r.board.nodes[0].data.title, 'first');
    assert.equal(r.board.edges.length, 1);
    assert.equal(r.stats.droppedEdges, 1);
  });
});

describe('M1 JSON 导入 · 非法与超限输入', () => {
  test('非法 JSON → INVALID_JSON', () => {
    const r = parseBoardBackup('{ not json', OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'INVALID_JSON');
    assert.ok(r.error.length > 0);
  });

  test('顶层为数组 → INVALID_SHAPE', () => {
    const r = parseBoardBackup('[]', OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'INVALID_SHAPE');
  });

  test('nodes 非数组 → INVALID_SHAPE', () => {
    const r = parseBoardBackup(JSON.stringify({ nodes: 'x', edges: [] }), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'INVALID_SHAPE');
  });

  test('节点 position 非数值 → INVALID_SHAPE', () => {
    const raw = JSON.stringify({
      nodes: [{ id: 'n1', type: 'chat', position: { x: 'a', y: 2 }, data: {} }],
      edges: [],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'INVALID_SHAPE');
  });

  test('节点缺失 id → INVALID_SHAPE', () => {
    const raw = JSON.stringify({ nodes: [{ type: 'chat', position: { x: 0, y: 0 } }], edges: [] });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'INVALID_SHAPE');
  });

  test('空节点 → EMPTY', () => {
    const r = parseBoardBackup(JSON.stringify({ name: 'B', nodes: [], edges: [] }), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'EMPTY');
  });

  test('节点超限 → TOO_MANY_NODES', () => {
    const nodes = Array.from({ length: MAX_IMPORT_NODES + 1 }, (_, i) => ({
      id: `n${i}`,
      type: 'chat',
      position: { x: 0, y: 0 },
      data: { title: `t${i}` },
    }));
    const r = parseBoardBackup(JSON.stringify({ nodes, edges: [] }), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'TOO_MANY_NODES');
  });

  test('边超限 → TOO_MANY_EDGES', () => {
    const edges = Array.from({ length: MAX_IMPORT_EDGES + 1 }, (_, i) => ({
      id: `e${i}`,
      source: 'n1',
      target: 'n1',
    }));
    const raw = JSON.stringify({
      nodes: [{ id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a' } }],
      edges,
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'TOO_MANY_EDGES');
  });

  test('父子环 → INVALID_SHAPE（不产生幽灵板）', () => {
    const raw = JSON.stringify({
      nodes: [
        { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'a', parentId: 'n2' } },
        { id: 'n2', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'b', parentId: 'n1' } },
      ],
      edges: [],
    });
    const r = parseBoardBackup(raw, OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'INVALID_SHAPE');
  });
});
