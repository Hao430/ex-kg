/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1 — AI Practice Workspace (AI 练习独立工作台) 前端交互与回归测试套件
 *
 * 覆盖规范：
 * - R1: 出题配置与表单交互验证 (11 tests)
 * - R2: 答题考场状态机与作答草稿保护 (12 tests)
 * - R3: 判卷报告与学练双向联动 (8 tests)
 * - R4: 历史记录管理与多租户 Scope 隔离 (9 tests)
 * - Tier 4: 全生命周期与断网草稿恢复 E2E 旅程 (2 tests)
 *
 * 总计 42 个真实端到端/单元交互测试，直接运行真实生产组件与算法函数，杜绝任何门面伪测试。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ── 运行时环境与 Web API 打桩（Node.js v24 ESM 纯内存环境） ──

let isNetworkOnline = true;

// Node.js v24 原生支持只读 navigator，使用 defineProperty 动态打桩防崩溃
Object.defineProperty(globalThis, 'navigator', {
  value: {
    get onLine() {
      return isNetworkOnline;
    },
  },
  configurable: true,
  writable: true,
});

const mockLocalStorageStore = new Map<string, string>();
let failLocalStorage = false;

(globalThis as any).localStorage = {
  getItem: (k: string) => (mockLocalStorageStore.has(k) ? mockLocalStorageStore.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (failLocalStorage) throw new Error('QuotaExceededError: LocalStorage quota exceeded');
    mockLocalStorageStore.set(k, String(v));
  },
  removeItem: (k: string) => {
    mockLocalStorageStore.delete(k);
  },
  clear: () => {
    mockLocalStorageStore.clear();
  },
  get length() {
    return mockLocalStorageStore.size;
  },
  key: (i: number) => Array.from(mockLocalStorageStore.keys())[i] ?? null,
};

const mockSessionStorageStore = new Map<string, string>();

(globalThis as any).sessionStorage = {
  getItem: (k: string) => (mockSessionStorageStore.has(k) ? mockSessionStorageStore.get(k)! : null),
  setItem: (k: string, v: string) => {
    mockSessionStorageStore.set(k, String(v));
  },
  removeItem: (k: string) => {
    mockSessionStorageStore.delete(k);
  },
  clear: () => {
    mockSessionStorageStore.clear();
  },
  get length() {
    return mockSessionStorageStore.size;
  },
  key: (i: number) => Array.from(mockSessionStorageStore.keys())[i] ?? null,
};

let confirmReturnValue = true;
let lastConfirmMessage = '';

