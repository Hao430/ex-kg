/**
 * Spec R1 — 判卷服务（**确定性比对，不调模型**）。
 *
 * 与出题严格分离：出题是 AI 调用（慢、可能失败、要限流），判卷是纯计算（快、必成功）。
 * 这也符合参考实现的教训——它只管生成不管作答，因此完全没有「答案是否唯一」、
 * 「用户是否真的答对」这些校验。
 */
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from '../lib/errors.js';
import { getAttempt, completeAttempt } from '../repositories/quiz.repository.js';
import type { QuizAttemptRecord, QuizAnswerRecord } from '../core/records.js';

/**
 * 低置信阈值（毫秒）。
 *
 * ⚠️ **仅适用于判断题**：判断题猜对概率 50%，秒答的正确率里混着大量瞎猜，
 * 混进「已掌握」会虚高。单选猜对率仅 25%，同一判据的数学依据不成立，故**不套用**。
 */
const LOW_CONFIDENCE_MS = 3000;

/** 防篡改下界：低于 100ms 视为非人类输入 */
const MIN_ELAPSED_MS = 100;
/** 防篡改上界：单题不可能超过 1 小时 */
const MAX_ELAPSED_MS = 3_600_000;
/** 每题允许的额外「零思考」窗口（毫秒）：用于整卷总耗时的防篡改上界 */
const ANSWER_WINDOW_PER_QUESTION_MS = 10 * 60 * 1000;
/** 整卷总耗时允许的额外超出量（毫秒），容忍网络与计时精度误差 */
const LIFETIME_TOLERANCE_MS = 5000;

/**
 * 判卷的**接口层**入参形状。
 * ⚠️ 存储层（JSONB/DB）用下划线 `question_id`/`elapsed_ms`，**接口层用驼峰**（Spec §4.1）。
 * 二者的映射收敛在本服务内部，仓储与 SQL 一律下划线。
 */
export interface SubmittedAnswer {
  questionId: string;
  choice: string;
  elapsedMs: number;
}

export interface GradeResult {
  questionId: string;
  type: 'single' | 'true_false';
  stem: string;
  isCorrect: boolean;
  /** 用户实际提交的选项（'A'..'D' 或 'true'|'false'） */
  choice: string;
  /** 标准答案 */
  answer: string;
  explanation: string;
  knowledgePoint: string;
  elapsedMs: number;
  /** 判断题秒答标记；单选恒为 false */
  lowConfidence: boolean;
}

export interface GradeSummary {
  correct: number;
  total: number;
  /** 面向用户呈现为「掌握情况」；字段名保持与统计口径一致（Spec §3.1） */
  accuracy: number;
  status: 'completed';
}

export interface GradeAttemptResult {
  results: GradeResult[];
  summary: GradeSummary;
}

/** 判卷前的输入守卫：整卷一次性提交，逐项校验 */
function validateSubmission(attempt: QuizAttemptRecord, answers: SubmittedAnswer[]): void {
  if (answers.length !== attempt.questions.length) {
    throw new ValidationError(
      `请提交全部 ${attempt.questions.length} 道题的作答，当前收到 ${answers.length} 道`,
      'QUIZ_ANSWERS_INCOMPLETE'
    );
  }

  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  for (const q of attempt.questions) {
    const a = byQuestion.get(q.id);
    if (!a) {
      throw new ValidationError(`缺少题目 ${q.id} 的作答`, 'QUIZ_ANSWERS_INCOMPLETE');
    }
    if (!Number.isFinite(a.elapsedMs) || a.elapsedMs < MIN_ELAPSED_MS || a.elapsedMs > MAX_ELAPSED_MS) {
      throw new ValidationError(
        `题目 ${q.id} 的用时超出合理范围`,
        'QUIZ_ELAPSED_INVALID'
      );
    }
    const validChoice = q.type === 'true_false' ? ['true', 'false'] : (q.options ?? []).map((o) => o.label);
    if (!validChoice.includes(a.choice)) {
      throw new ValidationError(`题目 ${q.id} 的作答不是合法选项`, 'QUIZ_CHOICE_INVALID');
    }
  }

  // 防篡改：整卷总耗时应落在「练习存续时长 + 合理答题窗口」之内。
  // 客户端若想靠伪造 elapsedMs 规避判断题的 low_confidence 标记，这里就是兜底。
  //
  // ⚠️ **不能**写成「ΣelapsedMs ≤ attempt 生命周期」——那会把**正常作答也拦死**：
  // 出题响应返回后用户才开始答题，attempt 存续时长此刻可能只有几百毫秒，
  // 而答 5 道题轻易就花几分钟（首次实测即命中：5×30s 被自己的校验拒绝）。
  // 窗口按题量线性给（每题额外允许 ANSWER_WINDOW_PER_QUESTION_MS 的「零思考上限」），
  // 仍比 MAX_ELAPSED_MS×题量 严格两个量级，抓得住伪造、放过正常作答。
  const totalElapsed = answers.reduce((sum, a) => sum + a.elapsedMs, 0);
  const createdMs = new Date(attempt.created_at).getTime();
  const lifetime = Date.now() - createdMs;
  const allowed = lifetime + attempt.questions.length * ANSWER_WINDOW_PER_QUESTION_MS + LIFETIME_TOLERANCE_MS;
  if (totalElapsed > allowed) {
    throw new ValidationError('作答用时与本次练习的时长不符，请重新提交', 'QUIZ_ELAPSED_TAMPERED');
  }
}

