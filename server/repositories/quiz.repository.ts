import { getDb } from '../core/db.js';
import { inMemoryStore } from '../core/memory-store.js';
import { AppError, ForbiddenError, NotFoundError, ConflictError } from '../lib/errors.js';
import { handlePgError } from '../core/db-guard.js';
import type { QuizAttemptRecord, QuizAnswerRecord } from '../core/records.js';

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
  return {
    id: row.id,
    user_id: row.user_id,
    topic: row.topic,
    difficulty: row.difficulty,
    status: row.status,
    questions,
    // 列表查询不 select questions，改由 DB 侧 jsonb_array_length 提供
    questionCount: Number(row.question_count ?? questions.length) || 0,
    answers: Array.isArray(row.answers) ? row.answers : null,
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
export async function listAttempts(userId: string, limit = 20): Promise<QuizAttemptRecord[]> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT id, user_id, topic, difficulty, status, review, created_at, completed_at,
                jsonb_array_length(questions) AS question_count
         FROM quiz_attempts WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
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
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((a) => ({ ...a, questions: [], answers: null, questionCount: a.questions.length }));
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
         RETURNING id, user_id, topic, difficulty, status, questions, answers, review, created_at, completed_at`,
        [data.id, data.userId, data.topic, data.difficulty, JSON.stringify(data.questions), JSON.stringify(data.review)]
      );
      return toAttemptRecord(res.rows[0]);
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn('PG createAttempt fallback to in-memory:', e);
    }
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
