/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1/R2 — AI 练习模式公共常量与配置。
 */
import type { QuizDifficulty } from '../../lib/quiz-store';

export const DIFFICULTY_LABELS: Record<QuizDifficulty, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '困难',
};

export const DIFFICULTY_DESCS: Record<QuizDifficulty, { title: string; desc: string; detail: string }> = {
  beginner: {
    title: '入门 · 概念辨识',
    desc: '核心概念、定义直给与基础记忆',
    detail: '适合初学或快速热身，聚焦学科基础术语辨识',
  },
  intermediate: {
    title: '进阶 · 机制推理',
    desc: '单步推理、因果逻辑与应用场景',
    detail: '考查理解深度与关联推导，检验是否真正吃透机制',
  },
  advanced: {
    title: '困难 · 综合迁移',
    desc: '复杂情境分析、边界条件与误区辨析',
    detail: '高阶心智挑战，题干更丰富，需多步推理综合判断',
  },
};

/** 困难档题量默认 3，入门与进阶默认 5（选择器始终可改） */
export const DEFAULT_COUNT: Record<QuizDifficulty, number> = {
  beginner: 5,
  intermediate: 5,
  advanced: 3,
};

/** 推荐练习主题 Pills */
export const RECOMMENDED_TOPICS = [
  'Transformer 多头注意力机制',
  'TCP 三次握手与状态流转',
  '高中生物光合作用光反应',
  '微积分基本定理与几何意义',
  'Raft 分布式共识机制',
  '快速排序与时间复杂度分析',
  '量子计算叠加态与量子纠缠',
  '边际效用递减与机会成本',
];
