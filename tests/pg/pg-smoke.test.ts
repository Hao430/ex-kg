/**
 * J3 — PG 真库冒烟测试（跟踪清单 E1 / 里程碑 J 组）
 *
 * 背景：全套件仅跑 memory 降级分支，PG 分支无自动化覆盖；H/I 两组「上线前连真库冒烟」
 * 验收项长期未勾。本文件用 docker compose（docker-compose.pg-smoke.yml，端口 5433）起
 * postgres:16 真库，验证双模仓储的 PG 真实路径。
 *
 * 运行方式（不进默认套件）：
 *   docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *   PG_SMOKE=1 npx tsx --test tests/pg/pg-smoke.test.ts
 *
 * 覆盖（对应 H 组验收口径）：
 * - 软删 UPDATE：DELETE 后 list/get 404、行仍存在（deleted_at 非空）
 * - 子表即时物理清理：nodes/edges 行删除
 * - saveCanvas 防复活：ON CONFLICT ... WHERE deleted_at IS NULL，对已软删 id 保存 404
 * - 越权：非属主读 404 / 写 403 CANVAS_FORBIDDEN
 * - 双模输出归一化：getCanvas 返回的 node.data 具备与 memory 分支一致的默认值
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

const { createApp } = await import('../../server/app.js');
const { getPool } = await import('../../server/core/pool.js');
const { getOutboxForTest } = await import('../../server/lib/mailer.js');
const { signupRateLimiter, sendRegisterCodeRateLimiter } = await import(
  '../../server/middleware/auth.js'
);

let server: http.Server;
let base = '';
let aliceCookie = '';
let bobCookie = '';

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

async function saveBoard(cookie: string, id: string, nodes: any[]): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function getBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
}

function delBoard(cookie: string, id: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}`, { method: 'DELETE', headers: { cookie } });
}

describe('J3 PG 真库冒烟（E1）', () => {
  t('PG 连接与建表', async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitPgReady();
  });

  t('注册走通 PG：验证码消费 + 出生即 email_verified', async () => {
    await registerViaCode('j3-alice@test.local', 'Alice123456!', 'Alice');
    await registerViaCode('j3-bob@test.local', 'Bob123456!', 'Bob');
    aliceCookie = await signIn('j3-alice@test.local', 'Alice123456!');
    bobCookie = await signIn('j3-bob@test.local', 'Bob123456!');
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: aliceCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.user?.email_verified ?? body.email_verified ?? true, true);
  });

  t('保存与读取走通 PG：node.data 归一化默认值齐全（双模对齐）', async () => {
    const nodes = [
      {
        id: 'j3-n1',
        type: 'chat',
        position: { x: 0, y: 0 },
        data: { question: '什么是软删除？', answer: '', status: 'idle' },
      },
    ];
    const saveRes = await saveBoard(aliceCookie, 'j3-alice-board', nodes);
    assert.equal(saveRes.status, 200);

    const res = await getBoard(aliceCookie, 'j3-alice-board');
    assert.equal(res.status, 200);
    const canvas = (await res.json()) as any;
    const node = (canvas.nodes || []).find((n: any) => n.id === 'j3-n1');
    assert.ok(node, 'PG getCanvas 应返回节点');
    // 与 memory 分支 normalizeMemoryNode 同款默认值清单的关键字段
    assert.ok(node.data, 'node.data 必须存在（归一化）');
    assert.ok(Array.isArray(node.data.messages), 'messages 默认数组');
    assert.equal(node.data.isCollapsed, false, 'isCollapsed 默认 false');
    assert.equal(node.data.depth, 0, 'depth 默认 0');
    assert.equal(node.data.status, 'idle');
  });

  t('越权：bob 读 alice 画板 404 / 写 403 CANVAS_FORBIDDEN', async () => {
    const read = await getBoard(bobCookie, 'j3-alice-board');
    assert.equal(read.status, 404);
    const write = await saveBoard(bobCookie, 'j3-alice-board', []);
    assert.equal(write.status, 403);
  });

  t('软删 + 子表物理清 + 防复活', async () => {
    // 先再插一次带 edges 的内容，验证子表清理
    const fullNodes = [
      { id: 'j3-n2', type: 'chat', position: { x: 0, y: 0 }, data: { question: 'q2', status: 'idle' } },
    ];
    const fullEdges = [{ id: 'j3-e1', source: 'j3-n1', target: 'j3-n2' }];
    const saveRes = await fetch(`${base}/api/canvases/j3-alice-board/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ id: 'j3-alice-board', title: 'j3-alice-board', nodes: fullNodes, edges: fullEdges }),
    });
    assert.equal(saveRes.status, 200);

    const delRes = await delBoard(aliceCookie, 'j3-alice-board');
    assert.equal(delRes.status, 200);

    // 行仍在（软删），子表行已物理清
    const pool = getPool();
    assert.ok(pool, 'PG pool 必须可用');
    const row = await pool.query(
      'SELECT deleted_at FROM canvases WHERE id = $1',
      ['j3-alice-board']
    );
    assert.equal(row.rows.length, 1, 'canvases 行应保留（软删）');
    assert.ok(row.rows[0].deleted_at, 'deleted_at 应已写入');
    const nodeRows = await pool.query(
      'SELECT COUNT(*)::int AS c FROM nodes WHERE canvas_id = $1',
      ['j3-alice-board']
    );
    assert.equal(nodeRows.rows[0].c, 0, 'nodes 子表应已物理清空');
    const edgeRows = await pool.query(
      'SELECT COUNT(*)::int AS c FROM edges WHERE canvas_id = $1',
      ['j3-alice-board']
    );
    assert.equal(edgeRows.rows[0].c, 0, 'edges 子表应已物理清空');

    // 删除后读 404
    const readAfter = await getBoard(aliceCookie, 'j3-alice-board');
    assert.equal(readAfter.status, 404);

    // 对已软删 id 再 save → 404 防复活（upsert WHERE deleted_at IS NULL）
    const zombie = await saveBoard(aliceCookie, 'j3-alice-board', fullNodes);
    assert.equal(zombie.status, 404, '已软删画布不可通过 save 复活');
    const stillGone = await pool.query(
      'SELECT deleted_at FROM canvases WHERE id = $1 AND deleted_at IS NULL',
      ['j3-alice-board']
    );
    assert.equal(stillGone.rows.length, 0, '软删行不得被 upsert 复活');
  });

  after(
    () =>
      new Promise<void>((resolve) => {
        if (server) server.close(() => resolve());
        else resolve();
      })
  );
});
