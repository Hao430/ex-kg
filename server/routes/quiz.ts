/**
 * Spec R1 — AI 练习路由（画布外独立功能，挂在同源守卫之下）。
 *
 * 架构核心：**答案不下发 → 接口两段式**（Spec §4.1）
 *   ① POST /api/quiz/attempts            出题，**只**返回题干与选项
 *   ② POST /api/quiz/attempts/:id/answers 交卷，返回正确答案与解析
 *
 * ⚠️ ① 的响应由 `toQuestionView()` **构造式投影**生成，不是「拿到 row 再删字段」。
 * 本仓既有 zod schema 均为裸 `z.object`、从未显式写 `.strip()`，把 zod 的默认剥离
 * 当安全边界不可靠（Spec §4.4）。构造式投影让「答案不出网」成为类型层面的事实。
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  quizGenerateRateLimiter,
  quizDailyAttemptLimiter,
  quizAttemptRateLimiter,
} from '../middleware/auth.js';
import { QuotaPolicy } from '../policies/quota.policy.js';
import { NotFoundError } from '../lib/errors.js';
import { generateQuiz } from '../services/quiz-generation.service.js';
import { gradeAttempt } from '../services/quiz-grading.service.js';
import { GenerateQuizSchema } from '../services/quiz-schema.js';
import { createAttempt, getAttempt, listAttempts } from '../repositories/quiz.repository.js';
import type { QuizAttemptRecord } from '../core/records.js';

export const quizRouter = Router();

// ─────────────────────────── 投影 DTO（答案不出网的类型层保证）───────────────────────────

/** ① 的响应形状：只含题目结构，**无 correct / explanation / knowledge_point** */
interface QuestionView {
  id: string;
  type: 'single' | 'true_false';
  stem: string;
  options: Array<{ label: string; text: string }> | null;
}

interface AttemptView {
  attemptId: string;
  questions: QuestionView[];
  /** 自审摘要（学科判定/难度匹配/误区设计），让用户知道这套题的来历 */
  review: Record<string, unknown>;
}

/** 构造式投影：逐字段挑选，**新增答案字段不会自动泄漏**（必须显式加才进来） */
function toQuestionView(q: QuizAttemptRecord['questions'][number]): QuestionView {
  return {
    id: q.id,
    type: q.type,
    stem: q.stem,
    options: q.type === 'single' && q.options ? q.options.map((o) => ({ label: o.label, text: o.text })) : null,
  };
}

function toAttemptView(row: QuizAttemptRecord): AttemptView {
  return {
    attemptId: row.id,
    questions: row.questions.map(toQuestionView),
    review: row.review,
  };
}

/** 列表/详情（未作答）用的精简视图：同样不含答案 */
function toListItemView(row: QuizAttemptRecord) {
  return {
    attemptId: row.id,
    topic: row.topic,
    difficulty: row.difficulty,
    status: row.status,
    // ⚠️ 题数来自 DB 侧聚合而非 row.questions.length——listAttempts 刻意不 select
    // questions 列（防答案泄漏），用它算题数会恒为 0。
    // ⚠️ 键名**不用** `correct`：该键在判卷结果里表示「标准答案」，
    // 列表里同键会被误读为泄漏（tests/r1-quiz.test.ts 有按键名的断言守着）。
    total: row.questionCount,
    // ⚠️ 用仓储层的 correctCount，不要从 row.answers 现算——列表查询刻意不 select
    // answers（防答案泄漏），现算会恒为 null，前端历史页的「掌握 X/Y」永远不显示。
    correctCount: row.correctCount,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    review: row.review,
  };
}

// ─────────────────────────── 校验 schemas ───────────────────────────

/**
 * 交卷入参。⚠️ **接口层一律驼峰**（Spec §4.1），存储层才用下划线——
 * zod 剥离未知键，故即便客户端误传 `question_id` 也会被拒（报 400），不会静默丢字段。
 */
const AnswersSubmitSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().min(1),
    choice: z.string().min(1),
    elapsedMs: z.number().int().min(0).max(3_600_000),
  })).min(1).max(10),
});

/** feature flag 关闭时统一 404（不暴露端点存在性） */
function ensureQuizEnabled(): void {
  if (process.env.QUIZ_ENABLED !== 'true') {
    throw new NotFoundError('练习功能未开启');
  }
}

// ─────────────────────────── 路由 ───────────────────────────

/** ① 出题：主题 + 难度 + 题量 → 题目（不含答案） */
quizRouter.post(
  '/attempts',
  authMiddleware,
  quizGenerateRateLimiter,
  quizDailyAttemptLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    ensureQuizEnabled();
    const user = req.user!;

    // 未验证邮箱禁推理（与 chat 同一判据 QuotaPolicy.assertCanInferWithEmail，admin 豁免）
    QuotaPolicy.assertCanInferWithEmail(user);

    // ⚠️ 入参只有主题/难度/题量——**不提供 systemInstruction**（注入面，Spec §4.3）
    // 用 validate() 而非 schema.parse()：后者抛原生 ZodError，errorHandler 不识别
    // → 500（既有路由的通行做法，Spec §路由分层）
    const input = validate(GenerateQuizSchema, req.body);

    const generated = await generateQuiz(user.id, input);
    if (!generated.meta.ok || generated.questions.length === 0) {
      // 出题失败**如实告知**，不静默返回空列表（出题是主功能）
      res.status(502).json({
        error: generated.meta.review.error || '本次出题未能完成，请稍后重试',
        code: 'QUIZ_GENERATION_FAILED',
        review: generated.meta.review,
      });
      return;
    }

    const row = await createAttempt({
      id: crypto.randomUUID(),
      userId: user.id,
      topic: input.topic,
      difficulty: input.difficulty,
      questions: generated.questions,
      review: {
        subject: generated.meta.review.subject,
        difficultyFit: generated.meta.review.difficultyFit,
        misconceptionDesign: generated.meta.review.misconceptionDesign,
        model: generated.meta.modelName,
      },
    });

    res.json(toAttemptView(row));
  }),
);

/** ② 交卷：判卷 → 正确答案 + 解析 + 本次小结 */
quizRouter.post(
  '/attempts/:id/answers',
  authMiddleware,
  quizAttemptRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    ensureQuizEnabled();
    const user = req.user!;
    const { answers } = validate(AnswersSubmitSchema, req.body);
    const result = await gradeAttempt(user.id, req.params.id, answers);
    res.json(result);
  }),
);

/** 历史列表：只见本人，且不含任何答案字段 */
quizRouter.get(
  '/attempts',
  authMiddleware,
  quizAttemptRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    ensureQuizEnabled();
    const rows = await listAttempts(req.user!.id, 20);
    res.json({ attempts: rows.map(toListItemView) });
  }),
);

/** 单次详情：未作答时**不含**答案与解析（作答后才由 ② 返回） */
quizRouter.get(
  '/attempts/:id',
  authMiddleware,
  quizAttemptRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    ensureQuizEnabled();
    const user = req.user!;
    const row = await getAttempt(req.params.id);
    if (!row) throw new NotFoundError('练习记录不存在');
    if (row.user_id !== user.id) throw new NotFoundError('练习记录不存在');
    res.json(toListItemView(row));
  }),
);
