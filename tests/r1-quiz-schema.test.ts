/**
 * Spec R1 — 出题 schema 契约的单元测试（纯函数，无 server，照 canvas-change.test.ts 先例）。
 *
 * 背景（2026-10-25 线上实测）：模型把判断题 correct 写成 "True"（首字母大写），
 * 信封完整但被确定性守卫拦下 → 整批 5 题报废（服务无重试，用户直接收到 parseFailed）。
 * 根因：发给 provider 的 JSON Schema 里 correct 是裸 string，约束只写在 zod 注释里。
 * 修复 = correct 走 preprocess 归一化 + 全合法值 enum（同时导出进 provider 的 JSON Schema）。
 *
 * 本文件锁定四层：
 *   1. normalizeCorrect 归一化边界（大小写 / boolean / 空白 / 小写标签）
 *   2. validateGeneratedQuiz 确定性守卫的每个拒绝分支
 *   3. buildQuizJsonSchema 导出契约（enum 约束 / 无 $ref/$defs / 恰好 n 题）
 *   4. shuffleSingleQuestion 三步不变式（Spec 点名的位置偏置消除，此前零测试覆盖）
 *
 * 桩数据复用 docs/spike/ 的已验证样本（与 r1-quiz.test.ts 同口径）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuizJsonSchema,
  validateGeneratedQuiz,
} from '../server/services/quiz-schema.js';
import { shuffleSingleQuestion } from '../server/services/quiz-generation.service.js';
import { sampleAiAdvanced } from '../docs/spike/r1-quiz-prompt-validation.js';

/** 深拷贝 spike 样本作为合法基线，再按用例做变异 */
function validQuiz() {
  return structuredClone(sampleAiAdvanced.output);
}

/** 把基线里第 idx 题替换成给定覆盖（其余保持合法，满足恰好 5 题） */
function withQuestion(idx: number, override: Record<string, unknown>) {
  const quiz = validQuiz();
  quiz.questions[idx] = { ...quiz.questions[idx], ...override };
  return quiz;
}

// ───────────────────────── 1. correct 归一化 ─────────────────────────

describe('correct 归一化（线上 "True" 故障的回归防线）', () => {
  test('"True"（首字母大写）→ 归一为小写并通过', () => {
    const quiz = validQuiz();
    for (const q of quiz.questions) if (q.type === 'true_false') q.correct = 'True';
    const parsed = validateGeneratedQuiz(quiz, 5);
    for (const q of parsed.questions) {
      if (q.type === 'true_false') assert.equal(q.correct, 'true');
    }
  });

  test('boolean correct → 字符串 true/false', () => {
    const quiz = validQuiz();
    quiz.questions[2].correct = false as unknown as string;
    const parsed = validateGeneratedQuiz(quiz, 5);
    assert.equal(parsed.questions[2].correct, 'false');
  });

  test('大小写与空白变体全谱：TRUE / False / 带空白', () => {
    for (const raw of ['TRUE', 'False', ' true ', ' FALSE ']) {
      const quiz = validQuiz();
      quiz.questions[2].correct = raw;
      const parsed = validateGeneratedQuiz(quiz, 5);
      const want = raw.trim().toLowerCase();
      assert.equal(parsed.questions[2].correct, want,
        JSON.stringify(raw) + ' 应归一为 ' + want);
    }
  });

  test('单选小写标签 a-d → 补大写', () => {
    const quiz = validQuiz();
    quiz.questions[0].correct = 'b';
    const parsed = validateGeneratedQuiz(quiz, 5);
    assert.equal(parsed.questions[0].correct, 'B');
  });

  test('垃圾值照旧硬性拒绝：maybe / 空串 / 数字 / null', () => {
    for (const bad of ['maybe', '', 1, null] as unknown[]) {
      const quiz = validQuiz();
      quiz.questions[2].correct = bad as string;
      assert.throws(() => validateGeneratedQuiz(quiz, 5), undefined,
        "correct=" + JSON.stringify(bad) + " 应被拒绝");
    }
  });

  test('单选 correct 归一化成 true/false 后不在标签内 → 仍拒绝（归一化不跨题型越界）', () => {
    const quiz = validQuiz();
    quiz.questions[0].correct = 'True';
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /不在选项标签/);
  });
});

// ───────────────────────── 2. 确定性守卫分支 ─────────────────────────

