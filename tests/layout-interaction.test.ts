/**
 * 节点布局算法与拖拽/流式输出交互单测
 *
 * 覆盖范围：
 * 1. AI 节点可拖拽性（draggable: true 针对 chat 与 note，suggested 占位保持 false）
 * 2. 节点尺寸自适应估算（estimateNodeSize / resolveNodeSize：正文字数与行数动态定高）
 * 3. 手动位置保护与重置（isManualPosition: true 坐标保留，resetManualPositions 全量重排规整）
 * 4. 子树相对偏移延续（手动拖拽父节点后，新增下游子节点紧随父节点坐标）
 * 5. 下游子孙节点遍历（getDescendantNodeIds：多层广度优先遍历与防环保护）
 * 6. 拖拽联动（父节点移动带动整棵下游子树平滑位移）
 * 7. AI 流式输出避让推挤（纵向重叠检测与波纹向下平移，零视口抖动）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Node, Edge } from '@xyflow/react';
import {
  getLayoutedElements,
  estimateNodeSize,
  resolveNodeSize,
} from '../src/lib/layout.js';
import { getDescendantNodeIds } from '../src/lib/tree.js';
import type { ChatNodeData } from '../src/types.js';

function createMockChatNode(
  id: string,
  pos: { x: number; y: number } = { x: 0, y: 0 },
  extraData: Partial<ChatNodeData> = {}
): Node {
  return {
    id,
    type: 'chat',
    position: pos,
    data: {
      title: `Node ${id}`,
      question: `Question for ${id}`,
      answer: `Answer for ${id}`,
      depth: 0,
      status: 'idle',
      ...extraData,
    } as unknown as Record<string, unknown>,
  };
}

function createMockSuggestedNode(
  id: string,
  pos: { x: number; y: number } = { x: 0, y: 0 }
): Node {
  return {
    id,
    type: 'chat',
    position: pos,
    data: {
      title: `Suggestion ${id}`,
      question: `Suggestion question for ${id}`,
      depth: 1,
      status: 'suggested',
    } as unknown as Record<string, unknown>,
  };
}

function createMockNoteNode(
  id: string,
  pos: { x: number; y: number } = { x: 0, y: 0 },
  content = 'Note content'
): Node {
  return {
    id,
    type: 'note',
    position: pos,
    data: {
      content,
    } as unknown as Record<string, unknown>,
  };
}

describe('节点尺寸估算算法 (estimateNodeSize & resolveNodeSize)', () => {
  test('折叠节点固定高度为 60px', () => {
    const collapsedNode = createMockChatNode('n1', { x: 0, y: 0 }, { isCollapsed: true });
    const size = estimateNodeSize(collapsedNode);
    assert.equal(size.height, 60);
    assert.equal(size.width, 460);
  });

  test('探索灵感建议节点固定高度为 140px，宽度为 290px', () => {
    const sugNode = createMockSuggestedNode('s1');
    const size = estimateNodeSize(sugNode);
    assert.equal(size.height, 140);
    assert.equal(size.width, 290);
  });

  test('便签节点宽度为 320px，行数少时保底 240px，多行时自适应增高', () => {
    const shortNote = createMockNoteNode('note1', { x: 0, y: 0 }, '短便签');
    assert.equal(estimateNodeSize(shortNote).width, 320);
    assert.equal(estimateNodeSize(shortNote).height, 240);

    const longContent = Array.from({ length: 15 }, (_, i) => `便签行 ${i + 1}`).join('\n');
    const longNote = createMockNoteNode('note2', { x: 0, y: 0 }, longContent);
    assert.ok(estimateNodeSize(longNote).height > 240);
  });

  test('AI 对话卡片随文字内容长度与行数自适应增高，保底 380px', () => {
    const shortNode = createMockChatNode('c1', { x: 0, y: 0 }, { answer: '简短答案' });
    assert.equal(estimateNodeSize(shortNode).height, 380);

    const longAnswer = Array.from({ length: 25 }, (_, i) => `详细论述段落第 ${i + 1} 行：深度分析量子纠缠现象与宏观应用前景。`).join('\n');
    const longNode = createMockChatNode('c2', { x: 0, y: 0 }, { answer: longAnswer });
    const longSize = estimateNodeSize(longNode);
    assert.ok(longSize.height > 600, `Expected long card height > 600, got ${longSize.height}`);
  });

  test('resolveNodeSize 优先使用真实测量值与估算值的较大值，避免渲染抖动', () => {
    const node = createMockChatNode('c1');
    (node as any).measured = { width: 460, height: 520 };
    const resolved = resolveNodeSize(node);
    assert.equal(resolved.width, 460);
    assert.equal(resolved.height, 520);
  });
});

describe('画布布局引擎与可拖拽性 (getLayoutedElements)', () => {
  test('AI 对话节点与便签节点均置为 draggable: true，灵感占位为 false', () => {
    const chatNode = createMockChatNode('chat1');
    const noteNode = createMockNoteNode('note1');
    const sugNode = createMockSuggestedNode('sug1');
    const edge: Edge = { id: 'e1', source: 'chat1', target: 'sug1' };

    const { nodes } = getLayoutedElements([chatNode, noteNode, sugNode], [edge]);

    const resultChat = nodes.find((n) => n.id === 'chat1');
    const resultNote = nodes.find((n) => n.id === 'note1');
    const resultSug = nodes.find((n) => n.id === 'sug1');

    assert.equal(resultChat?.draggable, true);
    assert.equal(resultNote?.draggable, true);
    assert.equal(resultSug?.draggable, false);
  });

  test('手动拖拽节点 (isManualPosition: true) 在自动布局中坐标被严格保留', () => {
    const root = createMockChatNode('root', { x: 50, y: 50 });
    const draggedChild = createMockChatNode(
      'draggedChild',
      { x: 999, y: 888 },
      { isManualPosition: true }
    );
    const edges: Edge[] = [{ id: 'e1', source: 'root', target: 'draggedChild' }];

    const { nodes } = getLayoutedElements([root, draggedChild], edges, 'LR');
    const targetChild = nodes.find((n) => n.id === 'draggedChild');

    assert.equal(targetChild?.position.x, 999);
    assert.equal(targetChild?.position.y, 888);
  });

  test('一键整理布局 (resetManualPositions: true) 会重置 isManualPosition 并重新规范排版', () => {
    const root = createMockChatNode('root', { x: 50, y: 50 });
    const draggedChild = createMockChatNode(
      'draggedChild',
      { x: 999, y: 888 },
      { isManualPosition: true }
    );
    const edges: Edge[] = [{ id: 'e1', source: 'root', target: 'draggedChild' }];

    const { nodes } = getLayoutedElements([root, draggedChild], edges, 'LR', {
      resetManualPositions: true,
    });
    const targetChild = nodes.find((n) => n.id === 'draggedChild');

    // 坐标被重置为标准 Dagre 层次坐标，不再是 999, 888
    assert.notEqual(targetChild?.position.x, 999);
    assert.notEqual(targetChild?.position.y, 888);
    assert.equal((targetChild?.data as any)?.isManualPosition, false);
  });

  test('手动位移的父节点下新增子节点时，新子节点沿用父节点的相对偏移，而非跳回原点', () => {
    // 根节点被手动拖拽至 (800, 600)
    const root = createMockChatNode('root', { x: 800, y: 600 }, { isManualPosition: true });
    // 新分支出的子节点，初始坐标为占位 (0, 0)，未被手动拖拽
    const newChild = createMockChatNode('newChild', { x: 0, y: 0 });
    const edges: Edge[] = [{ id: 'e1', source: 'root', target: 'newChild' }];

    const { nodes } = getLayoutedElements([root, newChild], edges, 'LR');
    const layoutedRoot = nodes.find((n) => n.id === 'root')!;
    const layoutedChild = nodes.find((n) => n.id === 'newChild')!;

    // 根节点保持在 800, 600
    assert.equal(layoutedRoot.position.x, 800);
    assert.equal(layoutedRoot.position.y, 600);

    // 子节点在根节点的右侧横向延伸，Y 轴与根节点对齐（不跳至左上角原点）
    assert.ok(layoutedChild.position.x > layoutedRoot.position.x, 'Child should be placed to the right of parent');
    assert.ok(Math.abs(layoutedChild.position.y - layoutedRoot.position.y) < 100, 'Child Y should be near parent Y');
  });
});

describe('子孙节点递归收集算法 (getDescendantNodeIds)', () => {
  test('正确收集多级下游子孙（子、孙、曾孙）', () => {
    const edges: Edge[] = [
      { id: 'e1', source: 'root', target: 'c1' },
      { id: 'e2', source: 'root', target: 'c2' },
      { id: 'e3', source: 'c1', target: 'gc1' },
      { id: 'e4', source: 'gc1', target: 'ggc1' },
      { id: 'e5', source: 'c2', target: 'gc2' },
      { id: 'e6', source: 'other_root', target: 'other_child' },
    ];

    const rootDescendants = getDescendantNodeIds('root', edges);
    assert.equal(rootDescendants.size, 5);
    assert.ok(rootDescendants.has('c1'));
    assert.ok(rootDescendants.has('c2'));
    assert.ok(rootDescendants.has('gc1'));
    assert.ok(rootDescendants.has('gc2'));
    assert.ok(rootDescendants.has('ggc1'));
    assert.ok(!rootDescendants.has('other_child'));

    const c1Descendants = getDescendantNodeIds('c1', edges);
    assert.equal(c1Descendants.size, 2);
    assert.ok(c1Descendants.has('gc1'));
    assert.ok(c1Descendants.has('ggc1'));
  });

  test('叶子节点调用返回空 Set', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'root', target: 'leaf' }];
    const leafDescendants = getDescendantNodeIds('leaf', edges);
    assert.equal(leafDescendants.size, 0);
  });

  test('拓扑中存在环路时安全退出，防止无限循环死锁', () => {
    const cyclicEdges: Edge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
      { id: 'e3', source: 'c', target: 'a' },
    ];

    const descendants = getDescendantNodeIds('a', cyclicEdges);
    assert.equal(descendants.size, 2);
    assert.ok(descendants.has('b'));
    assert.ok(descendants.has('c'));
  });
});

describe('拖拽联动与流式纵向推挤算法模拟 (Drag & Streaming Interaction Logic)', () => {
  test('拖拽联动计算：父节点位移 (dx, dy) 映射至全体子孙节点', () => {
    const edges: Edge[] = [
      { id: 'e1', source: 'parent', target: 'child1' },
      { id: 'e2', source: 'child1', target: 'grandchild1' },
    ];

    const initialPositions = new Map<string, { x: number; y: number }>([
      ['child1', { x: 500, y: 100 }],
      ['grandchild1', { x: 1000, y: 100 }],
    ]);

    const dx = 150;
    const dy = -80;

    const descendants = getDescendantNodeIds('parent', edges);
    const nextPositions = new Map<string, { x: number; y: number }>();

    descendants.forEach((dId) => {
      const init = initialPositions.get(dId);
      if (init) {
        nextPositions.set(dId, { x: init.x + dx, y: init.y + dy });
      }
    });

    assert.deepEqual(nextPositions.get('child1'), { x: 650, y: 20 });
    assert.deepEqual(nextPositions.get('grandchild1'), { x: 1150, y: 20 });
  });

  test('AI 流式输出避让推挤：识别下方碰撞分支并执行纵向平移，保持当前节点不动', () => {
    const streamingNode = createMockChatNode('streaming', { x: 400, y: 100 });
    const siblingBelow = createMockChatNode('sibling', { x: 420, y: 550 });
    const siblingChild = createMockChatNode('siblingChild', { x: 900, y: 550 });
    const siblingAbove = createMockChatNode('above', { x: 400, y: -200 });

    const edges: Edge[] = [
      { id: 'e1', source: 'sibling', target: 'siblingChild' },
    ];

    const currentNodes = [streamingNode, siblingBelow, siblingChild, siblingAbove];
    const deltaH = 60; // 模拟卡片正文扩充增高 60px

    // 寻找碰撞根节点：y > currentY 且列重叠 (|x - currentX| < 480)
    const collisionRoots: string[] = [];
    currentNodes.forEach((n) => {
      if (n.id === streamingNode.id) return;
      if (n.position.y > streamingNode.position.y && Math.abs(n.position.x - streamingNode.position.x) < 480) {
        collisionRoots.push(n.id);
      }
    });

    assert.equal(collisionRoots.length, 1);
    assert.equal(collisionRoots[0], 'sibling');

    // 收集推移节点（碰撞根及其子孙）
    const nodesToShift = new Set<string>();
    const queue = [...collisionRoots];
    collisionRoots.forEach((id) => nodesToShift.add(id));

    while (queue.length > 0) {
      const curr = queue.shift()!;
      edges
        .filter((e) => e.source === curr)
        .forEach((e) => {
          if (!nodesToShift.has(e.target) && e.target !== streamingNode.id) {
            nodesToShift.add(e.target);
            queue.push(e.target);
          }
        });
    }

    assert.ok(nodesToShift.has('sibling'));
    assert.ok(nodesToShift.has('siblingChild'));
    assert.ok(!nodesToShift.has('above'));
    assert.ok(!nodesToShift.has('streaming'));

    // 应用纵向位移
    const updated = currentNodes.map((n) => {
      if (nodesToShift.has(n.id)) {
        return { ...n, position: { x: n.position.x, y: n.position.y + deltaH } };
      }
      return n;
    });

    const resultStreaming = updated.find((n) => n.id === 'streaming')!;
    const resultSibling = updated.find((n) => n.id === 'sibling')!;
    const resultSiblingChild = updated.find((n) => n.id === 'siblingChild')!;
    const resultAbove = updated.find((n) => n.id === 'above')!;

    // 当前流式生成节点保持绝对不动（零视口抖动）
    assert.equal(resultStreaming.position.x, 400);
    assert.equal(resultStreaming.position.y, 100);

    // 上方节点保持不动
    assert.equal(resultAbove.position.y, -200);

    // 下方兄弟节点与其子孙节点同步顺畅向下推开 60px
    assert.equal(resultSibling.position.y, 550 + 60);
    assert.equal(resultSiblingChild.position.y, 550 + 60);
  });
});
