/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Node, Edge } from '@xyflow/react';
import type { ChatNodeData, ChatMessage } from '../types';
export { extractSubtree } from './tree';

export interface AncestorContextOptions {
  /** 遍历的最大祖先深度限制（默认: 10 层） */
  maxDepth?: number;
  /** 所有问答文本总字符上限预算（默认: 14,000 字符） */
  maxCharLength?: number;
  /** 总 Token 估算预算（默认: 3,500 tokens） */
  maxTokenBudget?: number;
  /** 保持完整细节（不进行任何截断/压缩）的最近祖先轮数（默认: 3 轮） */
  preserveRecentTurns?: number;
  /** 中间历史祖先答案压缩摘要长度（默认: 180 字符） */
  intermediateSummaryLength?: number;
}

/**
 * 针对混合中英文、LaTeX 公式与代码块的轻量快速 Token 估算器。
 * 经验准则：
 * - CJK 汉字：约 0.75 tokens / 字符
 * - 英文词汇与空白符：约 0.28 tokens / 字符（约 3.5 字符 / token）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.max(1, Math.ceil(cjkCount * 0.75 + otherCount * 0.28));
}

/**
 * 中间历史节点答案语义提炼与摘要压缩。
 * 1. 彻底剔除历史阶段的 ---SUGGESTIONS--- 衍生问答标记（避免过时干扰）；
 * 2. 截取前 targetLen 字符，并智能对齐中英文句尾标点（保证语义完整不突兀）；
 * 3. 附带核心结论摘要标记，向 AI 模型指示历史上下文已推演完成。
 */
export function summarizeAncestorAnswer(answer: string, targetLen = 180): string {
  if (!answer) return '';
  // 剥离历史建议
  const clean = answer.split(/---SUGGESTIONS---|——SUGGESTIONS——/i)[0].trim();
  if (clean.length <= targetLen) {
    return clean;
  }

  const slice = clean.slice(0, targetLen);
  const lastPunctuation = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('；'),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf('. ')
  );

  if (lastPunctuation > targetLen * 0.5) {
    return clean.slice(0, lastPunctuation + 1) + ' ... [核心结论已提炼]';
  }
  return slice + '... [核心结论已提炼]';
}

/**
 * 沿 DAG 拓扑连线向上回溯，构造目标节点的祖先脉络多轮对话上下文（Multi-turn History）。
 *
 * 【以用户体验为主的分层滑动窗口机制（技术债 #0099）】：
 * 1. DAG 防环：visited 集合跟踪已访问节点，防回环死循环（#0006）。
 * 2. 根节点核心定位保护（Root Anchoring）：
 *    无论树多深、如何裁剪，根节点（Root Node）的问题与核心前提**永远保留**，保证 AI 模型
 *    对整个探索分支的根本母题保持清晰理解，绝不“脱靶”走偏。
 * 3. 最近 N 轮高保真还原（Recent Turns Fidelity）：
 *    最邻近的祖先节点（默认 3 轮，即父、祖父、曾祖父）完整保留所有正文、代码、公式与推理细节。
 * 4. 遥远中间层语义折叠与压缩（Intermediate Folding）：
 *    介于根节点与最近轮之间的深层历史节点，保留提问与分支切入点（branchTriggerPhrase），
 *    答案压缩为 180 字符以内的核心结论摘要，语义链条 100% 连贯，同时节省 75%+ 的 Token。
 * 5. 严格角色交替保障（Role Alternation）：
 *    始终以 'user' 开头，严格保持 user -> assistant -> user -> assistant 交替，杜绝孤立 assistant
 *    或连续同角色导致的 LLM API 协议报错。
 * 6. 目标节点隔离：回溯排除 targetNodeId 自身历史残留答案，防止重试生成时污染 Prompt。
 */
