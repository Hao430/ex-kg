/**
 * P0 真库 — saveCanvas 归一化（PG SQL 分支）：去重节点/边、丢悬挂边、响应计数为真实值。
 * 运行：docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *       PG_SMOKE=1 npx tsx --test tests/pg/canvas-normalize.pg.test.ts   （必须空库）
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
const { getOutboxForTest } = await import('../../server/lib/mailer.js');
const { signupRateLimiter, sendRegisterCodeRateLimiter } = await import(
  '../../server/middleware/auth.js'
);

let server: http.Server;
let base = '';
let cookie = '';
const EMAIL = 'p-pg-normalize@test.local';
const PASSWORD = 'Norm123456!';
const BOARD_ID = 'p-pg-normalize-board';

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

describe('P0 PG saveCanvas 归一化', () => {
  let saveBody: any;

  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitPgReady();
    await registerViaCode(EMAIL, PASSWORD, 'NormUser');
    cookie = await signIn(EMAIL, PASSWORD);

    const res = await fetch(`${base}/api/canvases/${BOARD_ID}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        id: BOARD_ID,
        title: 'PG 归一化',
        nodes: [
          { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'A' } },
          { id: 'n1', type: 'chat', position: { x: 1, y: 1 }, data: { title: 'A-dup' } },
          { id: 'n2', type: 'note', position: { x: 2, y: 2 }, data: { content: '便签' } },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2' },
          { id: 'e1', source: 'n2', target: 'n1' },
          { id: 'e2', source: 'n1', target: 'missing' },
        ],
      }),
    });
    assert.equal(res.status, 200, 'save 应 200');
    saveBody = await res.json();
  });
  after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  t('save 响应计数为归一化真实值（2 节点 / 1 边）', async () => {
    assert.equal(saveBody.canvas.nodeCount, 2);
    assert.equal(saveBody.canvas.edgeCount, 1);
  });

  t('GET 单板/列表：落库已归一化，无悬挂边', async () => {
    const single = await fetch(`${base}/api/canvases/${BOARD_ID}`, { headers: { cookie } });
    assert.equal(single.status, 200);
    const canvas = (await single.json()) as any;
    assert.equal(canvas.nodes.length, 2);
    assert.equal(canvas.edges.length, 1);

    const listRes = await fetch(`${base}/api/canvases`, { headers: { cookie } });
    const list = (await listRes.json()) as any[];
    const board = list.find((c) => c.id === BOARD_ID);
    assert.ok(board);
    assert.equal(board.nodeCount, 2);
    assert.equal(board.edgeCount, 1);
  });
});
