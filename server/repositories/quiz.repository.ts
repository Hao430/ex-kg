import { getDb } from '../core/db.js';
import { inMemoryStore } from '../core/memory-store.js';
import { AppError, ForbiddenError, NotFoundError, ConflictError } from '../lib/errors.js';
import { handlePgError } from '../core/db-guard.js';
import type { QuizAttemptRecord, QuizAnswerRecord, QuizStatsRecord, QuizWeakPointRecord } from '../core/records.js';

/**
 * Spec R1：AI 练习记录仓储（双模，照 ADR-0002 模板 + folder.repository 范式）。
 *
 * 两个安全约束贯穿本文件：
 * 1. **答案不下发**（架构级，Spec §4.1）：本模块负责存储，**投影 DTO 在 service 层**。
 *    这里是最后一道防线——`listAttempts` 的 SELECT 列表**刻意不含 questions/answers**，
 *    杜绝「列表接口顺手把答案带出去」。
 * 2. **RLS 直归属**（ADR-0019）：quiz_attempts 归 `RLS_DIRECT_USER_TABLES`，
 *    谓词 `user_id = app.user_id` 直接放行，读写都**不需要**归属探针那种额外通道
 *    （反之，canvas 系列的间接归属才必须走探针——那是本表刻意不采用的设计）。
 */

