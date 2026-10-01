/**
 * 祖先上下文回溯与子树剥离算法单测
 *
 * 覆盖范围：
 * 1. 技术债 #0099：祖先上下文回溯 Token 预算与分层滑动窗口裁剪（根节点锚定、中间层摘要折叠、近期高保真、严格角色交替）
 * 2. 技术债 #0030：前端算法单测缺失（extractSubtree 与 buildAncestorContext 纯函数覆盖）
 * 3. 技术债 #0006：DAG 拓扑防环机制（visited set 防死循环）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Node, Edge } from '@xyflow/react';
import {
  buildAncestorContext,
  estimateTokens,
  summarizeAncestorAnswer,
  extractSubtree,
} from '../src/lib/context.js';
import type { ChatNodeData } from '../src/types.js';

// 辅助构造 ChatNode
function makeChatNode(
  id: string,
  question: string,
  answer?: string,
  extra: Partial<ChatNodeData> = {}
): Node {
  return {
    id,
    type: 'chat',
    position: { x: 0, y: 0 },
    data: {
      title: question.slice(0, 10),
      depth: 0,
      question,
      answer,
      model: 'gemini-3.8-flash',
      status: answer ? 'idle' : 'generating',
      ...extra,
    } as unknown as Record<string, unknown>,
  } as Node;
}

// 辅助构造 Edge
function makeEdge(id: string, source: string, target: string): Edge {
  return { id, source, target };
}

describe('Token 估算器与答案摘要提炼 (Token Budgeting Helpers)', () => {
  test('estimateTokens: 空值与各类混合语言 Token 估算', () => {
    assert.equal(estimateTokens(''), 0);
    // 纯英文（20 字符，约 6 tokens）
    const enTokens = estimateTokens('Hello world! Testing.');
    assert.ok(enTokens >= 4 && enTokens <= 8, `English tokens unexpected: ${enTokens}`);

    // 纯中文（10 汉字，约 8 tokens）
    const zhTokens = estimateTokens('量子力学与相对论探索');
    assert.ok(zhTokens >= 7 && zhTokens <= 10, `Chinese tokens unexpected: ${zhTokens}`);

    // 中英混排 + LaTeX 公式
    const mixed = '薛定谔方程为 $i\\hbar\\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi$，代表量子态的波动力学演化。';
    const mixedTokens = estimateTokens(mixed);
    assert.ok(mixedTokens > 15, `Mixed tokens should be estimated reasonably: ${mixedTokens}`);
  });

  test('summarizeAncestorAnswer: 剔除 SUGGESTIONS 标记并提炼核心结论', () => {
    assert.equal(summarizeAncestorAnswer(''), '');

    // 短文本原样返回
    const short = '这是一个简要的核心回答。';
    assert.equal(summarizeAncestorAnswer(short, 100), short);

    // 带衍生推荐标记的文本：必须彻底移除标记及后续内容
    const withSuggestions = `量子纠缠是多粒子系统的一种纯量子态特征。两个粒子无论相隔多远，测量一个都会瞬间决定另一个的状态。
---SUGGESTIONS---
1. 贝尔不等式如何验证？
2. 量子隐形传态原理？`;
    const summarized = summarizeAncestorAnswer(withSuggestions, 80);
    assert.ok(!summarized.includes('SUGGESTIONS'), '不能残留 SUGGESTIONS 标记');
    assert.ok(!summarized.includes('贝尔不等式'), '不能残留衍生探索问题');
    assert.ok(summarized.includes('核心结论已提炼') || summarized.length <= 80);
  });
});

describe('子树剥离算法 (extractSubtree - ADR-0009 / #0030)', () => {
  test('目标节点不存在时安全回退', () => {
    const nodes = [makeChatNode('n1', 'Q1')];
    const edges: Edge[] = [];
    const res = extractSubtree('non_existent', nodes, edges);
    assert.equal(res.subtreeNodes.length, 0);
    assert.equal(res.remainingNodes.length, 1);
  });

  test('单节点（无子孙）子树提取', () => {
    const n1 = makeChatNode('n1', 'Q1');
    const n2 = makeChatNode('n2', 'Q2');
    const res = extractSubtree('n1', [n1, n2], []);
    assert.equal(res.subtreeNodes.length, 1);
    assert.equal(res.subtreeNodes[0].id, 'n1');
    assert.equal(res.remainingNodes.length, 1);
    assert.equal(res.remainingNodes[0].id, 'n2');
  });

  test('多层级完整子树与内部连线提取', () => {
    // 结构: n1 -> n2 -> n3; n1 -> n4; n4 -> n5
    // 从 n4 剥离子树，应提取 [n4, n5]，连线 [e-4-5]，保留 [n1, n2, n3]
    const nodes = [
      makeChatNode('n1', 'Q1'),
      makeChatNode('n2', 'Q2'),
      makeChatNode('n3', 'Q3'),
      makeChatNode('n4', 'Q4'),
      makeChatNode('n5', 'Q5'),
    ];
    const edges = [
      makeEdge('e1', 'n1', 'n2'),
      makeEdge('e2', 'n2', 'n3'),
      makeEdge('e3', 'n1', 'n4'),
      makeEdge('e4', 'n4', 'n5'),
    ];

    const res = extractSubtree('n4', nodes, edges);
    assert.deepEqual(
      res.subtreeNodes.map((n) => n.id).sort(),
      ['n4', 'n5']
    );
    assert.deepEqual(
      res.subtreeEdges.map((e) => e.id),
      ['e4']
    );
    assert.deepEqual(
      res.remainingNodes.map((n) => n.id).sort(),
      ['n1', 'n2', 'n3']
    );
    // remainingEdges: 两端都不在子树中的边
    assert.deepEqual(
      res.remainingEdges.map((e) => e.id).sort(),
      ['e1', 'e2']
    );
  });

  test('环形拓扑防御：防死循环挂起 (#0006)', () => {
    // 构造环: a -> b -> c -> a
    const nodes = [makeChatNode('a', 'Qa'), makeChatNode('b', 'Qb'), makeChatNode('c', 'Qc')];
    const edges = [
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'a'),
    ];

    const res = extractSubtree('a', nodes, edges);
    assert.equal(res.subtreeNodes.length, 3, '环上所有节点均被安全汇聚');
    assert.equal(res.remainingNodes.length, 0);
  });
});

describe('祖先上下文回溯与滑动窗口机制 (buildAncestorContext - #0099 / #0030)', () => {
  test('基础单链回溯 (Root -> Target)', () => {
    const root = makeChatNode('root', '什么是超导现象？', '超导是指材料在特定低温下电阻为零的现象。');
    const target = makeChatNode('target', '临界温度是多少？');
    const edges = [makeEdge('e1', 'root', 'target')];

    const context = buildAncestorContext('target', [root, target], edges);
    assert.equal(context.length, 2);
    assert.equal(context[0].role, 'user');
    assert.equal(context[0].content, '什么是超导现象？');
    assert.equal(context[1].role, 'assistant');
    assert.equal(context[1].content, '超导是指材料在特定低温下电阻为零的现象。');
  });

  test('目标节点隔离：重试生成时不包含 targetNodeId 自身的历史答案', () => {
    const root = makeChatNode('root', '量子力学导论', '量子力学是微观物理基石。');
    // target 节点因重新生成，已有旧答案
    const target = makeChatNode('target', '不确定性原理', '这里是旧的回答，不应被包含');
    const edges = [makeEdge('e1', 'root', 'target')];

    const context = buildAncestorContext('target', [root, target], edges);
    // 应该只包含 root 的问答，不应包含 target 自身的旧答案
    assert.equal(context.length, 2);
    assert.equal(context[0].content, '量子力学导论');
    assert.equal(context[1].content, '量子力学是微观物理基石。');
  });

  test('分支切入点注入：中间祖先携带 branchTriggerPhrase 时格式化深入探讨重点', () => {
    const root = makeChatNode('root', '介绍微积分的基本定理', '牛顿-莱布尼茨公式建立了微分与积分的联系。');
    const parent = makeChatNode(
      'parent',
      '黎曼积分是如何定义的？',
      '黎曼积分通过黎曼和的极限来定义区间上的积分值。',
      { branchTriggerPhrase: '积分定义机制' }
    );
    const target = makeChatNode('target', '勒贝格积分与它有什么区别？');

    const edges = [makeEdge('e1', 'root', 'parent'), makeEdge('e2', 'parent', 'target')];

    const context = buildAncestorContext('target', [root, parent, target], edges);
    assert.equal(context.length, 4);
    assert.equal(context[0].content, '介绍微积分的基本定理');
    // parent 具有 branchTriggerPhrase，应携带探讨标签
    assert.ok(context[2].content.includes('[深入探讨分支重点: "积分定义机制"]'));
    assert.ok(context[2].content.includes('黎曼积分是如何定义的？'));
  });

  test('深层链路滑动窗口（12 层深挖）：根节点永不丢失 (Root Anchoring) 且中间层折叠压缩', () => {
    // 构造一条长达 12 层的长链：node-0 (root) -> node-1 -> ... -> node-11 -> node-12 (target)
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    for (let i = 0; i <= 12; i++) {
      const q = `第 ${i} 层探究问题：探究深度细节 ${i}`;
      // 给每层答案制造约 300 字的长文本，包含 ---SUGGESTIONS---
      const a = `第 ${i} 层的核心论据。这里是长篇推演过程，包含了大量背景分析和论证步骤，探讨了深度 ${i} 的系统原理与边界效应。\n---SUGGESTIONS---\n问题A\n问题B`;
      nodes.push(makeChatNode(`node-${i}`, q, a));
      if (i > 0) {
        edges.push(makeEdge(`edge-${i}`, `node-${i - 1}`, `node-${i}`));
      }
    }

    // 默认 maxDepth=10, preserveRecentTurns=3
    const context = buildAncestorContext('node-12', nodes, edges);

    // 1. 严格以 user 开头
    assert.equal(context[0].role, 'user');
    // 2. 核心保障：根节点 (node-0) 的提问必须常驻！
    assert.ok(
      context[0].content.includes('第 0 层探究问题'),
      '根节点问题必须永远保留在首位（Root Anchoring）'
    );

    // 3. 严格角色交替 user -> assistant -> user -> assistant ...
    for (let i = 0; i < context.length; i++) {
      const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
      assert.equal(
        context[i].role,
        expectedRole,
        `第 ${i} 个消息的角色应为 ${expectedRole}，实际为 ${context[i].role}`
      );
    }

    // 4. 最近 3 轮（node-9, node-10, node-11）应保持高保真
    const lastUserTurn = context[context.length - 2];
    const lastAssistantTurn = context[context.length - 1];
    assert.ok(lastUserTurn.content.includes('第 11 层探究问题'));
    assert.ok(lastAssistantTurn.content.includes('第 11 层的核心论据'));

    // 5. 远端中间节点应被精简摘要（包含提炼标记或长度紧凑，且不含 SUGGESTIONS）
    for (const msg of context) {
      assert.ok(!msg.content.includes('SUGGESTIONS'), '不应含任何过时建议标记');
    }
  });

  test('防环处理：拓扑中存在回环时安全终止回溯', () => {
    // 环: a -> b -> c -> a，target 挂在 c 上
    const a = makeChatNode('a', 'Qa', 'Aa');
    const b = makeChatNode('b', 'Qb', 'Ab');
    const c = makeChatNode('c', 'Qc', 'Ac');
    const target = makeChatNode('target', 'Qtarget');

    const edges = [
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'a'),
      makeEdge('e4', 'c', 'target'),
    ];

    const context = buildAncestorContext('target', [a, b, c, target], edges);
    assert.ok(context.length > 0, '应成功提取祖先链');
    assert.ok(context.length <= 6, '不应因环进入死循环');
    assert.equal(context[0].role, 'user');
  });

  test('预算紧缩降级：在超小字符与 Token 预算下自适应压缩超长内容', () => {
    const root = makeChatNode('root', 'Root Q', 'A'.repeat(5000));
    const parent = makeChatNode('parent', 'Parent Q', 'B'.repeat(5000));
    const target = makeChatNode('target', 'Target Q');
    const edges = [makeEdge('e1', 'root', 'parent'), makeEdge('e2', 'parent', 'target')];

    // 严格限制最大 1000 字符预算
    const context = buildAncestorContext('target', [root, parent, target], edges, {
      maxCharLength: 1000,
      maxTokenBudget: 300,
    });

    const totalChars = context.reduce((acc, m) => acc + m.content.length, 0);
    // 超长文本被折叠，总字符数不应暴涨
    assert.ok(totalChars < 3000, `Context chars should be heavily condensed: ${totalChars}`);
    assert.equal(context[0].role, 'user');
    assert.equal(context[0].content, 'Root Q');
  });
});
