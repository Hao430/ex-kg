/**
 * Spec R1 — 详情 DTO 的 PG JSONB 往返（选项全文 / 作答记录）。
 *
 * 不起 HTTP server；after 只 end ownerPool（若起 server 必须 close）。
 * tests/ 只读：本文件为新增（用户 2026-10-25 授权）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';

const { initDbSchema } = await import('../../server/core/schema.js');
const { runWithUser, runWithSystem } = await import('../../server/core/db-context.js');
const { createAttempt, completeAttempt, getAttempt } = await import('../../server/repositories/quiz.repository.js');
const { Pool } = await import('pg');

const OWNER_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
const ownerPool = new Pool({ connectionString: OWNER_URL });

function ownerQuery<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
  return runWithSystem('R1 detail PG 用例：直查夹具', () => ownerPool.query(sql, params as any[]));
}

after(() => new Promise<void>((resolve) => { void ownerPool.end().then(() => resolve()); }));

const USER = crypto.randomUUID();
const questions = [
  {
    id: 'q-single',
    type: 'single' as const,
    stem: '单选题干',
    options: [
      { label: 'A', text: '甲' },
      { label: 'B', text: '乙' },
      { label: 'C', text: '丙' },
      { label: 'D', text: '丁' },
    ],
    correct: 'B',
    explanation: '解析',
    knowledge_point: '知识点',
  },
  {
    id: 'q-tf',
    type: 'true_false' as const,
    stem: '判断题干',
    options: null,
    correct: 'true',
    explanation: '判断题解析',
    knowledge_point: '判断知识点',
  },
];

async function setup() {
  await initDbSchema();
  await ownerQuery(
    `INSERT INTO users (id, email, password_hash, name, email_verified)
     VALUES ($1, $2, 'x', 'Detail', true) ON CONFLICT (id) DO NOTHING`,
    [USER, `r1-detail-${USER}@t.ai`],
  );
}

t('PG：questions.options 写入/读出无损，判断题仍为 null', async () => {
  await setup();
  const id = crypto.randomUUID();
  await runWithUser(USER, () => createAttempt({
    id, userId: USER, topic: 'PG 详情', difficulty: 'beginner', questions, review: {},
  }));

  const row = await runWithUser(USER, () => getAttempt(id));
  assert.ok(row);
  const single = row!.questions.find((q) => q.id === 'q-single')!;
  const tf = row!.questions.find((q) => q.id === 'q-tf')!;
  assert.deepEqual(single.options?.map((o) => o.label), ['A', 'B', 'C', 'D']);
  assert.equal(single.options?.[1].text, '乙');
  assert.equal(tf.options, null, '判断题 options 必须保持 null');
  assert.equal(single.correct, 'B');
});

t('PG：交卷后 answers JSONB 往返，choice 与 is_correct 可回放', async () => {
  await setup();
  const id = crypto.randomUUID();
  await runWithUser(USER, () => createAttempt({
    id, userId: USER, topic: 'PG 回放', difficulty: 'beginner', questions, review: {},
  }));

  await runWithUser(USER, () => completeAttempt(id, USER, [
    { question_id: 'q-single', choice: 'A', is_correct: false, elapsed_ms: 4000, low_confidence: false },
    { question_id: 'q-tf', choice: 'true', is_correct: true, elapsed_ms: 6000, low_confidence: false },
  ]));

  const row = await runWithUser(USER, () => getAttempt(id));
  assert.ok(row?.answers);
  assert.equal(row!.answers!.find((a) => a.question_id === 'q-single')!.choice, 'A');
  assert.equal(row!.answers!.find((a) => a.question_id === 'q-single')!.is_correct, false);
  assert.equal(row!.answers!.find((a) => a.question_id === 'q-tf')!.is_correct, true);
  assert.equal(row!.questions.find((q) => q.id === 'q-single')!.correct, 'B');
});