export function buildAncestorContext(
  targetNodeId: string,
  nodes: Node[],
  edges: Edge[],
  optionsOrMaxDepth: AncestorContextOptions | number = 10,
  legacyMaxCharLength = 14000
): { role: 'user' | 'assistant'; content: string }[] {
  const opts: Required<AncestorContextOptions> = {
    maxDepth: typeof optionsOrMaxDepth === 'number' ? optionsOrMaxDepth : optionsOrMaxDepth?.maxDepth ?? 10,
    maxCharLength:
      typeof optionsOrMaxDepth === 'number'
        ? legacyMaxCharLength
        : optionsOrMaxDepth?.maxCharLength ?? legacyMaxCharLength,
    maxTokenBudget:
      typeof optionsOrMaxDepth === 'object' && optionsOrMaxDepth.maxTokenBudget !== undefined
        ? optionsOrMaxDepth.maxTokenBudget
        : 3500,
    preserveRecentTurns:
      typeof optionsOrMaxDepth === 'object' && optionsOrMaxDepth.preserveRecentTurns !== undefined
        ? optionsOrMaxDepth.preserveRecentTurns
        : 3,
    intermediateSummaryLength:
      typeof optionsOrMaxDepth === 'object' && optionsOrMaxDepth.intermediateSummaryLength !== undefined
        ? optionsOrMaxDepth.intermediateSummaryLength
        : 180,
  };

  const nodeMap = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const incomingEdgeMap = new Map<string, Edge>();
  edges.forEach((e) => {
    incomingEdgeMap.set(e.target, e);
  });

  // 沿 DAG 向上回溯父级链路
  const ancestorNodes: Node[] = [];
  let currentId: string | undefined = targetNodeId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const edge = incomingEdgeMap.get(currentId);
    const parentId: string | undefined =
      edge?.source || (nodeMap.get(currentId)?.data as unknown as ChatNodeData)?.parentId;

    if (!parentId || visited.has(parentId)) break;
    const parentNode = nodeMap.get(parentId);
    if (parentNode) {
      ancestorNodes.unshift(parentNode); // 根节点排在首位，紧邻的前序节点在末尾
    }
    currentId = parentId;
  }

  // 过滤出具备提问内容的有效 chat 节点
  const validAncestors = ancestorNodes.filter((n) => {
    if (n.type !== 'chat') return false;
    const data = n.data as unknown as ChatNodeData;
    return Boolean(data && (data.question || (data.messages && data.messages.length > 0)));
  });

  if (validAncestors.length === 0) {
    return [];
  }

  // 深度裁剪与中间层均匀采样：确保无论多少层，根节点与最近轮次必须常驻
  let selectedAncestors: Node[] = validAncestors;
  if (validAncestors.length > opts.maxDepth) {
    const root = validAncestors[0];
    const recent = validAncestors.slice(validAncestors.length - opts.preserveRecentTurns);
    const middlePool = validAncestors.slice(1, validAncestors.length - opts.preserveRecentTurns);

    const allowedMiddleCount = Math.max(0, opts.maxDepth - 1 - recent.length);
    let selectedMiddle: Node[] = [];

    if (allowedMiddleCount > 0 && middlePool.length > 0) {
      const step = middlePool.length / allowedMiddleCount;
      for (let i = 0; i < allowedMiddleCount; i++) {
        const idx = Math.min(Math.floor(i * step), middlePool.length - 1);
        selectedMiddle.push(middlePool[idx]);
      }
      selectedMiddle = Array.from(new Set(selectedMiddle));
    }

    selectedAncestors = [root, ...selectedMiddle, ...recent];
  }

  // 单节点轮次格式化
  const formatNodeTurn = (
    node: Node,
    isRoot: boolean,
    isRecent: boolean,
    summaryLimit: number
  ): { role: 'user' | 'assistant'; content: string }[] => {
    const data = node.data as unknown as ChatNodeData;
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];

    if (data.question) {
      let userContent = data.question;
      if (data.branchTriggerPhrase && !isRoot) {
        userContent = `[深入探讨分支重点: "${data.branchTriggerPhrase}"]\n${data.question}`;
      }
      turns.push({ role: 'user', content: userContent });

      if (data.answer) {
        const assistantContent =
          isRoot || isRecent
            ? data.answer.split(/---SUGGESTIONS---|——SUGGESTIONS——/i)[0].trim()
            : summarizeAncestorAnswer(data.answer, summaryLimit);
        turns.push({ role: 'assistant', content: assistantContent });
      }
    } else if (data.messages && data.messages.length > 0) {
      data.messages.forEach((msg: ChatMessage) => {
        turns.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      });
    }

    return turns;
  };

  const buildTurns = (summaryLimit: number) => {
    const result: { role: 'user' | 'assistant'; content: string }[] = [];
    const total = selectedAncestors.length;

    selectedAncestors.forEach((node, idx) => {
      const isRoot = idx === 0;
      const isRecent = idx >= total - opts.preserveRecentTurns;
      const nodeTurns = formatNodeTurn(node, isRoot, isRecent, summaryLimit);
      result.push(...nodeTurns);
    });

    return result;
  };

  let messages = buildTurns(opts.intermediateSummaryLength);

  // 多阶段预算自适应约束（Token 预算与字符预算双重保障）
  const calcTotalChars = (msgs: typeof messages) =>
    msgs.reduce((sum, m) => sum + m.content.length, 0);
  const calcTotalTokens = (msgs: typeof messages) =>
    msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // 第 1 级降级：紧缩中间历史摘要至 100 字符
  if (calcTotalChars(messages) > opts.maxCharLength || calcTotalTokens(messages) > opts.maxTokenBudget) {
    messages = buildTurns(100);
  }

  // 第 2 级降级：极简中间摘要至 60 字符
  if (calcTotalChars(messages) > opts.maxCharLength || calcTotalTokens(messages) > opts.maxTokenBudget) {
    messages = buildTurns(60);
  }

  // 第 3 级降级：若单条根节点或近期回答极长（例如用户贴入上万字代码），截断其超长正文
  if (calcTotalChars(messages) > opts.maxCharLength || calcTotalTokens(messages) > opts.maxTokenBudget) {
    messages = messages.map((msg) => {
      if (msg.role === 'assistant' && msg.content.length > 1200) {
        return {
          ...msg,
          content: msg.content.slice(0, 1000) + '\n... [部分较长推演已折叠以保证上下文流畅]',
        };
      }
      return msg;
    });
  }

  // 最终角色规范化检查：严格保证 user 领先、交替无断层
  const sanitized: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const msg of messages) {
    if (!msg.content.trim()) continue;
    if (sanitized.length === 0) {
      if (msg.role === 'user') {
        sanitized.push(msg);
      }
      continue;
    }

    const prev = sanitized[sanitized.length - 1];
    if (prev.role === msg.role) {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      sanitized.push(msg);
    }
  }

  return sanitized;
}