/**
 * 判卷。属主校验在此处（不依赖 RLS 的最后一道，也不依赖归属探针——
 * quiz_attempts 归 RLS_DIRECT_USER_TABLES，读写都要显式带 userId 条件）。
 */
export async function gradeAttempt(
  userId: string,
  attemptId: string,
  answers: SubmittedAnswer[],
): Promise<GradeAttemptResult> {
  const attempt = await getAttempt(attemptId);
  if (!attempt) throw new NotFoundError('练习记录不存在');
  if (attempt.user_id !== userId) throw new ForbiddenError('无权操作他人的练习记录', 'QUIZ_FORBIDDEN');
  if (attempt.status === 'completed') {
    throw new ConflictError('该练习已提交，请勿重复作答', 'QUIZ_ALREADY_SUBMITTED');
  }

  validateSubmission(attempt, answers);

  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  // 存储层用下划线（JSONB 惯例），接口层用驼峰——映射收敛在此
  const graded: QuizAnswerRecord[] = attempt.questions.map((q) => {
    const a = byQuestion.get(q.id)!;
    const isCorrect = a.choice === q.correct;
    return {
      question_id: q.id,
      choice: a.choice,
      is_correct: isCorrect,
      elapsed_ms: a.elapsedMs,
      // ⚠️ 阈值只对判断题生效（见 LOW_CONFIDENCE_MS 注释）
      low_confidence: q.type === 'true_false' && a.elapsedMs < LOW_CONFIDENCE_MS,
    };
  });

  // 条件更新落库；仓储在重复提交/越权时会抛对应错误码
  const saved = await completeAttempt(attemptId, userId, graded);
  return buildGradeResponse(saved);
}

/**
 * 从**已落库**的 attempt 回放判卷结果（交卷与历史详情共用，纯函数、不调模型）。
 *
 * ⚠️ 两个数据源必须分开：`choice` 来自 answers（用户作答），`answer` 来自
 * questions.correct（标准答案）。此前只有 answer，前端把标准答案当「你的作答」，
 * 错题会把同一个值显示两遍。
 *
 * ⚠️ 调用方必须保证 attempt.answers 非空（仅 completed 记录）；本函数不返回
 * 原始 questions 数组，避免把 correct/explanation 对象整体带出网。
 */
export function buildGradeResponse(attempt: QuizAttemptRecord): GradeAttemptResult {
  if (!attempt.answers) throw new Error('buildGradeResponse: attempt 尚未交卷');

  const results: GradeResult[] = attempt.questions.map((q) => {
    const g = attempt.answers!.find((a) => a.question_id === q.id);
    if (!g) throw new Error(`buildGradeResponse: 缺少题目 ${q.id} 的作答记录`);
    return {
      questionId: q.id,
      type: q.type,
      stem: q.stem,
      isCorrect: g.is_correct,
      choice: g.choice,
      answer: q.correct,
      explanation: q.explanation,
      knowledgePoint: q.knowledge_point,
      elapsedMs: g.elapsed_ms,
      lowConfidence: g.low_confidence,
    };
  });

  const correct = results.filter((r) => r.isCorrect).length;
  return {
    results,
    summary: {
      correct,
      total: results.length,
      accuracy: results.length > 0 ? Math.round((correct / results.length) * 100) / 100 : 0,
      status: 'completed',
    },
  };
}
