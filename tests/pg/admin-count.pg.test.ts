/**
 * P0 真库 — admin 每用户画布数排除软删（PG SQL 分支）。
 * 运行：docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *       PG_SMOKE=1 npx tsx --test tests/pg/admin-count.pg.test.ts   （必须空库）
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

// 建表必须显式调用（ADR-0019：懒迁移已从仓储摘除，生产改由部署期 migrate 步骤）。
// 用动态 import：静态导入会被提升到 process.env.DATABASE_URL 赋值之前。
const { initDbSchema } = await import('../../server/core/schema.js');
const { createApp } = await import('../../server/app.js');
const { getOutboxForTest } = await import('../../server/lib/mailer.js');
const { signupRateLimiter, sendRegisterCodeRateLimiter } = await import(
  '../../server/middleware/auth.js'
);

let server: http.Server;
let base = '';
let userCookie = '';
let adminCookie = '';
const EMAIL = 'p-pg-admin-count@test.local';
const PASSWORD = 'Count123456!';

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
  (signupRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  (sendRegisterCodeRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

function saveBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes: [], edges: [] }),
  });
}

function delBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { method: 'DELETE', headers: { cookie } });
}

async function canvasCountOf(targetEmail: string): Promise<number> {
  const url = new URL(`${base}/api/admin/users`);
  url.searchParams.set('search', targetEmail);
  url.searchParams.set('limit', '10');
  const res = await fetch(url, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200, 'admin/users 应 200');
  const body = (await res.json()) as any;
  const row = body.users.find((u: any) => u.email === targetEmail);
  assert.ok(row, `应能在 admin 列表找到 ${targetEmail}`);
  return row.canvas_count;
}

async function dbCanvasCount(): Promise<number> {
  const res = await fetch(`${base}/api/db/status`);
  assert.equal(res.status, 200);
  return ((await res.json()) as any).canvasCount;
}

describe('P0 PG admin 每用户画布数排除软删', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await initDbSchema();
    await waitPgReady();
    await registerViaCode(EMAIL, PASSWORD, 'CountUser');
    userCookie = await signIn(EMAIL, PASSWORD);
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
  });
  after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  t('新建 +1；软删后回落 0（PG 子查询带 deleted_at IS NULL）', async () => {
    assert.equal(await canvasCountOf(EMAIL), 0);
    assert.equal((await saveBoard(userCookie, 'p-pg-admin-board-1')).status, 200);
    assert.equal(await canvasCountOf(EMAIL), 1);
    assert.equal((await delBoard(userCookie, 'p-pg-admin-board-1')).status, 200);
    assert.equal(await canvasCountOf(EMAIL), 0, '软删后 PG 计数应回落');
  });

  t('注销用户的画板不计入总数（db/status 与 overview 对齐用户列表）', async () => {
    const delEmail = 'p-pg-del@test.local';
    await registerViaCode(delEmail, PASSWORD, 'DelUser');
    const delCookie = await signIn(delEmail, PASSWORD);

    const before = await dbCanvasCount();
    assert.equal((await saveBoard(delCookie, 'p-pg-del-board')).status, 200);
    assert.equal(await dbCanvasCount(), before + 1, '新建后总数 +1');

    const delRes = await fetch(`${base}/api/auth/account`, {
      method: 'DELETE',
      headers: { cookie: delCookie },
    });
    assert.equal(delRes.status, 200, '注销应成功');

    assert.equal(await dbCanvasCount(), before, '注销用户画板不应计入画板总数');
    const ov = (await (
      await fetch(`${base}/api/admin/overview`, { headers: { cookie: adminCookie } })
    ).json()) as any;
    assert.equal(ov.overview.totalCanvases, before, 'overview 应与 db/status 同口径');
  });

  /**
   * 安全审查 H1：`ADMIN_USER_COLUMNS` 是显式列清单，**只在 PG 分支生效**
   * （内存分支用同一个裁剪函数，但字段来源不同）。这里在真库上跑一遍，
   * 一是证明列名拼写正确（写错会抛 SQL 错误 → `handlePgError` 之后静默落内存，
   * 只有真库能发现），二是证明凭据列确实没被投影出来。
   */
  t('真库：用户列表行不含凭据列，且 SQL 列投影拼写正确（未静默落内存）', async () => {
    const url = new URL(`${base}/api/admin/users`);
    url.searchParams.set('search', EMAIL);
    url.searchParams.set('limit', '10');
    const res = await fetch(url, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const row = body.users.find((u: any) => u.email === EMAIL);
    assert.ok(row, '应能在 admin 列表找到目标用户');

    for (const key of ['password_hash', 'verify_token', 'verify_expires_at', 'reset_token', 'reset_expires_at']) {
      assert.equal(key in row, false, `PG 分支的用户行不得包含 ${key}（H1）`);
    }
    assert.match(row.id, /^[0-9a-f-]{36}$/i, 'id 应正常返回（列名拼写正确则不会是 undefined）');
    assert.equal(typeof row.canvas_count, 'number');
    assert.equal(typeof row.created_at, 'string', 'PG 的 Date 应被归一化成 ISO 串（与内存分支同形）');
  });
});