function toAttemptRecord(row: any): QuizAttemptRecord {
  const questions = Array.isArray(row.questions) ? row.questions : [];
  const answers = Array.isArray(row.answers) ? row.answers : null;
  return {
    id: row.id,
    user_id: row.user_id,
    topic: row.topic,
    difficulty: row.difficulty,
    status: row.status,
    questions,
    // 列表查询不 select questions，改由 DB 侧 jsonb_array_length 提供
    questionCount: Number(row.question_count ?? questions.length) || 0,
    answers,
    // 列表 SQL 不 select answers，改由 jsonb 聚合；详情/写路径则从 answers 派生
    correctCount: row.correct_count != null
      ? Number(row.correct_count)
      : (answers ? answers.filter((a: QuizAnswerRecord) => a.is_correct).length : null),
    review: row.review && typeof row.review === 'object' ? row.review : {},
    created_at: new Date(row.created_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

/**
 * 练习历史列表。⚠️ **SELECT 列表刻意不含 questions/answers**——
 * 列表只用于展示主题/难度/状态/时间与掌握情况概览，答案绝不出网（Spec §4.4）。
 * 相应地，返回的 record 里 questions 为空数组、answers 为 null，调用方不得依赖。
 */
export async function listAttempts(userId: string, limit = 20, offset = 0): Promise<QuizAttemptRecord[]> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT id, user_id, topic, difficulty, status, review, created_at, completed_at,
                jsonb_array_length(questions) AS question_count,
                CASE WHEN answers IS NULL THEN NULL
                     ELSE (SELECT COUNT(*)::int FROM jsonb_array_elements(answers) AS a
                           WHERE (a->>'is_correct')::boolean)
                END AS correct_count
         FROM quiz_attempts WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      return res.rows.map(toAttemptRecord);
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG listAttempts fallback to in-memory:', e);
    }
  }

  return Array.from(inMemoryStore.quizAttempts.values())
    .filter((a) => a.user_id === userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(offset, offset + limit)
    .map((a) => ({
      ...a,
      questions: [],
      answers: null,
      questionCount: a.questions.length,
      correctCount: a.answers ? a.answers.filter((x) => x.is_correct).length : null,
    }));
}

/** 历史总条数（分页元信息）。只 COUNT，不碰 questions/answers。 */
export async function countAttempts(userId: string): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE user_id = $1`,
        [userId]
      );
      return Number(res.rows[0]?.n) || 0;
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG countAttempts fallback to in-memory:', e);
    }
  }

  let n = 0;
  for (const a of inMemoryStore.quizAttempts.values()) {
    if (a.user_id === userId) n += 1;
  }
  return n;
}

/** 单次详情（含题目与答案）。属主校验在 service 层，此处只按 id 取。 */
export async function getAttempt(id: string): Promise<QuizAttemptRecord | null> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT id, user_id, topic, difficulty, status, questions, answers, review, created_at, completed_at
         FROM quiz_attempts WHERE id = $1`,
        [id]
      );
      return res.rows.length > 0 ? toAttemptRecord(res.rows[0]) : null;
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG getAttempt(${id}) fallback to in-memory:`, e);
    }
  }

  const found = inMemoryStore.quizAttempts.get(id);
  return found ? { ...found } : null;
}

export async function createAttempt(data: {
  id: string;
  userId: string;
  topic: string;
  difficulty: QuizAttemptRecord['difficulty'];
  questions: QuizAttemptRecord['questions'];
  review: Record<string, unknown>;
}): Promise<QuizAttemptRecord> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `INSERT INTO quiz_attempts (id, user_id, topic, difficulty, questions, review)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, user_id, topic, difficulty, status, questions, answers, review, created_at, completed_at`,
        [data.id, data.userId, data.topic, data.difficulty, JSON.stringify(data.questions), JSON.stringify(data.review)]
      );
      if (res.rows.length > 0) return toAttemptRecord(res.rows[0]);

      // 幂等冲突：同一 id 已存在（重试/并发）。属主返回既有行，他人不可确认存在。
      const existing = await db.query(
        `SELECT id, user_id, topic, difficulty, status, questions, answers, review, created_at, completed_at
         FROM quiz_attempts WHERE id = $1`,
        [data.id]
      );
      if (existing.rows.length === 0 || existing.rows[0].user_id !== data.userId) {
        throw new NotFoundError('练习记录不存在');
      }
      return toAttemptRecord(existing.rows[0]);
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG createAttempt fallback to in-memory:', e);
    }
  }

  const existingRecord = inMemoryStore.quizAttempts.get(data.id);
  if (existingRecord) {
    if (existingRecord.user_id !== data.userId) throw new NotFoundError('练习记录不存在');
    return { ...existingRecord };
  }

  const now = new Date().toISOString();
  const record: QuizAttemptRecord = {
    id: data.id,
    user_id: data.userId,
    topic: data.topic,
    difficulty: data.difficulty,
    status: 'in_progress',
    questions: data.questions,
    questionCount: data.questions.length,
    answers: null,
    correctCount: null,
    review: data.review,
    created_at: now,
    completed_at: null,
  };
  inMemoryStore.quizAttempts.set(record.id, record);
  return { ...record };
}

/**
 * 交卷：条件更新 `WHERE status='in_progress'`。
 *
 * ⚠️ **并发正确性靠这条 WHERE，不靠应用层「先查后写」**（Spec §4.2）：
 * 重复提交时第二次 UPDATE 影响 0 行 → 抛 409。这样没有「查完到写完之间」被插入的竞态窗口，
 * 且天然幂等。内存分支用同一语义（已 completed 则抛 409）。
 */
export async function completeAttempt(
  id: string,
  userId: string,
  answers: QuizAnswerRecord[],
): Promise<QuizAttemptRecord> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `UPDATE quiz_attempts
         SET answers = $3::jsonb, status = 'completed', completed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'in_progress'
         RETURNING id, user_id, topic, difficulty, status, questions, answers, review, created_at, completed_at`,
        [id, userId, JSON.stringify(answers)]
      );
      if (res.rows.length === 0) {
        // 行不存在 / 非属主 / 已完成——先探明是哪一种再给对应错误码
        const existing = await db.query(`SELECT user_id, status FROM quiz_attempts WHERE id = $1`, [id]);
        if (existing.rows.length === 0) throw new NotFoundError('练习记录不存在');
        if (existing.rows[0].user_id !== userId) throw new ForbiddenError('无权操作他人的练习记录', 'QUIZ_FORBIDDEN');
        throw new ConflictError('该练习已提交，请勿重复作答', 'QUIZ_ALREADY_SUBMITTED');
      }
      return toAttemptRecord(res.rows[0]);
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG completeAttempt(${id}) fallback to in-memory:`, e);
    }
  }

  const record = inMemoryStore.quizAttempts.get(id);
  if (!record) throw new NotFoundError('练习记录不存在');
  if (record.user_id !== userId) throw new ForbiddenError('无权操作他人的练习记录', 'QUIZ_FORBIDDEN');
  if (record.status === 'completed') throw new ConflictError('该练习已提交，请勿重复作答', 'QUIZ_ALREADY_SUBMITTED');
  record.answers = answers;
  record.status = 'completed';
  record.completed_at = new Date().toISOString();
  return { ...record };
}