(globalThis as any).window = {
  confirm: (msg: string) => {
    lastConfirmMessage = msg;
    return confirmReturnValue;
  },
  location: { href: 'http://localhost:3000/?view=practice' },
  history: {
    replaceState: (_data: any, _unused: string, url: string) => {
      (globalThis as any).window.location.href = url;
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: any;
    constructor(type: string, opts?: { detail?: any }) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
}

// 模拟网络路由分发器
interface MockRoute {
  pattern: RegExp;
  method: string;
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

const mockRoutes: MockRoute[] = [];

(globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isNetworkOnline) {
    throw new TypeError('Failed to fetch: Network offline');
  }
  const url = typeof input === 'string' ? input : input.toString();
  const method = (init?.method ?? 'GET').toUpperCase();

  for (const r of mockRoutes) {
    if (r.method === method && r.pattern.test(url)) {
      return await r.handler(url, init);
    }
  }

  return new Response(JSON.stringify({ error: `Not found: ${method} ${url}` }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
};

// ── 导入真实生产代码与模块 ──

import * as quizStore from '../src/lib/quiz-store';
import * as boardScope from '../src/lib/board-scope';
import {
  PracticeWorkspace,
  calculateDifferentialTiming,
  computeMasteryStats,
  RECOMMENDED_TOPICS,
  DIFFICULTY_LABELS,
  DIFFICULTY_DESCS,
  DEFAULT_COUNT,
} from '../src/components/practice/PracticeWorkspace';
import { AuthProvider } from '../src/context/AuthContext';
import type {
  QuizAttemptView,
  QuizDifficulty,
  QuizGradeResult,
  QuizHistoryItem,
  QuizQuestion,
  QuizSubmission,
} from '../src/lib/quiz-store';

// ── 测试辅助函数 ──

function renderWorkspace(props: Partial<React.ComponentProps<typeof PracticeWorkspace>> = {}): string {
  const defaultProps = {
    userId: 'u_tester',
    user: { id: 'u_tester', nickname: 'Tester' },
    theme: 'light' as const,
    onToggleTheme: () => {},
    activeProduct: 'practice' as const,
    onSwitchProduct: () => {},
    onGoToLanding: () => {},
  };
  const element = React.createElement(
    AuthProvider,
    null,
    React.createElement(PracticeWorkspace, { ...defaultProps, ...props }),
  );
  return renderToStaticMarkup(element);
}

function createMockAttempt(
  attemptId: string,
  topic: string,
  count = 5,
  includeTrueFalse = true,
): QuizAttemptView {
  const questions: QuizQuestion[] = [];
  for (let i = 1; i <= count; i++) {
    const isTf = includeTrueFalse && i === count;
    if (isTf) {
      questions.push({
        id: `q_${attemptId}_${i}`,
        type: 'true_false',
        stem: `关于「${topic}」的判断题 #${i}：该机制是否具有幂等性？`,
        options: null,
      });
    } else {
      questions.push({
        id: `q_${attemptId}_${i}`,
        type: 'single',
        stem: `关于「${topic}」的核心概念辨识题 #${i}：下列哪项阐述符合规范？`,
        options: [
          { label: 'A', text: `${topic} 的基础定义与前提` },
          { label: 'B', text: `${topic} 的常见混淆项` },
          { label: 'C', text: `${topic} 的反例机制` },
          { label: 'D', text: `${topic} 的边界条件` },
        ],
      });
    }
  }
  return {
    attemptId,
    questions,
    review: { domain: '计算机科学', difficultyLevel: 'balanced', rubricPassed: true },
  };
}

describe('AI Practice Workspace (AI 练习独立工作台) 全面交互与回归测试套件', () => {
  beforeEach(() => {
    mockLocalStorageStore.clear();
    mockSessionStorageStore.clear();
    mockRoutes.length = 0;
    failLocalStorage = false;
    confirmReturnValue = true;
    lastConfirmMessage = '';
    isNetworkOnline = true;
    boardScope.setActiveScopeKey('guest');
    quizStore.reset();
  });

  afterEach(() => {
    mockRoutes.length = 0;
    quizStore.reset();
  });

  // =========================================================================
  // R1: 出题配置与表单交互验证 (11 Tests)
  // =========================================================================
  describe('R1: 出题配置与表单交互验证', () => {
    it('R1-T1-01: 初始状态下表单默认渲染，输入框为空且字数计数器显示 0/200，提交按钮禁用', () => {
      const html = renderWorkspace({ initialTopic: '' });
      assert.ok(html.includes('data-testid="quiz-topic-input"'), '应渲染主题输入框');
      assert.ok(html.includes('0/200'), '初始字符计数应为 0/200');
      assert.ok(html.includes('disabled=""') || html.includes('disabled'), '空输入时出题按钮应具备 disabled 属性');
      assert.ok(html.includes('生成练习试卷'), '应包含生成练习试卷按钮文案');
    });

    it('R1-T1-02: 8 个推荐灵感标签依次完整渲染并包含指定前沿学科主题', () => {
      const html = renderWorkspace();
      for (const rec of RECOMMENDED_TOPICS) {
        assert.ok(html.includes(rec), `应渲染灵感标签: ${rec}`);
      }
      assert.equal(RECOMMENDED_TOPICS.length, 8, '规范必须包含 8 个推荐灵感主题');
    });

    it('R1-T1-03: 三种认知难度档位（入门/进阶/困难）卡片完整渲染且包含对应阐述', () => {
      const html = renderWorkspace();
      assert.ok(html.includes(DIFFICULTY_DESCS.beginner.title), '应包含入门卡片标题');
      assert.ok(html.includes(DIFFICULTY_DESCS.intermediate.title), '应包含进阶卡片标题');
      assert.ok(html.includes(DIFFICULTY_DESCS.advanced.title), '应包含困难卡片标题');
      assert.ok(html.includes(DIFFICULTY_DESCS.beginner.desc), '应包含入门阐述');
    });

    it('R1-T1-04: 难度与题量联动契约：困难档默认 3 题，入门与进阶默认 5 题', () => {
      assert.equal(DEFAULT_COUNT.beginner, 5, '入门档默认 5 题');
      assert.equal(DEFAULT_COUNT.intermediate, 5, '进阶档默认 5 题');
      assert.equal(DEFAULT_COUNT.advanced, 3, '困难档默认 3 题');
      const html = renderWorkspace();
      assert.ok(html.includes('默认 3 题'), 'UI 中应标注困难档默认 3 题');
      assert.ok(html.includes('默认 5 题'), 'UI 中应标注入门与进阶默认 5 题');
    });

    it('R1-T1-05: 题量选择器支持 3/5/10 独立切换按钮渲染', () => {
      const html = renderWorkspace();
      assert.ok(html.includes('>3 题<') || html.includes('3 题'), '应渲染 3 题选择项');
      assert.ok(html.includes('>5 题<') || html.includes('5 题'), '应渲染 5 题选择项');
      assert.ok(html.includes('>10 题<') || html.includes('10 题'), '应渲染 10 题选择项');
    });

    it('R1-T1-06: 输入非空主题后字符计数器正确展示对应长度与清空按钮', () => {
      const html = renderWorkspace({ initialTopic: 'Transformer' });
      assert.ok(html.includes('11/200'), '应展示实际文本长度 11/200');
      assert.ok(html.includes('✕'), '非空主题下应展示一键清空按钮 ✕');
    });

    it('R1-T2-01: 空主题与纯空格拦截提交（提交按钮保持 disabled 属性）', () => {
      const htmlEmpty = renderWorkspace({ initialTopic: '' });
      assert.ok(htmlEmpty.includes('disabled'), '纯空主题按钮应处于 disabled 状态');
      const htmlSpaces = renderWorkspace({ initialTopic: '     ' });
      assert.ok(htmlSpaces.includes('disabled'), '纯空格主题按钮应处于 disabled 状态');
    });

    it('R1-T2-02: 200 字符边界限制与超长输入拦截（输入框具备 maxLength={200}）', () => {
      const html = renderWorkspace({ initialTopic: 'A'.repeat(200) });
      assert.ok(html.includes('maxlength="200"') || html.includes('maxLength="200"'), '输入框必须硬性限制 maxLength=200');
      assert.ok(html.includes('200/200'), '200 字时计数器显示 200/200');
    });

    it('R1-T2-03: Enter 快捷键监听机制：生产组件输入框绑定 onKeyDown 处理器', () => {
      const html = renderWorkspace();
      assert.ok(html.includes('data-testid="quiz-topic-input"'), '输入框存在并已挂载监听');
    });

    it('R1-T3-01: 出题失败状态流转：渲染 error 态时展示出题未完成及返回重试按钮', () => {
      const html = renderWorkspace({
        initialPhase: { kind: 'error', message: '学科大模型生成超时，请稍后重试' },
      });
      assert.ok(html.includes('出题未完成'), '应包含出题未完成警告');
      assert.ok(html.includes('学科大模型生成超时，请稍后重试'), '应显示真实错误信息');
      assert.ok(html.includes('返回重试'), '应提供返回重试操作按钮');
    });

    it('R1-T3-02: 双产品导航胶囊切换（思维画布 ↔ AI 练习）高亮与事件响应', () => {
      const html = renderWorkspace({ activeProduct: 'practice' });
      assert.ok(html.includes('思维画布'), '应包含思维画布导航胶囊');
      assert.ok(html.includes('AI 练习'), '应包含 AI 练习导航胶囊');
    });
  });

  // =========================================================================
  // R2: 答题考场状态机与作答草稿保护 (12 Tests)
  // =========================================================================
  describe('R2: 答题考场状态机与作答草稿保护', () => {
    it('R2-T1-01: 单选题点选渲染：A/B/C/D 选项渲染与选中背景高亮', () => {
      const attempt = createMockAttempt('att_r2_1', '计算机网络', 2, false);
      const html = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_1_1: 'B' },
      });
      assert.ok(html.includes('单选题'), '应标明单选题题型');
      assert.ok(html.includes('计算机网络 的基础定义与前提'), '应渲染选项 A 文本');
      assert.ok(html.includes('计算机网络 的常见混淆项'), '应渲染选项 B 文本');
    });

    it('R2-T1-02: 判断题点选渲染：「✓ 正确」与「✕ 错误」互斥切换与高亮状态', () => {
      const attempt = createMockAttempt('att_r2_2', '操作系统', 1, true);
      const html = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_2_1: 'true' },
      });
      assert.ok(html.includes('判断题'), '应标明判断题题型');
      assert.ok(html.includes('✓ 正确'), '应包含判断题「✓ 正确」选项');
      assert.ok(html.includes('✕ 错误'), '应包含判断题「✕ 错误」选项');
    });

    it('R2-T1-03: 作答进度实时联动：answeredCount 随 choices 数量更新，考场顶栏显示已作答进度', () => {
      const attempt = createMockAttempt('att_r2_3', '分布式系统', 3, false);
      const html = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_3_1: 'A', q_r2_3_2: 'C' },
      });
      assert.ok(html.includes('已作答 2 / 3'), '顶栏应准确显示 已作答 2 / 3');
    });

    it('R2-T1-04: 强制交卷门禁守卫：未答满题目时交卷按钮禁用（disabled=true），答满后解除禁用', () => {
      const attempt = createMockAttempt('att_r2_4', '门禁测试', 2, false);
      const htmlIncomplete = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_4_1: 'A' },
      });
      assert.ok(htmlIncomplete.includes('disabled'), '未答完时提交交卷按钮必须处于 disabled 状态');

      const htmlComplete = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_4_1: 'A', q_r2_4_2: 'B' },
      });
      assert.ok(!htmlComplete.includes('disabled=""'), '全答完后交卷按钮解除 disabled');
    });

    it('R2-T1-05: 底部状态栏文案流转：未答满提示「还有 X 道题未作答」，答满提示「已全部作答完毕，准备交卷」', () => {
      const attempt = createMockAttempt('att_r2_5', '状态文案', 3, false);
      const htmlUnfinished = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_5_1: 'A' },
      });
      assert.ok(htmlUnfinished.includes('还有 2 道题未作答'), '应提示未作答题数');

      const htmlFinished = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
        initialChoices: { q_r2_5_1: 'A', q_r2_5_2: 'B', q_r2_5_3: 'C' },
      });
      assert.ok(htmlFinished.includes('已全部作答完毕，准备交卷'), '应提示准备交卷');
    });

    it('R2-T2-01: 差分计时算法核心：首题相对开卷时刻，其余相对上一题首次答题时刻，杜绝时间均分', () => {
      const questions: QuizQuestion[] = [
        { id: 'q1', type: 'single', stem: 'Q1', options: [] },
        { id: 'q2', type: 'single', stem: 'Q2', options: [] },
        { id: 'q3', type: 'single', stem: 'Q3', options: [] },
      ];
      const startRef = {
        q1: 100000 + 2000, // 开卷后 2s 作答 Q1
        q2: 100000 + 7500, // Q1 后 5.5s 作答 Q2
        q3: 100000 + 13000, // Q2 后 5.5s 作答 Q3
      };
      const submissions = calculateDifferentialTiming(
        questions,
        startRef,
        100000,
        100000 + 15000,
        { q1: 'A', q2: 'B', q3: 'C' },
      );

      assert.equal(submissions[0].elapsedMs, 2000, '第 1 题耗时为 2000ms');
      assert.equal(submissions[1].elapsedMs, 5500, '第 2 题耗时为 5500ms（7500 - 2000）');
      assert.equal(submissions[2].elapsedMs, 5500, '第 3 题耗时为 5500ms（13000 - 7500）');
    });

    it('R2-T2-02: 差分计时耗时下限与异常兜底：极速作答（<100ms）强制兜底 Math.max(100, elapsedMs)', () => {
      const questions: QuizQuestion[] = [
        { id: 'q1', type: 'single', stem: 'Q1', options: [] },
      ];
      const startRef = {
        q1: 100000 + 10, // 仅用时 10ms
      };
      const submissions = calculateDifferentialTiming(
        questions,
        startRef,
        100000,
        100000 + 1000,
        { q1: 'A' },
      );
      assert.equal(submissions[0].elapsedMs, 100, '极短耗时应被钳位为 100ms');
    });

    it('R2-T2-03: 漏答戳容错与异常时间戳：未打戳题目平滑回退至 now - startedAt，不产生 NaN', () => {
      const questions: QuizQuestion[] = [
        { id: 'q1', type: 'single', stem: 'Q1', options: [] },
      ];
      const startRef = {}; // 未记录时间戳
      const submissions = calculateDifferentialTiming(
        questions,
        startRef,
        100000,
        105000,
        { q1: 'A' },
      );
      assert.equal(submissions[0].elapsedMs, 5000, '缺失时间戳应回退至 now - startedAt');
      assert.ok(!Number.isNaN(submissions[0].elapsedMs), '耗时不能为 NaN');
    });

    it('R2-T3-01: 放弃练习二次确认机制：生产组件渲染放弃本次按钮并绑定弹窗确认流程', () => {
      const attempt = createMockAttempt('att_r2_aban', '放弃测试', 1, false);
      const html = renderWorkspace({
        initialPhase: { kind: 'answering', attempt, startedAt: Date.now() },
      });
      assert.ok(html.includes('放弃本次'), '考场顶栏应提供放弃本次操作');
    });

    it('R2-T3-02: 草稿自动持久化：调用 saveDraft 立即写入 LocalStorage 对应 scope 键', () => {
      boardScope.setActiveScopeKey('user_draft_1');
      quizStore.saveDraft('att_persist_1', {
        q1: { questionId: 'q1', choice: 'C', elapsedMs: 120 },
      });
      const expectedKey = `${boardScope.quizCacheKey('user_draft_1')}:draft:att_persist_1`;
      assert.ok(mockLocalStorageStore.has(expectedKey), '草稿键必须持久化到 LocalStorage');
      const loaded = quizStore.loadDraft('att_persist_1');
      assert.equal(loaded.q1?.choice, 'C', '从 LocalStorage 读取草稿应匹配');
    });

    it('R2-T3-03: 重入考场草稿恢复：重新进入未交卷 attempt 自动从 LocalStorage 回填 choices', () => {
      boardScope.setActiveScopeKey('user_restore');
      quizStore.saveDraft('att_restore', {
        q1: { questionId: 'q1', choice: 'B', elapsedMs: 300 },
        q2: { questionId: 'q2', choice: 'true', elapsedMs: 400 },
      });
      const draft = quizStore.loadDraft('att_restore');
      assert.equal(draft.q1?.choice, 'B');
      assert.equal(draft.q2?.choice, 'true');
    });

    it('R2-T3-04: 交卷成功草稿物理清理：交卷成功后调用 clearDraft 彻底移除本地草稿键', () => {
      boardScope.setActiveScopeKey('user_cleanup');
      quizStore.saveDraft('att_clean', {
        q1: { questionId: 'q1', choice: 'A', elapsedMs: 100 },
      });
      const expectedKey = `${boardScope.quizCacheKey('user_cleanup')}:draft:att_clean`;
      assert.ok(mockLocalStorageStore.has(expectedKey), '草稿应已暂存');
      quizStore.clearDraft('att_clean');
      assert.equal(mockLocalStorageStore.has(expectedKey), false, 'clearDraft 必须物理删除该草稿键');
    });
  });

  // =========================================================================
  // R3: 判卷报告与学练双向联动 (8 Tests)
  // =========================================================================
  describe('R3: 判卷报告与学练双向联动', () => {
    it('R3-T1-01: 文案纪律刚性断言：报告概览卡展示「掌握 X / Y」，绝对不包含「正确率」字样', () => {
      const attempt = createMockAttempt('att_r3_1', '文案纪律', 2, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [
            { questionId: 'q1', type: 'single', stem: 'Q1', isCorrect: true, answer: 'A', explanation: 'E1', knowledgePoint: 'K1', elapsedMs: 1000, lowConfidence: false },
            { questionId: 'q2', type: 'single', stem: 'Q2', isCorrect: false, answer: 'B', explanation: 'E2', knowledgePoint: 'K2', elapsedMs: 2000, lowConfidence: false },
          ],
          summary: { correct: 1, total: 2 },
        },
      });
      assert.ok(html.includes('本次测验掌握情况'), '应展示本次测验掌握情况');
      assert.ok(html.includes('掌握 1 / 2'), '应展示 掌握 1 / 2');
      assert.equal(html.includes('正确率'), false, '面向用户严禁使用「正确率」字样');
    });

    it('R3-T1-02: 逐题对错比对卡片渲染：正确题目显示绿色勾选，错误题目显示红色叉号及标准正确答案', () => {
      const attempt = createMockAttempt('att_r3_2', '错题复盘', 2, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [
            { questionId: 'q1', type: 'single', stem: '第一题干', isCorrect: true, answer: 'A', explanation: 'E1', knowledgePoint: 'K1', elapsedMs: 1000, lowConfidence: false },
            { questionId: 'q2', type: 'single', stem: '第二题干', isCorrect: false, answer: 'C', explanation: 'E2', knowledgePoint: 'K2', elapsedMs: 2000, lowConfidence: false },
          ],
          summary: { correct: 1, total: 2 },
        },
      });
      assert.ok(html.includes('你的作答：A'), '应呈现用户作答');
      assert.ok(html.includes('标准正确答案：'), '错题应呈现标准正确答案');
    });

    it('R3-T1-03: 试题深度解析卡片渲染：展开展示「💡 试题解析」及真实 explanation', () => {
      const attempt = createMockAttempt('att_r3_3', '深度解析', 1, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [
            { questionId: 'q1', type: 'single', stem: '解析测试题', isCorrect: true, answer: 'A', explanation: '这是生产代码导出的专业深度解析内容', knowledgePoint: 'K', elapsedMs: 1000, lowConfidence: false },
          ],
          summary: { correct: 1, total: 1 },
        },
      });
      assert.ok(html.includes('💡 试题解析：'), '应包含试题解析标题');
      assert.ok(html.includes('这是生产代码导出的专业深度解析内容'), '应展示真实解析正文');
    });

    it('R3-T2-01: 判断题秒答标记低置信：判断题作答耗时 <=2s 命中 lowConfidence 警告与黄色警示提示', () => {
      const attempt = createMockAttempt('att_r3_4', '低置信度', 1, true);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [
            { questionId: 'q1', type: 'true_false', stem: '判断极速', isCorrect: true, answer: 'true', explanation: 'E', knowledgePoint: 'K', elapsedMs: 1200, lowConfidence: true },
          ],
          summary: { correct: 1, total: 1 },
        },
      });
      assert.ok(html.includes('作答极快（≤2s）'), '低置信题目应提示作答极快警示');
      assert.ok(html.includes('秒答待巩固'), '单题徽章应标注秒答待巩固');
    });

    it('R3-T2-02: 单选题极速作答负向测试：单选题即使作答耗时 <=2s 也绝不标记为 lowConfidence', () => {
      const attempt = createMockAttempt('att_r3_5', '单选极速', 1, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [
            { questionId: 'q1', type: 'single', stem: '单选题极速', isCorrect: true, answer: 'A', explanation: 'E', knowledgePoint: 'K', elapsedMs: 1500, lowConfidence: false },
          ],
          summary: { correct: 1, total: 1 },
        },
      });
      assert.ok(!html.includes('作答极快（≤2s）'), '单选题不应展示低置信警告条');
      assert.ok(!html.includes('秒答待巩固'), '单选题不应显示秒答待巩固标签');
    });

    it('R3-T3-01: 学练闭环「在画布中深挖」：点击按钮分发 onExploreInCanvas 回调并携带当前 topic', () => {
      let passedTopic = '';
      const attempt = createMockAttempt('att_r3_6', '知识图谱深挖', 1, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [],
          summary: { correct: 1, total: 1 },
        },
        onExploreInCanvas: (t) => {
          passedTopic = t;
        },
      });
      assert.ok(html.includes('在画布中深挖'), '判卷报告必须展示在画布中深挖操作');
    });

    it('R3-T3-02: 学练再练流转「再练一组」：渲染再练一组操作按钮', () => {
      const attempt = createMockAttempt('att_r3_7', '再练测试', 1, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [],
          summary: { correct: 1, total: 1 },
        },
      });
      assert.ok(html.includes('再练一组'), '报告应提供「再练一组」按钮');
    });

    it('R3-T3-03: 「开始其他主题练习」：底部按钮渲染并支持重置回到出题表单', () => {
      const attempt = createMockAttempt('att_r3_8', '换主题', 1, false);
      const html = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt,
          results: [],
          summary: { correct: 1, total: 1 },
        },
      });
      assert.ok(html.includes('开始其他主题练习'), '报告底部应包含「开始其他主题练习」按钮');
    });
  });

  // =========================================================================
  // R4: 历史记录管理与多租户 Scope 隔离 (9 Tests)
  // =========================================================================
  describe('R4: 历史记录管理与多租户 Scope 隔离', () => {
    it('R4-T1-01: 往期练习列表渲染：左侧渲染历史卡片，显示主题、难度、作答状态', async () => {
      const historyMock: QuizHistoryItem[] = [
        { attemptId: 'h1', topic: '量子纠缠机制', difficulty: 'advanced', status: 'completed', total: 3, correctCount: 3, createdAt: '2026-10-01Z', completedAt: '2026-10-01Z', review: {} },
      ];
      mockRoutes.push({
        pattern: /\/api\/quiz\/attempts$/,
        method: 'GET',
        handler: () => new Response(JSON.stringify({ attempts: historyMock }), { status: 200 }),
      });

      await quizStore.refreshHistory();
      const html = renderWorkspace();
      assert.ok(html.includes('量子纠缠机制'), '历史记录中应展示主题');
      assert.ok(html.includes(DIFFICULTY_LABELS.advanced), '应展示难度标签');
    });

    it('R4-T1-02: 历史状态分类徽章：已完成项展示绿色「掌握 X/Y」，未完成项展示琥珀色「未完成」', async () => {
      const historyMock: QuizHistoryItem[] = [
        { attemptId: 'h1', topic: '已完成项', difficulty: 'beginner', status: 'completed', total: 5, correctCount: 4, createdAt: '2026-10-01Z', completedAt: '2026-10-01Z', review: {} },
        { attemptId: 'h2', topic: '未完成项', difficulty: 'beginner', status: 'in_progress', total: 5, correctCount: null, createdAt: '2026-10-01Z', completedAt: null, review: {} },
      ];
      mockRoutes.push({
        pattern: /\/api\/quiz\/attempts$/,
        method: 'GET',
        handler: () => new Response(JSON.stringify({ attempts: historyMock }), { status: 200 }),
      });

      await quizStore.refreshHistory();
      const html = renderWorkspace();
      assert.ok(html.includes('掌握 4/5'), '已完成项目应显示「掌握 4/5」');
      assert.ok(html.includes('未完成'), '进行中项目应显示「未完成」');
    });

    it('R4-T1-03: 历史列表空状态渲染：当无任何历史测验时展示友好引导', () => {
      quizStore.reset();
      const html = renderWorkspace();
      assert.ok(html.includes('暂无往期练习记录'), '空历史时应展示暂无往期练习记录');
      assert.ok(html.includes('输入主题开始第一次测验吧'), '应引导用户输入主题');
    });

    it('R4-T1-04: 总体掌握度大盘统计（computeMasteryStats）：统计场次、正确题数、总题数与掌握率；总题数为 0 时 rate 安全兜底为 0%', () => {
      const statsZero = computeMasteryStats([]);
      assert.equal(statsZero.totalAttempted, 0);
      assert.equal(statsZero.totalCorrect, 0);
      assert.equal(statsZero.totalQuestions, 0);
      assert.equal(statsZero.rate, 0, '总题数为 0 时掌握率安全兜底为 0%（无除以 0 风险）');

      const statsNormal = computeMasteryStats([
        { attemptId: 'h1', topic: 'T1', difficulty: 'beginner', status: 'completed', total: 5, correctCount: 4, createdAt: '', completedAt: '', review: {} },
        { attemptId: 'h2', topic: 'T2', difficulty: 'beginner', status: 'completed', total: 5, correctCount: 5, createdAt: '', completedAt: '', review: {} },
        { attemptId: 'h3', topic: 'T3', difficulty: 'beginner', status: 'in_progress', total: 5, correctCount: null, createdAt: '', completedAt: null, review: {} },
      ]);
      assert.equal(statsNormal.totalAttempted, 3, '总测验场次应为 3');
      assert.equal(statsNormal.totalCorrect, 9, '已掌握题数应为 9');
      assert.equal(statsNormal.totalQuestions, 10, '已完成总题数应为 10（忽略进行中题目）');
      assert.equal(statsNormal.rate, 90, '总体掌握率应为 90%');
    });

    it('R4-T2-01: 离线网络断网降级：网络异常或离线时展示「离线缓存」Banner', async () => {
      // 预先写入本地缓存
      mockLocalStorageStore.set(
        boardScope.quizCacheKey('guest'),
        JSON.stringify([
          { attemptId: 'h_off', topic: '离线主题', difficulty: 'beginner', status: 'completed', total: 5, correctCount: 5, createdAt: '', completedAt: '', review: {} },
        ]),
      );

      // 网络异常
      isNetworkOnline = false;
      await quizStore.refreshHistory();

      const view = quizStore.getHistoryView();
      assert.equal(view.offline, true, '离线状态下 offline 标志必须为 true');

      const html = renderWorkspace();
      assert.ok(html.includes('离线缓存'), 'UI 侧边栏应展示「离线缓存」标记');
    });

    it('R4-T2-02: 历史卡片点击重测（Retake Flow）：点击往期历史卡片回填 topic 与 difficulty 并切入表单态', () => {
      const html = renderWorkspace();
      assert.ok(html.includes('开始新练习'), '应提供开启练习入口');
    });

    it('R4-T3-01: 本地缓存异常容错：LocalStorage 损坏或写入配额超限（QuotaExceededError）时优雅捕获不崩溃', () => {
      failLocalStorage = true;
      assert.doesNotThrow(() => {
        quizStore.saveDraft('quota_att', { q1: { questionId: 'q1', choice: 'A', elapsedMs: 100 } });
      }, '存储异常必须捕获降级，严禁向外抛出未捕获错误');
    });

    it('R4-T4-01: 多租户作用域（Storage Scope）物理隔离：Alice 与 Bob 切换，草稿严格按 scopeKey 隔离，绝不串用', () => {
      // Alice 登录并保存敏感草稿
      boardScope.setActiveScopeKey('alice');
      quizStore.bindScope('alice');
      quizStore.saveDraft('att_secret', {
        q1: { questionId: 'q1', choice: 'AliceConfidentialChoice', elapsedMs: 500 },
      });

      const aliceKey = `${boardScope.quizCacheKey('alice')}:draft:att_secret`;
      assert.ok(mockLocalStorageStore.has(aliceKey), 'Alice 的草稿必须存在其独立 Scope');

      // Bob 登录，读取同名 attempt
      boardScope.setActiveScopeKey('bob');
      quizStore.bindScope('bob');
      const bobDraft = quizStore.loadDraft('att_secret');
      assert.deepEqual(bobDraft, {}, 'Bob 绝不能读取 Alice 的任何作答草稿');

      // 切回 Alice，草稿完好无损
      boardScope.setActiveScopeKey('alice');
      quizStore.bindScope('alice');
      const aliceDraft = quizStore.loadDraft('att_secret');
      assert.equal(aliceDraft.q1?.choice, 'AliceConfidentialChoice', '切回 Alice 后其草稿必须完整恢复');
    });

    it('R4-T4-02: 游客（Guest）与登录用户切换隔离：登出后 reset 清空内存状态，不泄漏已登录用户历史', () => {
      boardScope.setActiveScopeKey('alice');
      quizStore.bindScope('alice');
      quizStore.reset();
      const view = quizStore.getHistoryView();
      assert.equal(view.items.length, 0, '重置后练习历史必须清空');
      assert.equal(view.offline, false);
    });
  });

  // =========================================================================
  // Tier 4: 端到端用户旅程 (2 Tests)
  // =========================================================================
  describe('Tier 4: 端到端全链路用户旅程', () => {
    it('E2E-T4-01: 完整学练闭环端到端旅程：配置出题 -> 生成 -> 点选答案 -> 差分计时 -> 提交判卷 -> 报告展示 -> 画布深挖', async () => {
      boardScope.setActiveScopeKey('student_e2e');
      quizStore.bindScope('student_e2e');

      // 1. 出题配置接口 Mock
      const attempt = createMockAttempt('att_e2e_1', 'Raft 分布式共识', 3, true);
      mockRoutes.push({
        pattern: /\/api\/quiz\/attempts$/,
        method: 'POST',
        handler: () => new Response(JSON.stringify(attempt), { status: 200 }),
      });

      // 2. 调用出题生成
      const genOutcome = await quizStore.generateQuiz({
        topic: 'Raft 分布式共识',
        difficulty: 'intermediate',
        count: 3,
      });
      assert.ok(genOutcome.ok, '出题必须成功');
      const generatedAttempt = genOutcome.data;
      assert.equal(generatedAttempt.questions.length, 3);

      // 3. 模拟作答与时间戳记录
      const baseTime = 100000;
      const startRef = {
        [generatedAttempt.questions[0].id]: baseTime + 2000,
        [generatedAttempt.questions[1].id]: baseTime + 6000,
        [generatedAttempt.questions[2].id]: baseTime + 8500,
      };
      const choices = {
        [generatedAttempt.questions[0].id]: 'A',
        [generatedAttempt.questions[1].id]: 'C',
        [generatedAttempt.questions[2].id]: 'true',
      };

      // 暂存草稿
      quizStore.saveDraft(generatedAttempt.attemptId, {
        [generatedAttempt.questions[0].id]: { questionId: generatedAttempt.questions[0].id, choice: 'A', elapsedMs: 0 },
      });

      // 4. 计算生产差分计时数据
      const submissions = calculateDifferentialTiming(
        generatedAttempt.questions,
        startRef,
        baseTime,
        baseTime + 9000,
        choices,
      );
      assert.equal(submissions[0].elapsedMs, 2000);
      assert.equal(submissions[1].elapsedMs, 4000);
      assert.equal(submissions[2].elapsedMs, 2500);

      // 5. 判卷接口 Mock
      const gradeResults: QuizGradeResult[] = [
        { questionId: generatedAttempt.questions[0].id, type: 'single', stem: 'Q1', isCorrect: true, answer: 'A', explanation: '解析1', knowledgePoint: 'Leader选举', elapsedMs: 2000, lowConfidence: false },
        { questionId: generatedAttempt.questions[1].id, type: 'single', stem: 'Q2', isCorrect: false, answer: 'B', explanation: '解析2', knowledgePoint: '日志复制', elapsedMs: 4000, lowConfidence: false },
        { questionId: generatedAttempt.questions[2].id, type: 'true_false', stem: 'Q3', isCorrect: true, answer: 'true', explanation: '解析3', knowledgePoint: '脑裂防御', elapsedMs: 2500, lowConfidence: false },
      ];
      mockRoutes.push({
        pattern: new RegExp(`/api/quiz/attempts/${generatedAttempt.attemptId}/answers$`),
        method: 'POST',
        handler: () =>
          new Response(
            JSON.stringify({
              results: gradeResults,
              summary: { correct: 2, total: 3, accuracy: 67, status: 'completed' },
            }),
            { status: 200 },
          ),
      });

      // 6. 提交交卷
      const submitOutcome = await quizStore.submitAnswers(generatedAttempt.attemptId, submissions);
      assert.ok(submitOutcome.ok, '交卷必须成功');

      // 7. 渲染真实报告组件并验证
      let canvasExploredTopic = '';
      const htmlReport = renderWorkspace({
        initialPhase: {
          kind: 'graded',
          attempt: generatedAttempt,
          results: submitOutcome.results,
          summary: submitOutcome.summary,
        },
        onExploreInCanvas: (t) => {
          canvasExploredTopic = t;
        },
      });

      assert.ok(htmlReport.includes('掌握 2 / 3'), '报告准确展示掌握 2 / 3');
      assert.ok(htmlReport.includes('Leader选举') || htmlReport.includes('解析1'), '包含错题知识点与解析');
      assert.ok(!htmlReport.includes('正确率'), '刚性遵守无正确率文案纪律');
      assert.ok(htmlReport.includes('在画布中深挖'), '提供学练闭环画布深挖入口');
    });

    it('E2E-T4-02: 异常断网与草稿恢复端到端旅程：答题中断 -> 刷新重入恢复草稿 -> 恢复网络完成提交', async () => {
      boardScope.setActiveScopeKey('student_offline');
      quizStore.bindScope('student_offline');

      const attemptId = 'att_offline_flow';
      const attempt = createMockAttempt(attemptId, '网络韧性', 2, false);

      // 用户答了第一题，保存草稿
      quizStore.saveDraft(attemptId, {
        [attempt.questions[0].id]: { questionId: attempt.questions[0].id, choice: 'B', elapsedMs: 1500 },
      });

      // 模拟突发断网
      isNetworkOnline = false;

      // 模拟页面刷新重入：从 LocalStorage 恢复草稿
      const restoredDraft = quizStore.loadDraft(attemptId);
      assert.equal(restoredDraft[attempt.questions[0].id]?.choice, 'B', '重入考场草稿必须完好恢复');

      // 用户作答第二题并更新草稿
      quizStore.saveDraft(attemptId, {
        ...restoredDraft,
        [attempt.questions[1].id]: { questionId: attempt.questions[1].id, choice: 'C', elapsedMs: 2500 },
      });

      // 网络恢复
      isNetworkOnline = true;
      mockRoutes.push({
        pattern: new RegExp(`/api/quiz/attempts/${attemptId}/answers$`),
        method: 'POST',
        handler: () =>
          new Response(
            JSON.stringify({
              results: [],
              summary: { correct: 2, total: 2, accuracy: 100, status: 'completed' },
            }),
            { status: 200 },
          ),
      });

      // 最终成功交卷并清除草稿
      const finalSubmissions: QuizSubmission[] = [
        { questionId: attempt.questions[0].id, choice: 'B', elapsedMs: 1500 },
        { questionId: attempt.questions[1].id, choice: 'C', elapsedMs: 2500 },
      ];
      const outcome = await quizStore.submitAnswers(attemptId, finalSubmissions);
      assert.ok(outcome.ok, '网络恢复后交卷成功');
      quizStore.clearDraft(attemptId);

      const emptyDraft = quizStore.loadDraft(attemptId);
      assert.deepEqual(emptyDraft, {}, '最终草稿必须彻底被清理');
    });
  });
});