describe('validateGeneratedQuiz 确定性守卫', () => {
  test('题量不足 → 拒绝（.length 挡「4 道半题」）', () => {
    const quiz = validQuiz();
    quiz.questions = quiz.questions.slice(0, 4);
    assert.throws(() => validateGeneratedQuiz(quiz, 5));
  });

  test('单选只有 3 个选项 → 拒绝', () => {
    const quiz = validQuiz();
    quiz.questions[0].options = quiz.questions[0].options?.slice(0, 3) ?? null;
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /必须有 4 个选项/);
  });

  test('选项标签不是恰好 A/B/C/D → 拒绝', () => {
    const quiz = validQuiz();
    const opts = quiz.questions[0].options;
    if (opts) opts[1].label = 'A'; // 与 opts[0] 重复
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /恰好是/);
  });

  test('选项文本重复 → 拒绝', () => {
    const quiz = validQuiz();
    const opts = quiz.questions[0].options;
    if (opts) opts[1].text = opts[0].text;
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /不得重复/);
  });

  test('correct 为非法值 E → enum 层先拦截（守卫文案仅对 enum 放行值可达）', () => {
    const quiz = withQuestion(0, { correct: 'E' });
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /Invalid option/);
  });

  test('判断题答案值流入单选题 → 守卫层拒绝（enum 放行 true/false，靠守卫比对标签）', () => {
    const quiz = withQuestion(0, { correct: 'true' });
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /不在选项标签/);
  });

  test('判断题带 options → 拒绝（契约恒为 null）', () => {
    const quiz = withQuestion(2, {
      options: [{ label: 'A', text: '对' }, { label: 'B', text: '错' }],
    });
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /不应有选项/);
  });

  test('knowledge_point 空白 → 拒绝（二期薄弱点分析的原料）', () => {
    const quiz = withQuestion(0, { knowledge_point: '   ' });
    assert.throws(() => validateGeneratedQuiz(quiz, 5), /knowledge_point/);
  });

  test('缺 pedagogical_analysis → 拒绝（CoT 自审是契约的一部分）', () => {
    const quiz = validQuiz();
    delete (quiz as Record<string, unknown>).pedagogical_analysis;
    assert.throws(() => validateGeneratedQuiz(quiz, 5));
  });
});

// ───────────────────────── 3. 导出契约 ─────────────────────────

describe('buildQuizJsonSchema 导出契约（provider 侧结构化约束）', () => {
  /** 递归收集对象树里出现过的所有 key */
  function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const v of value) collectKeys(v, into);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        into.add(k);
        collectKeys(v, into);
      }
    }
    return into;
  }

  test('correct 带 enum，恰好 6 个合法值（2026-10-25 前是裸 string）', () => {
    const schema = buildQuizJsonSchema(5) as any;
    const correct = schema.properties.questions.items.properties.correct;
    assert.deepEqual(
      [...correct.enum].sort(),
      ['A', 'B', 'C', 'D', 'false', 'true'],
      "correct 必须以 enum 形式约束进 provider 的 JSON Schema");
  });

  test('全树无 $ref / $defs（Gemini responseJsonSchema 不吃，文件头约束）', () => {
    const keys = collectKeys(buildQuizJsonSchema(5));
    for (const banned of ['$ref', '$defs']) {
      assert.ok(!keys.has(banned), "导出的 JSON Schema 不得含 " + banned);
    }
  });

  test('questions 恰好 n 题（minItems = maxItems = count）', () => {
    const schema = buildQuizJsonSchema(7) as any;
    assert.equal(schema.properties.questions.minItems, 7);
    assert.equal(schema.properties.questions.maxItems, 7);
  });

  test('options 可空（判断题恒为 null 的契约导出后不失真）', () => {
    const schema = buildQuizJsonSchema(5) as any;
    const opts = schema.properties.questions.items.properties.options;
    assert.ok(JSON.stringify(opts).includes("null"),
      "options 导出应保留可空，实际：" + JSON.stringify(opts));
  });
});

// ───────────────────────── 4. 洗牌不变式 ─────────────────────────

describe('shuffleSingleQuestion 三步不变式（位置偏置消除）', () => {
  const OPTIONS = [
    { label: 'A', text: '选项一' },
    { label: 'B', text: '选项二' },
    { label: 'C', text: '选项三' },
    { label: 'D', text: '选项四' },
  ];

  /** 可复现的伪随机源：同一 seed 两次洗牌结果必须一致 */
  function seededRng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  test('确定性：同一 rng 序列两次洗牌结果逐字一致', () => {
    const a = shuffleSingleQuestion(OPTIONS, 'C', seededRng(42));
    const b = shuffleSingleQuestion(OPTIONS, 'C', seededRng(42));
    assert.deepEqual(a, b);
  });

  test('标签按新位置重新编号，恒为 A/B/C/D 顺序', () => {
    const { options } = shuffleSingleQuestion(OPTIONS, 'A', seededRng(7));
    assert.deepEqual(
      options.map((o) => o.label),
      ['A', 'B', 'C', 'D'],
      "洗牌后标签必须按新位置重编号（只洗内容不重编号 = correct 映射错位）");
  });

  test('文本锚点映射：correct 指向的选项文本 === 原 correctLabel 的文本', () => {
    for (const label of ['A', 'B', 'C', 'D']) {
      const { options, correct } = shuffleSingleQuestion(OPTIONS, label, seededRng(label.length * 13));
      const correctText = options.find((o) => o.label === correct)?.text;
      assert.equal(
        correctText,
        OPTIONS.find((o) => o.label === label)?.text,
        "原正确项 " + label + " 的文本在洗牌后必须仍被 correct 指向");
    }
  });

  test('洗牌是排列：文本多重集不变（不丢不重）', () => {
    const { options } = shuffleSingleQuestion(OPTIONS, 'B', seededRng(99));
    assert.deepEqual(
      options.map((o) => o.text).sort(),
      OPTIONS.map((o) => o.text).sort());
  });

  test('correctLabel 不在选项内 → 抛错（洗牌丢失正确项不可静默）', () => {
    assert.throws(() => shuffleSingleQuestion(OPTIONS, 'E', Math.random), /丢失了正确项/);
  });
});