/**
 * 删除单条。属主条件写在 WHERE 里：RLS 下他人行恒为 0 行，故非属主与不存在
 * 一律 NotFound（与读接口 404 口径一致，不引入归属探针）。
 */
export async function deleteAttempt(id: string, userId: string): Promise<void> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `DELETE FROM quiz_attempts WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      if ((res.rowCount || 0) === 0) throw new NotFoundError('练习记录不存在');
      return;
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG deleteAttempt(${id}) fallback to in-memory:`, e);
    }
  }

  const record = inMemoryStore.quizAttempts.get(id);
  if (!record || record.user_id !== userId) throw new NotFoundError('练习记录不存在');
  inMemoryStore.quizAttempts.delete(id);
}

/** 清空本人全部做题记录（硬删）。返回删除条数。 */
export async function deleteAllAttempts(userId: string): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `DELETE FROM quiz_attempts WHERE user_id = $1`,
        [userId]
      );
      return res.rowCount || 0;
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG deleteAllAttempts fallback to in-memory:', e);
    }
  }

  let deleted = 0;
  for (const [id, a] of inMemoryStore.quizAttempts.entries()) {
    if (a.user_id === userId) {
      inMemoryStore.quizAttempts.delete(id);
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * 保留期清理（跨租户批量删除）。调用方必须在 system 作用域执行
 * （log-cleanup 的 runWithSystem）；仓储不自行升级作用域（ADR-0019）。
 *
 * - completed：按 completed_at（缺失回落 created_at）保留 N 天；
 * - in_progress：按 created_at 保留 N 小时（防止点了出题从不交卷的记录永久堆积）。
 */
export async function cleanupOldQuizAttempts(
  completedRetentionDays: number,
  inProgressRetentionHours: number,
): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `DELETE FROM quiz_attempts
         WHERE (status = 'completed'
                AND COALESCE(completed_at, created_at) < NOW() - make_interval(days => $1::int))
            OR (status = 'in_progress'
                AND created_at < NOW() - make_interval(hours => $2::int))`,
        [completedRetentionDays, inProgressRetentionHours]
      );
      return res.rowCount || 0;
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG cleanupOldQuizAttempts fallback to in-memory:', e);
    }
  }

  const now = Date.now();
  const completedCutoff = now - completedRetentionDays * 24 * 3600 * 1000;
  const inProgressCutoff = now - inProgressRetentionHours * 3600 * 1000;
  let deleted = 0;
  for (const [id, a] of inMemoryStore.quizAttempts.entries()) {
    const createdAt = new Date(a.created_at).getTime();
    if (a.status === 'completed') {
      const completedAt = a.completed_at ? new Date(a.completed_at).getTime() : createdAt;
      if (completedAt < completedCutoff) {
        inMemoryStore.quizAttempts.delete(id);
        deleted += 1;
      }
    } else if (createdAt < inProgressCutoff) {
      inMemoryStore.quizAttempts.delete(id);
      deleted += 1;
    }
  }
  return deleted;
}

