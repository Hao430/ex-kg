/**
 * Spec P1 真库 — 反馈工单处理通道（PG SQL 分支）。
 *
 * 内存套件测不到的东西在这里钉死：
 * - `FEEDBACK_COLUMNS` 显式列投影拼写正确（写错 → handlePgError → 静默落内存，只有真库能发现）
 * - created_at/updated_at/resolved_at 的 Date 归一化（与内存分支同形）
 * - 用户读走 RLS + 显式过滤，只见本人；匿名（user_id NULL）谁都看不到
 * - 运营台 system 作用域真的跨租户
 * - `resolved_by/resolved_at` 的 `IS NULL` 守卫在 PG 上的实际行为
 *
 * 运行：docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *       PG_SMOKE=1 npx tsx --test --test-concurrency=1 tests/pg/p1-feedback.pg.test.ts（必须空库）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
process.env.APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

// 动态 import：静态导入会被提升到 process.env.DATABASE_URL 赋值之前
const { initDbSchema } = await import('../../server/core/schema.js');
const { createApp } = await import('../../server/app.js');
const { getOutboxForTest } = await import('../../server/lib/mailer.js');
const { signupRateLimiter, sendRegisterCodeRateLimiter, feedbackSubmitRateLimiter } = await import(
  '../../server/middleware/auth.js'
);

let server: http.Server;
let base = '';
let adminCookie = '';
let adminId = '';
let userACookie = '';
let userBCookie = '';

const EMAIL_A = 'p-pg-fb-a@test.local';
const EMAIL_B = 'p-pg-fb-b@test.local';
const PASSWORD = 'Feedback123456!';
const IP_KEY = ipKeyGenerator('127.0.0.1');

async function waitPgReady(tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.connected === true && body.type === 'postgresql') return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('PG not ready — 请先 docker compose -f docker-compose.pg-smoke.yml up -d postgres');
}

async function registerViaCode(email: string, password: string, name?: string): Promise<void> {
  (signupRateLimiter as any).resetKey(IP_KEY);
  (sendRegisterCodeRateLimiter as any).resetKey(IP_KEY);
  await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '').match(/\b(\d{6})\b/)![1];
  const res = await fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code }),
  });
  assert.ok([200, 201].includes(res.status), `sign-up ${email} 应成功`);
}

async function signIn(email: string, password: string): Promise<{ cookie: string; id: string }> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  const body = (await res.json()) as any;
  return { cookie: (res.headers.get('set-cookie') || '').split(';')[0], id: body.user?.id || '' };
}

async function submit(body: Record<string, unknown>, cookie?: string): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'suggestion', rating: 5, content: 'PG 反馈', ...body }),
  });
  assert.equal(res.status, 201, `提交反馈应 201，实际 ${res.status}`);
  return ((await res.json()) as any).feedbackId as string;
}

function adminPut(id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/admin/feedbacks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify(body),
  });
}

describe('P1 PG 反馈工单处理通道', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await initDbSchema();
    await waitPgReady();
    await registerViaCode(EMAIL_A, PASSWORD, 'FbUserA');
    await registerViaCode(EMAIL_B, PASSWORD, 'FbUserB');
    userACookie = (await signIn(EMAIL_A, PASSWORD)).cookie;
    userBCookie = (await signIn(EMAIL_B, PASSWORD)).cookie;
    const admin = await signIn('admin@deepdive.ai', 'Admin123456!');
    adminCookie = admin.cookie;
    adminId = admin.id;
    feedbackSubmitRateLimiter.resetKey(IP_KEY);
  });
  after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  t('列投影拼写正确 + 时间戳归一化 + type=ux 可入库（未静默落内存）', async () => {
    const id = await submit({ type: 'ux', content: 'pg-ux', contactInfo: 'wx-pg' }, userACookie);
    const res = await fetch(`${base}/api/admin/feedbacks?limit=100`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const row = body.feedbacks.find((f: any) => f.id === id);
    assert.ok(row, 'PG 分支应能取回刚插入的工单');
    assert.equal(row.type, 'ux');
    assert.equal(row.status, 'pending', '列默认值应生效');
    assert.equal(row.admin_reply, '');
    assert.equal(row.contact_info, 'wx-pg');
    assert.match(row.id, /^[0-9a-f-]{36}$/i);
    assert.equal(typeof row.created_at, 'string');
    assert.equal(typeof row.updated_at, 'string');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/, 'PG Date 应归一化为 ISO 串（与内存分支同形）');
  });

  t('用户读：RLS + 显式过滤 → 只见本人；匿名工单谁都看不到', async () => {
    const a1 = await submit({ content: 'pg-a-1' }, userACookie);
    feedbackSubmitRateLimiter.resetKey(IP_KEY);
    const a2 = await submit({ content: 'pg-a-2' }, userACookie);
    feedbackSubmitRateLimiter.resetKey(IP_KEY);
    const b1 = await submit({ content: 'pg-b-1' }, userBCookie);
    feedbackSubmitRateLimiter.resetKey(IP_KEY);
    const anon = await submit({ content: 'pg-anon' });

    const mine = (await (await fetch(`${base}/api/feedback`, { headers: { cookie: userACookie } })).json()) as any;
    const ids = mine.feedbacks.map((f: any) => f.id);
    assert.ok(ids.includes(a1) && ids.includes(a2));
    assert.ok(!ids.includes(b1), '不得看到他人工单');
    assert.ok(!ids.includes(anon), '匿名工单的 user_id 为 NULL，任何人都查不到');
    assert.equal(mine.feedbacks.length, 3, '本人视图应恰为自己提交的三条（含前一条 ux 用例）');

    const keys = Object.keys(mine.feedbacks[0]).sort();
    assert.deepEqual(
      keys,
      ['admin_reply', 'content', 'created_at', 'id', 'rating', 'resolved_at', 'status', 'type', 'updated_at']
    );
  });

  t('运营台 system 作用域跨租户：能看到全部用户的工单与匿名工单', async () => {
    const res = await fetch(`${base}/api/admin/feedbacks?limit=100`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const emails = new Set(body.feedbacks.map((f: any) => f.user_email).filter(Boolean));
    assert.ok(emails.has(EMAIL_A), '应看到 A 的工单（跨租户）');
    assert.ok(emails.has(EMAIL_B), '应看到 B 的工单（跨租户）');
    assert.ok(body.feedbacks.some((f: any) => f.user_id === null), '应看到匿名工单');
    assert.equal(typeof body.statusCounts.pending, 'number');
  });

  t('流转落 resolved_by/resolved_at；终态修订回复不刷新定案信息', async () => {
    const id = await submit({ content: 'pg-流转' }, userACookie);
    feedbackSubmitRateLimiter.resetKey(IP_KEY);

    const first = await adminPut(id, { status: 'resolved', admin_reply: '初版' });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as any;
    assert.equal(firstBody.feedback.status, 'resolved');
    assert.equal(firstBody.feedback.resolved_by, adminId, 'CASE 分支应落当前管理员 uuid');
    assert.ok(firstBody.feedback.resolved_at);
    assert.match(firstBody.feedback.resolved_at, /^\d{4}-\d{2}-\d{2}T/);

    const second = await adminPut(id, { status: 'resolved', admin_reply: '修订版' });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as any;
    assert.equal(secondBody.feedback.admin_reply, '修订版');
    assert.equal(secondBody.feedback.resolved_by, firstBody.feedback.resolved_by);
    assert.equal(secondBody.feedback.resolved_at, firstBody.feedback.resolved_at, 'IS NULL 守卫应生效');
  });

  t('非法流转 400 / 未知 uuid 404（PG 路径不因 22P02 变 500）', async () => {
    const id = await submit({ content: 'pg-校验' }, userACookie);
    feedbackSubmitRateLimiter.resetKey(IP_KEY);

    const noReply = await adminPut(id, { status: 'resolved' });
    assert.equal(noReply.status, 400);
    assert.equal(((await noReply.json()) as any).code, 'FEEDBACK_REPLY_REQUIRED');

    const missing = await adminPut('00000000-0000-4000-8000-000000000000', {
      status: 'rejected',
      admin_reply: 'x',
    });
    assert.equal(missing.status, 404);
  });

  t('非 admin 访问运营台工单列表 403（system 作用域只发给管理员）', async () => {
    const res = await fetch(`${base}/api/admin/feedbacks`, { headers: { cookie: userACookie } });
    assert.equal(res.status, 403);
  });
});
