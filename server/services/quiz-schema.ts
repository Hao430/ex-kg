/**
 * Spec R1 — 出题服务的结构化契约（zod 为**单一事实源**）。
 *
 * 约束（Spike 实测，见 docs/specs/R1-AI练习模式.md §8.1）：
 * - **不得用 `z.discriminatedUnion`**：Gemini 的 `responseJsonSchema` 走 OpenAPI 3.0 子集、
 *   不吃 `$ref`/`$defs`。故题型用「统一 shape + `type` 字段判别」，单选题的 `options` 为 null。
 * - `.length(n)` 会正确导出为 `minItems`/`maxItems`，可作「恰好 n 题」的硬约束。
 * - 解析出题结果**必须再过 zod**：jsonrepair 只保证「能 parse」，被 max_tokens 截掉的内容
 *   会变成 null/缺字段，只有 `.length(5)` 能把「4 道半题」挡下来。
 */
import { z } from 'zod';

export const QUIZ_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;
export type QuizDifficulty = (typeof QUIZ_DIFFICULTIES)[number];

/** 出题输入（用户主题 + 难度 + 题量） */
export const GenerateQuizSchema = z.object({
  topic: z.string().min(1, '请填写练习主题').max(200, '主题请控制在 200 字以内'),
  difficulty: z.enum(QUIZ_DIFFICULTIES),
  count: z.number().int().min(1).max(10).default(5),
});
export type GenerateQuizInput = z.infer<typeof GenerateQuizSchema>;

/**
 * 出题端点入参（Spec R1 幂等扩展）。
 * `attemptId` 由客户端生成（UUIDv7）：同一 id 重放时返回既有记录而不是重新调模型。
 * 出题服务本身只吃 GenerateQuizInput——路由负责把 attemptId 剥离后再下传。
 */
export const CreateAttemptSchema = GenerateQuizSchema.extend({
  attemptId: z.string().uuid('练习记录 id 格式不正确').optional(),
});
export type CreateAttemptInput = z.infer<typeof CreateAttemptSchema>;

/**
 * correct 的取值归一化（Spec R1：落库契约严格限定小写 'true'|'false'）。
 *
 * 线上实测（2026-10-25）模型会把判断题答案写成 "True"（首字母大写字符串）甚至
 * JSON boolean —— 语义无歧义，仅大小写/类型差异，在解析边界归一化而不是让
 * 整批 5 题报废（服务无重试，一处格式错 = 用户直接收到 parseFailed）。
 * 仅当值能无歧义映射时才改写：true/false 大小写不敏感、单选标签 a-d 补大写；
 * 其余原样放行，交给下面的 enum 与 validateGeneratedQuiz 硬性拒绝。
 */
function normalizeCorrect(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^true$/i.test(t)) return 'true';
  if (/^false$/i.test(t)) return 'false';
  if (/^[a-d]$/i.test(t)) return t.toUpperCase();
  return t;
}

/**
 * 单道题的结构化输出契约。
 * ⚠️ `options` 对判断题恒为 null（不返回空数组，减少模型二义性）。
 * ⚠️ 单选/判断共用同一 shape（不能用 discriminatedUnion，见文件头），故 correct
 * 用「全体合法值」的 enum：既在导出的 JSON Schema 里对 provider 形成硬约束
 * （此前是裸 string，"True" 畅通无阻——2026-10-25 线上实测故障根因），
 * 又在解析边界经 normalizeCorrect 容错大小写与 boolean。
 */
export const GeneratedQuestionSchema = z.object({
  type: z.enum(['single', 'true_false']),
  stem: z.string().min(1),
  options: z.array(z.object({ label: z.string(), text: z.string() })).nullable(),
  /** 单选为 'A'|'B'|'C'|'D'；判断题为 'true'|'false'（大小写/boolean 在 normalizeCorrect 归一） */
  correct: z.preprocess(normalizeCorrect, z.enum(['A', 'B', 'C', 'D', 'true', 'false'])),
  explanation: z.string(),
  knowledge_point: z.string(),
});
export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

/**
 * 完整出题结果。`pedagogical_analysis` 是**单次提示词内的 CoT 自审**——
 * 让模型在输出每题前先自检学科归属、难度匹配、误区设计（Spec §3.4）。
 */
export function buildGeneratedQuizSchema(count: number) {
  return z.object({
    pedagogical_analysis: z.object({
      subject: z.string().describe('判定出的学科'),
      difficulty_fit: z.string().describe('本批题目与目标难度档的匹配自评'),
      misconception_design: z.string().describe('干扰项/错误陈述针对的误区'),
    }),
    questions: z.array(GeneratedQuestionSchema).length(count),
  });
}
export type GeneratedQuiz = z.infer<ReturnType<typeof buildGeneratedQuizSchema>>;

/**
 * 供 provider 原生结构化约束使用的 JSON Schema。
 * ⚠️ `target: 'draft-2020-12'` 且**不使用 $ref**（见文件头约束）。
 */
export function buildQuizJsonSchema(count: number): Record<string, unknown> {
  return z.toJSONSchema(buildGeneratedQuizSchema(count), { target: 'draft-2020-12' }) as Record<string, unknown>;
}

/**
 * 确定性校验（服务端守卫，Spec §3.4 第 3 步）。
 *
 * ⚠️ 这些是**服务端硬门槛**，不通过即视为本次出题失败：模型说了不算，
 * 结构必须自洽，否则判卷阶段会出现「无正确答案可比对」的空洞。
 */
export function validateGeneratedQuiz(data: unknown, count: number): GeneratedQuiz {
  const parsed = buildGeneratedQuizSchema(count).parse(data);

  for (const [i, q] of parsed.questions.entries()) {
    const at = `第 ${i + 1} 题`;
    if (q.type === 'single') {
      if (!q.options || q.options.length !== 4) {
        throw new Error(`${at}：单选题必须有 4 个选项，实际 ${q.options?.length ?? 0} 个`);
      }
      const labels = q.options.map((o) => o.label).sort().join('');
      if (labels !== 'ABCD') {
        throw new Error(`${at}：选项标签必须恰好是 A/B/C/D，实际为 ${labels}`);
      }
      const texts = q.options.map((o) => o.text.trim());
      if (new Set(texts).size !== 4) {
        throw new Error(`${at}：4 个选项的文本不得重复`);
      }
      if (!q.options.some((o) => o.label === q.correct)) {
        throw new Error(`${at}：正确答案 ${q.correct} 不在选项标签 ${labels} 内`);
      }
    } else {
      if (q.options !== null) {
        throw new Error(`${at}：判断题不应有选项`);
      }
      if (q.correct !== 'true' && q.correct !== 'false') {
        throw new Error(`${at}：判断题答案必须是 'true' 或 'false'，实际为 ${q.correct}`);
      }
    }
    if (!q.knowledge_point.trim()) {
      throw new Error(`${at}：knowledge_point 不能为空（二期薄弱知识点分析的原料）`);
    }
  }

  return parsed;
}