/** 练习次数统计（供每日闸门与统计页使用）。⚠️ 只数 status='completed'。 */
export async function countCompletedAttempts(userId: string, sinceIso: string): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT COUNT(*) AS n FROM quiz_attempts
         WHERE user_id = $1 AND status = 'completed' AND created_at >= $2`,
        [userId, sinceIso]
      );
      return Number(res.rows[0]?.n) || 0;
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG countCompletedAttempts fallback to in-memory:', e);
    }
  }

  return Array.from(inMemoryStore.quizAttempts.values()).filter(
    (a) => a.user_id === userId && a.status === 'completed' && a.created_at >= sinceIso
  ).length;
}

/** 内部纯函数：从已完成记录中计算掌握度与提取薄弱知识点 */
export function calculateQuizStats(
  totalAttempts: number,
  completedRecords: Array<{
    difficulty?: string;
    questions?: any[];
    answers?: any[] | null;
  }>
): QuizStatsRecord {
  const byDifficulty: QuizStatsRecord['by_difficulty'] = {
    beginner: { total_attempts: 0, total_questions: 0, correct_questions: 0, mastery_rate: 0 },
    intermediate: { total_attempts: 0, total_questions: 0, correct_questions: 0, mastery_rate: 0 },
    advanced: { total_attempts: 0, total_questions: 0, correct_questions: 0, mastery_rate: 0 },
  };

  let totalQuestions = 0;
  let masteredQuestions = 0;
  const kpMap = new Map<string, { total: number; correct: number }>();

  for (const attempt of completedRecords) {
    const diff = (attempt.difficulty || 'beginner') as keyof typeof byDifficulty;
    if (byDifficulty[diff]) {
      byDifficulty[diff].total_attempts += 1;
    }

    const answersMap = new Map<string, boolean>();
    if (Array.isArray(attempt.answers)) {
      for (const ans of attempt.answers) {
        if (ans && ans.question_id) {
          answersMap.set(ans.question_id, Boolean(ans.is_correct));
        }
      }
    }

    if (Array.isArray(attempt.questions)) {
      for (const q of attempt.questions) {
        if (!q || !q.id) continue;
        totalQuestions += 1;
        if (byDifficulty[diff]) {
          byDifficulty[diff].total_questions += 1;
        }

        const isCorrect = answersMap.get(q.id) ?? false;
        if (isCorrect) {
          masteredQuestions += 1;
          if (byDifficulty[diff]) {
            byDifficulty[diff].correct_questions += 1;
          }
        }

        const kp = typeof q.knowledge_point === 'string' ? q.knowledge_point.trim() : '';
        if (kp) {
          let entry = kpMap.get(kp);
          if (!entry) {
            entry = { total: 0, correct: 0 };
            kpMap.set(kp, entry);
          }
          entry.total += 1;
          if (isCorrect) entry.correct += 1;
        }
      }
    }
  }

  for (const diff of Object.keys(byDifficulty) as (keyof typeof byDifficulty)[]) {
    const d = byDifficulty[diff];
    d.mastery_rate = d.total_questions > 0 ? Math.round((d.correct_questions / d.total_questions) * 100) / 100 : 0;
  }

  const overallMasteryRate = totalQuestions > 0 ? Math.round((masteredQuestions / totalQuestions) * 100) / 100 : 0;

  const weakPoints: QuizWeakPointRecord[] = Array.from(kpMap.entries())
    .map(([knowledge_point, data]) => {
      const error_count = data.total - data.correct;
      const mastery_rate = data.total > 0 ? Math.round((data.correct / data.total) * 100) / 100 : 0;
      return {
        knowledge_point,
        total: data.total,
        mastered_count: data.correct,
        error_count,
        mastery_rate,
      };
    })
    .filter((w) => w.error_count > 0 || w.mastery_rate < 1)
    .sort((a, b) => b.error_count - a.error_count || a.mastery_rate - b.mastery_rate || b.total - a.total || a.knowledge_point.localeCompare(b.knowledge_point))
    .slice(0, 10);

  return {
    total_attempts: totalAttempts,
    completed_attempts: completedRecords.length,
    total_questions: totalQuestions,
    mastered_questions: masteredQuestions,
    overall_mastery_rate: overallMasteryRate,
    by_difficulty: byDifficulty,
    weak_points: weakPoints,
  };
}

/** 学情掌握度与薄弱知识点统计（双模，只读聚合，不返回任何敏感题目答案） */
export async function getQuizStats(userId: string): Promise<QuizStatsRecord> {
  const db = getDb();
  if (db) {
    try {
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE user_id = $1`,
        [userId]
      );
      const totalAttempts = Number(countRes.rows[0]?.n) || 0;

      const res = await db.query(
        `SELECT difficulty, questions, answers
         FROM quiz_attempts
         WHERE user_id = $1 AND status = 'completed'`,
        [userId]
      );
      return calculateQuizStats(totalAttempts, res.rows);
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG getQuizStats fallback to in-memory:', e);
    }
  }

  let totalAttempts = 0;
  const completedRecords: any[] = [];
  for (const a of inMemoryStore.quizAttempts.values()) {
    if (a.user_id === userId) {
      totalAttempts += 1;
      if (a.status === 'completed') {
        completedRecords.push(a);
      }
    }
  }
  return calculateQuizStats(totalAttempts, completedRecords);
}

