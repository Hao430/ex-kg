/**
 * Spec P1 — 反馈工单处理通道（内存模式）
 *
 * 断言点：
 * - POST /api/feedback 可匿名、可带会话；'ux' 类型不再 400（枚举分叉修复回归）
 * - 默认工单字段（status=pending / admin_reply=''）双模对齐
 * - GET /api/feedback：未登录 401；登录只见本人工单；用户视图恰 9 键白名单
 * - GET /api/admin/feedbacks：非 admin 403；过滤 + 分页 + statusCounts
 * - PUT /api/admin/feedbacks/:id：流转合法性、resolved 必带回复、首次终态落 resolved_by/resolved_at
 * - 审计 admin_feedback_update 只记 from/to，不落正文
 * - POST 反馈 5/h per IP 限流生效
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { feedbackSubmitRateLimiter } from '../server/middleware/auth.js';
import { getAuditLogsForTest } from '../server/repositories/audit.repository.js';
import { getFeedbackById } from '../server/repositories/feedback.repository.js';

let server: http.Server;
let base = '';
let adminCookie = '';
let adminId = '';
let userACookie = '';
let userBCookie = '';

const IP_KEY = ipKeyGenerator('127.0.0.1');

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = await res.json() as any;
      if (body.userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

async function signIn(email: string, password: string): Promise<{ cookie: string; id: string }> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  const body = await res.json() as any;
  return {
    cookie: (res.headers.get('set-cookie') || '').split(';')[0],
    id: body.user?.id || '',
  };
}

async function submitFeedback(body: Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'suggestion', rating: 5, content: '反馈内容', ...body }),
  });
  return { res, body: await res.json() as any };
}

async function submitFeedbackForId(body: Record<string, unknown>, cookie?: string): Promise<string> {
  // 每个用例用独立配额：本文件提交次数远超 5/h，限流行为由用例 13 专测
  feedbackSubmitRateLimiter.resetKey(IP_KEY);
  const { res, body: parsed } = await submitFeedback(body, cookie);
  assert.equal(res.status, 201);
  assert.ok(parsed.feedbackId, '应回 feedbackId');
  return parsed.feedbackId as string;
}

async function listAdminFeedbacks(query = '', cookie = adminCookie) {
  const res = await fetch(`${base}/api/admin/feedbacks${query}`, { headers: { cookie } });
  return { res, body: await res.json() as any };
}

describe('P1 反馈工单处理通道', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    const admin = await signIn('admin@deepdive.ai', 'Admin123456!');
    adminCookie = admin.cookie;
    adminId = admin.id;
    userACookie = (await signIn('user@deepdive.ai', 'User123456!')).cookie;
    userBCookie = (await signIn('vip@deepdive.ai', 'Vip123456!')).cookie;
    feedbackSubmitRateLimiter.resetKey(IP_KEY);
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('1. 匿名提交 + 默认工单字段双模对齐', async () => {
    const id = await submitFeedbackForId({ content: 'p1-匿名反馈' });

    // 响应体只有 feedbackId（不泄露工单内容），默认值经仓储核对
    const record = await getFeedbackById(id);
    assert.ok(record, '工单应已入库');
    assert.equal(record.status, 'pending');
    assert.equal(record.admin_reply, '');
    assert.equal(record.resolved_by, null);
    assert.equal(record.resolved_at, null);
    assert.equal(record.user_id, null, '匿名提交用户归属为空');
    assert.equal(record.user_email, null);
  });

  test('2. type=ux 提交不再 400（枚举分叉修复）', async () => {
    const id = await submitFeedbackForId({ type: 'ux', content: 'p1-体验优化' });
    const record = await getFeedbackById(id);
    assert.equal(record?.type, 'ux');
  });

  test('3. 带会话提交落 user_id / user_email', async () => {
    const id = await submitFeedbackForId({ content: 'p1-带会话' }, userACookie);
    const record = await getFeedbackById(id);
    assert.ok(record?.user_id, '带会话应有 user_id');
    assert.equal(record?.user_email, 'user@deepdive.ai');
  });

  test('4. GET /api/feedback 未登录 401', async () => {
    const res = await fetch(`${base}/api/feedback`);
    assert.equal(res.status, 401);
  });

  test('5. 用户只能看到自己的工单', async () => {
    const a1 = await submitFeedbackForId({ content: 'p1-A-1' }, userACookie);
    const a2 = await submitFeedbackForId({ content: 'p1-A-2' }, userACookie);
    const b1 = await submitFeedbackForId({ content: 'p1-B-1' }, userBCookie);

    const res = await fetch(`${base}/api/feedback`, { headers: { cookie: userACookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    const ids = body.feedbacks.map((f: any) => f.id);
    assert.ok(ids.includes(a1) && ids.includes(a2), 'A 应看到自己的两条工单');
    assert.ok(!ids.includes(b1), 'A 不应看到 B 的工单');
    assert.ok(!ids.includes(''), 'id 列表不应有空洞');
  });

  test('6. 用户视图恰为 9 键白名单（无 resolved_by/contact_info/user_email/user_id）', async () => {
    const res = await fetch(`${base}/api/feedback`, { headers: { cookie: userACookie } });
    const body = await res.json() as any;
    assert.ok(body.feedbacks.length > 0);
    const keys = Object.keys(body.feedbacks[0]).sort();
    assert.deepEqual(
      keys,
      ['admin_reply', 'content', 'created_at', 'id', 'rating', 'resolved_at', 'status', 'type', 'updated_at']
    );
  });

  test('7. 非 admin 访问运营台工单列表 403', async () => {
    const { res } = await listAdminFeedbacks('', userACookie);
    assert.equal(res.status, 403);
  });

  test('8. admin 列表：全量含匿名、类型过滤、分页、statusCounts', async () => {
    const all = await listAdminFeedbacks();
    assert.equal(all.res.status, 200);
    assert.ok(all.body.total >= 6, `应含本文件已提交的全部工单，实际 ${all.body.total}`);
    assert.ok(
      all.body.feedbacks.some((f: any) => f.user_id === null),
      '运营台必须能看到匿名工单'
    );
    for (const key of ['pending', 'processing', 'resolved', 'rejected']) {
      assert.equal(typeof all.body.statusCounts[key], 'number', `statusCounts 应有 ${key}`);
    }

    const bugs = await listAdminFeedbacks('?type=bug');
    assert.ok(bugs.body.feedbacks.every((f: any) => f.type === 'bug'));

    const page = await listAdminFeedbacks('?limit=2&page=2');
    assert.equal(page.body.feedbacks.length, 2);
    assert.equal(page.body.limit, 2);
  });

  test('9. pending→resolved 带回复：落 resolved_by/resolved_at 并推进 updated_at', async () => {
    const id = await submitFeedbackForId({ content: 'p1-流转' }, userACookie);
    const before = await getFeedbackById(id);

    const res = await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'resolved', admin_reply: '已修复，感谢反馈' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.feedback.status, 'resolved');
    assert.equal(body.feedback.admin_reply, '已修复，感谢反馈');
    assert.equal(body.feedback.resolved_by, adminId, '定案人应为当前管理员');
    assert.ok(body.feedback.resolved_at, 'resolved_at 应落值');
    assert.ok(
      new Date(body.feedback.updated_at).getTime() >= new Date(before!.updated_at).getTime(),
      'updated_at 应推进（或至少不倒退）'
    );

    const mine = await (await fetch(`${base}/api/feedback`, { headers: { cookie: userACookie } })).json() as any;
    const shown = mine.feedbacks.find((f: any) => f.id === id);
    assert.equal(shown.status, 'resolved');
    assert.equal(shown.admin_reply, '已修复，感谢反馈', '用户应能看到回复');
  });

  test('10. 非法输入：resolved 缺回复 400 / 终态倒流 400 / 未知 id 404', async () => {
    const id = await submitFeedbackForId({ content: 'p1-校验' }, userACookie);

    const noReply = await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(noReply.status, 400);
    assert.equal((await noReply.json() as any).code, 'FEEDBACK_REPLY_REQUIRED');

    // 先合法进入终态
    await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'resolved', admin_reply: '已处理' }),
    });
    const back = await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'pending' }),
    });
    assert.equal(back.status, 400);
    assert.equal((await back.json() as any).code, 'FEEDBACK_INVALID_TRANSITION');

    const missing = await fetch(`${base}/api/admin/feedbacks/00000000-0000-4000-8000-000000000000`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'resolved', admin_reply: 'x' }),
    });
    assert.equal(missing.status, 404);
  });

  test('11. 终态修订回复：200 且 resolved_by/resolved_at 不变', async () => {
    const id = await submitFeedbackForId({ content: 'p1-修订' }, userACookie);
    const first = await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'resolved', admin_reply: '初版回复' }),
    });
    const firstBody = await first.json() as any;

    const second = await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'resolved', admin_reply: '修订后的回复' }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as any;
    assert.equal(secondBody.feedback.admin_reply, '修订后的回复');
    assert.equal(secondBody.feedback.resolved_by, firstBody.feedback.resolved_by);
    assert.equal(secondBody.feedback.resolved_at, firstBody.feedback.resolved_at, '定案时间不应被修订刷新');
  });

  test('12. 审计只记 from/to，不落工单正文', async () => {
    const id = await submitFeedbackForId({ content: 'p1-审计-不应出现在日志', contactInfo: 'wx-secret' }, userACookie);
    await fetch(`${base}/api/admin/feedbacks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'rejected', admin_reply: '不采纳' }),
    });

    const log = getAuditLogsForTest().find(
      (l) => l.action === 'admin_feedback_update' && l.target_id === id
    );
    assert.ok(log, '应写入 admin_feedback_update 审计');
    assert.deepEqual(log.details, { from: 'pending', to: 'rejected' });
    assert.ok(!JSON.stringify(log).includes('p1-审计-不应出现在日志'), '审计不得落工单正文');
    assert.ok(!JSON.stringify(log).includes('wx-secret'), '审计不得落联系方式');
  });

  test('13. POST 反馈 5/h per IP 限流：第 6 次 429', async () => {
    feedbackSubmitRateLimiter.resetKey(IP_KEY);
    for (let i = 0; i < 5; i++) {
      const { res } = await submitFeedback({ content: `p1-限流-${i}` });
      assert.equal(res.status, 201, `第 ${i + 1} 次应放行`);
    }
    const { res, body } = await submitFeedback({ content: 'p1-限流-6' });
    assert.equal(res.status, 429);
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
  });
});
