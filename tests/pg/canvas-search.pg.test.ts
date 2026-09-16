/**
 * O1 — 画板内节点搜索：PG 真库路径（对应 tests/canvas-node-search.test.ts 的内存侧）
 *
 * 内存侧测不到的 PG 特有语义：
 * - 带双引号列别名确实生效（row.canvasId 存在、row.canvas_id 不存在）——引号漏掉会被 PG
 *   折成小写，前端消费字段即断
 * - ILIKE + ESCAPE '\' 的真实转义行为（%/_ 通配符字面量化）
 * - ORDER BY depth/pos_y/pos_x 走真实列（pos_x/pos_y 是 DOUBLE PRECISION 列）
 * - n.status <> 'suggested' 过滤（countCanvasNodes 同口径）
 *
 * 运行方式（不进默认套件；9 个 pg 文件共用同一个库、各自在用例里跑迁移，务必串行）：
 *   docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *   PG_SMOKE=1 npx tsx --test --test-concurrency=1 'tests/pg/*.test.ts'
 * ⚠️ 用例注册固定邮箱（p-pg-search-*），复用写过的旧库会撞 EMAIL_EXISTS(409)，必须空库跑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
process.env.APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

const { createApp } = await import('../../server/app.js');
// 建表必须显式调用（ADR-0019：懒迁移已从仓储摘除）。动态 import：静态导入会被提升到
// process.env.DATABASE_URL 赋值之前。
const { initDbSchema } = await import('../../server/core/schema.js');
const { getOutboxForTest } = await import('../../server/lib/mailer.js');
const { signupRateLimiter, sendRegisterCodeRateLimiter } = await import(
  '../../server/middleware/auth.js'
);

let server: http.Server;
let base = '';
let aliceCookie = '';

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

function saveBoard(cookie: string, id: string, nodes: any[]): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function searchInBoard(cookie: string, id: string, q: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });
}

async function searchIds(cookie: string, id: string, q: string): Promise<string[]> {
  const res = await searchInBoard(cookie, id, q);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  return (body.results || []).map((r: any) => r.id);
}

describe('O1 节点搜索 PG 真库', () => {
  t('连接与建表 + 探针数据落库', async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await initDbSchema();
    await waitPgReady();

    await registerViaCode('p-pg-search-alice@test.local', 'PgSearch123!', 'AliceSearch');
    aliceCookie = await signIn('p-pg-search-alice@test.local', 'PgSearch123!');

    assert.equal(
      (await saveBoard(aliceCookie, 'p-pg-search-board-1', [
        { id: 'p-pg-sn-pct', type: 'chat', position: { x: 0, y: 0 }, data: { question: '折扣 100% off', answer: '', status: 'idle' } },
        { id: 'p-pg-sn-thousand', type: 'chat', position: { x: 0, y: 100 }, data: { question: '数量 1000 个', answer: '', status: 'idle' } },
        { id: 'p-pg-sn-underscore', type: 'chat', position: { x: 0, y: 200 }, data: { question: '变量名 user_id 字段', answer: '', status: 'idle' } },
        { id: 'p-pg-sn-suggested', type: 'chat', position: { x: 0, y: 300 }, data: { question: 'p.pg占位探针', answer: '', status: 'suggested' } },
        { id: 'p-pg-sn-idle', type: 'chat', position: { x: 0, y: 400 }, data: { question: 'p.pg普通探针', answer: '', status: 'idle' } },
        // 排序探针：pos_y 与写入 depth（depth 0/1/2）
        { id: 'p-pg-sn-deep', type: 'chat', position: { x: 0, y: 900 }, data: { question: 'p.pg排序探针', answer: '', status: 'idle', depth: 2 } },
        { id: 'p-pg-sn-root', type: 'chat', position: { x: 0, y: 800 }, data: { question: 'p.pg排序探针', answer: '', status: 'idle', depth: 0 } },
        { id: 'p-pg-sn-mid', type: 'chat', position: { x: 0, y: 700 }, data: { question: 'p.pg排序探针', answer: '', status: 'idle', depth: 1 } },
      ])).status,
      200
    );
  });

  t('空 q → 空结果（getDb() 之前早退，PG 分支不再被空串旁路进内存语义）', async () => {
    for (const q of ['', '   ']) {
      const res = await searchInBoard(aliceCookie, 'p-pg-search-board-1', q);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.deepEqual(body.results, []);
    }
  });

  t('% / _ 通配符字面量化：ESCAPE 转义在真库生效', async () => {
    assert.deepEqual(await searchIds(aliceCookie, 'p-pg-search-board-1', '100%'), ['p-pg-sn-pct']);
    assert.deepEqual(await searchIds(aliceCookie, 'p-pg-search-board-1', 'u_er'), []);
    assert.deepEqual(await searchIds(aliceCookie, 'p-pg-search-board-1', 'user_id'), ['p-pg-sn-underscore']);
  });

  t('suggested 排除走 PG 列过滤（n.status <> suggested）', async () => {
    assert.deepEqual(await searchIds(aliceCookie, 'p-pg-search-board-1', 'p.pg占位探针'), []);
    assert.deepEqual(await searchIds(aliceCookie, 'p-pg-search-board-1', 'p.pg普通探针'), ['p-pg-sn-idle']);
  });

  t('camelCase 别名生效：有 canvasId/noteContent，无 canvas_id/note_content/created_at', async () => {
    const res = await searchInBoard(aliceCookie, 'p-pg-search-board-1', 'p.pg排序探针');
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.results.length >= 3);
    for (const row of body.results) {
      assert.ok('canvasId' in row, '必须返回 camelCase canvasId（引号别名）');
      assert.ok('noteContent' in row, '必须返回 camelCase noteContent');
      assert.ok(!('canvas_id' in row), '不得残留 snake_case canvas_id');
      assert.ok(!('note_content' in row), '不得残留 snake_case note_content');
      assert.ok(!('created_at' in row), '不得返回 created_at（内存分支无此字段，返回必分叉）');
      assert.deepEqual(Object.keys(row).sort(),
        ['answer', 'canvasId', 'depth', 'id', 'model', 'noteContent', 'question', 'title', 'type'].sort());
    }
  });

  t('排序走真实列：depth 升序为主序（pos_y/pos_x 为 DOUBLE PRECISION）', async () => {
    const ids = await searchIds(aliceCookie, 'p-pg-search-board-1', 'p.pg排序探针');
    assert.deepEqual(ids, ['p-pg-sn-root', 'p-pg-sn-mid', 'p-pg-sn-deep']);
  });
});
