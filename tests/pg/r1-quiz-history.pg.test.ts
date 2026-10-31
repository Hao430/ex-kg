/**
 * Spec R1 — 做题记录 CRUD 的 PG 真库用例（分页 / 删除 / 保留期 / 幂等）。
 *
 * 与 tests/pg/r1-quiz.pg.test.ts 的分工：那边锁 RLS 策略与基础往返，本文件锁
 * 「内存模式测不出的 SQL 行为」：
 * - listAttempts 的 LIMIT/OFFSET + ORDER BY tie-break 与 countAttempts；
 * - delete/deleteAll 的 WHERE user_id 作用域；
 * - cleanupOldQuizAttempts 的 make_interval 与跨租户 system 作用域；
 * - createAttempt 的 ON CONFLICT 幂等（PG 下 0 行回查，内存分支测不到）。
 *
 * ⚠️ 本文件**不起 HTTP server**（直接走仓储 + runWithUser/runWithSystem），
 * 因此没有 server.close 问题；但自建 ownerPool 必须在 after 里 end()，
 * 否则 node:test 事件循环不空闲 → PG 冒烟挂到 6h job 上限。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';

const { initDbSchema } = await import('../../server/core/schema.js');
const { runWithUser, runWithSystem } = await import('../../server/core/db-context.js');
const { Pool } = await import('pg');
const {
  createAttempt,
  countAttempts,
  listAttempts,
  deleteAttempt,
  deleteAllAttempts,
  cleanupOldQuizAttempts,
} = await import('../../server/repositories/quiz.repository.js');

const OWNER_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
const ownerPool = new Pool({ connectionString: OWNER_URL });

function ownerQuery<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
  return runWithSystem('R1 history PG 用例：直查夹具', () => ownerPool.query(sql, params as any[]));
}

after(() => new Promise<void>((resolve) => { void ownerPool.end().then(() => resolve()); }));

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const DAY = 24 * 3600 * 1000;

const questions = [
  {
    id: 'q1',
    type: 'single' as const,
    stem: '题干',
    options: [
      { label: 'A', text: '甲' },
      { label: 'B', text: '乙' },
      { label: 'C', text: '丙' },
      { label: 'D', text: '丁' },
    ],
    correct: 'A',
    explanation: '解析',
    knowledge_point: '知识点',
  },
];

function newAttempt(id = crypto.randomUUID(), topic = 'PG 主题') {
  return { id, userId: ALICE, topic, difficulty: 'beginner' as const, questions, review: {} };
}

async function setup(): Promise<void> {
  await initDbSchema();
  await ownerQuery(
    `INSERT INTO users (id, email, password_hash, name, email_verified)
     VALUES ($1, $2, 'x', 'Alice', true), ($3, $4, 'x', 'Bob', true)
     ON CONFLICT (id) DO NOTHING`,
    [ALICE, `r1-hist-alice-${ALICE}@t.ai`, BOB, `r1-hist-bob-${BOB}@t.ai`],
  );
}

t('PG 分页：LIMIT/OFFSET、total 与 tie-break 覆盖全部记录', async () => {
  await setup();
  for (let i = 0; i < 5; i++) {
    await runWithUser(ALICE, () => createAttempt(newAttempt(crypto.randomUUID(), `分页 ${i}`)));
  }

  const total = await runWithUser(ALICE, () => countAttempts(ALICE));
  assert.equal(total, 5);

  const p1 = await runWithUser(ALICE, () => listAttempts(ALICE, 2, 0));
  const p2 = await runWithUser(ALICE, () => listAttempts(ALICE, 2, 2));
  const p3 = await runWithUser(ALICE, () => listAttempts(ALICE, 2, 4));
  const ids = [...p1, ...p2, ...p3].map((a) => a.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5, '三页不得重复/漏项');
});

t('PG 删除：按 user_id 作用域；重复/越权删除 0 行', async () => {
  await setup();
  const a = newAttempt();
  await runWithUser(ALICE, () => createAttempt(a));

  await assert.rejects(
    () => runWithUser(BOB, () => deleteAttempt(a.id, BOB)),
    /不存在/,
    '他人删除应 404',
  );
  const still = await runWithUser(ALICE, () => listAttempts(ALICE, 50, 0));
  assert.ok(still.some((x) => x.id === a.id), '他人删除不得影响属主');

  await runWithUser(ALICE, () => deleteAttempt(a.id, ALICE));
  await assert.rejects(
    () => runWithUser(ALICE, () => deleteAttempt(a.id, ALICE)),
    /不存在/,
    '重复删除应 404',
  );
});

t('PG 清空：只删本人', async () => {
  await setup();
  await runWithUser(ALICE, () => createAttempt(newAttempt()));
  await runWithUser(ALICE, () => createAttempt(newAttempt()));
  const b = newAttempt();
  await runWithUser(BOB, () => createAttempt({ ...b, userId: BOB }));

  // 同文件前面的用例已为 Alice 建过记录；断言「删光本人」而不是固定 2 条
  const aliceBefore = await runWithUser(ALICE, () => countAttempts(ALICE));
  const bobBefore = await runWithUser(BOB, () => countAttempts(BOB));
  const deleted = await runWithUser(ALICE, () => deleteAllAttempts(ALICE));
  assert.equal(deleted, aliceBefore);
  assert.equal(await runWithUser(ALICE, () => countAttempts(ALICE)), 0);
  assert.equal(await runWithUser(BOB, () => countAttempts(BOB)), bobBefore, '不得跨租户清空');
});

t('PG 保留期：completed 180 天 / in_progress 24h，跨租户 system 作用域', async () => {
  await setup();
  const oldCompleted = newAttempt(crypto.randomUUID(), '旧完成');
  const newCompleted = newAttempt(crypto.randomUUID(), '新完成');
  const oldInProgress = newAttempt(crypto.randomUUID(), '旧未交');
  const newInProgress = newAttempt(crypto.randomUUID(), '新未交');
  const bobOld = { ...newAttempt(crypto.randomUUID(), 'Bob 旧完成'), userId: BOB };

  for (const a of [oldCompleted, newCompleted, oldInProgress, newInProgress]) {
    await runWithUser(ALICE, () => createAttempt(a));
  }
  await runWithUser(BOB, () => createAttempt(bobOld));

  for (const id of [oldCompleted.id, newCompleted.id, bobOld.id]) {
    await ownerQuery(
      `UPDATE quiz_attempts SET status='completed', completed_at = NOW(), created_at = $2 WHERE id = $1`,
      [id, new Date(Date.now() - (id === newCompleted.id ? 10 * DAY : 200 * DAY))],
    );
  }
  await ownerQuery(
    `UPDATE quiz_attempts SET completed_at = $2 WHERE id = $1`,
    [oldCompleted.id, new Date(Date.now() - 200 * DAY)],
  );
  await ownerQuery(
    `UPDATE quiz_attempts SET completed_at = $2 WHERE id = $1`,
    [bobOld.id, new Date(Date.now() - 200 * DAY)],
  );
  for (const id of [oldInProgress.id, newInProgress.id]) {
    await ownerQuery(
      `UPDATE quiz_attempts SET created_at = $2 WHERE id = $1`,
      [id, new Date(Date.now() - (id === oldInProgress.id ? 25 * 3600 * 1000 : 3600 * 1000))],
    );
  }

  const deleted = await runWithSystem('R1 history PG 用例：保留期清理', () =>
    cleanupOldQuizAttempts(180, 24),
  );
  assert.ok(deleted >= 3, '至少删除两条旧 completed + 一条旧 in_progress');

  const left = await ownerQuery<{ id: string }>(`SELECT id FROM quiz_attempts WHERE id = ANY($1::uuid[])`, [
    [oldCompleted.id, newCompleted.id, oldInProgress.id, newInProgress.id, bobOld.id],
  ]);
  const leftIds = new Set(left.rows.map((r) => r.id));
  assert.ok(!leftIds.has(oldCompleted.id), '旧 completed 应删');
  assert.ok(!leftIds.has(bobOld.id), '跨租户旧 completed 也应删（system 作用域）');
  assert.ok(!leftIds.has(oldInProgress.id), '旧 in_progress 应删');
  assert.ok(leftIds.has(newCompleted.id), '新 completed 应保留');
  assert.ok(leftIds.has(newInProgress.id), '新 in_progress 应保留');
});

t('PG 幂等：同 id 重复 create 返回既有行；他人同 id 拒绝', async () => {
  await setup();
  const a = newAttempt();
  const first = await runWithUser(ALICE, () => createAttempt(a));
  const second = await runWithUser(ALICE, () => createAttempt({ ...a, topic: '不应覆盖' }));

  assert.equal(first.id, a.id);
  assert.equal(second.id, a.id);
  assert.equal(second.topic, a.topic, '不得覆盖既有行');

  const rows = await ownerQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM quiz_attempts WHERE id = $1`, [a.id]);
  assert.equal(rows.rows[0].n, '1');

  await assert.rejects(
    () => runWithUser(BOB, () => createAttempt({ ...a, userId: BOB })),
    /不存在/,
    '他人同 id 不得确认存在',
  );
});
