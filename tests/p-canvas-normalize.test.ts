/**
 * P0 服务端 — saveCanvas 双模归一化（2026-09-10 画布计数链路重构）。
 *
 * 排查发现 PG 分支在保存时按 id 去重节点、丢弃悬挂边，内存分支不做，
 * 导致内存 nodeCount/edgeCount 可能大于 PG；且旧 save 响应回报「原始提交长度」，
 * 与随后列表的 DISTINCT 计数不一致。
 *
 * 本文件锁定：内存分支现在与 PG 分支共用 normalizeCanvasPayload——
 * 重复节点 id 去重、重复边 id 去重、端点缺失的边丢弃，且 save 响应计数为归一化后的真实值。
 * PG 分支对应 tests/pg/canvas-normalize.pg.test.ts。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import { signupRateLimiter, sendRegisterCodeRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';
let cookie = '';
const EMAIL = 'p-normalize@test.local';
const PASSWORD = 'Norm123456!';
const BOARD_ID = 'p-normalize-board';

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
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

describe('P0 saveCanvas 双模归一化（内存分支）', () => {
  let saveBody: any;

  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    await registerViaCode(EMAIL, PASSWORD, 'NormUser');
    cookie = await signIn(EMAIL, PASSWORD);

    const res = await fetch(`${base}/api/canvases/${BOARD_ID}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        id: BOARD_ID,
        title: '归一化',
        nodes: [
          { id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: 'A' } },
          // 重复节点 id（前端合并/冲突自愈后偶发）
          { id: 'n1', type: 'chat', position: { x: 1, y: 1 }, data: { title: 'A-dup' } },
          { id: 'n2', type: 'note', position: { x: 2, y: 2 }, data: { content: '便签' } },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2' },
          // 重复边 id
          { id: 'e1', source: 'n2', target: 'n1' },
          // 端点缺失的悬挂边
          { id: 'e2', source: 'n1', target: 'missing' },
        ],
      }),
    });
    assert.equal(res.status, 200, 'save 应 200');
    saveBody = await res.json();
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('save 响应计数为归一化后的真实值（2 节点 / 1 边）', async () => {
    assert.equal(saveBody.canvas.nodeCount, 2, '重复节点应去重');
    assert.equal(saveBody.canvas.edgeCount, 1, '重复边与悬挂边应被丢弃');
  });

  test('GET 单板：落库节点/边已归一化，悬挂边不存在', async () => {
    const res = await fetch(`${base}/api/canvases/${BOARD_ID}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.nodes.length, 2);
    assert.equal(body.edges.length, 1);
    assert.equal(body.nodeCount, 2);
    assert.equal(body.edgeCount, 1);
    const nodeIds = new Set(body.nodes.map((n: any) => n.id));
    for (const e of body.edges) {
      assert.ok(nodeIds.has(e.source) && nodeIds.has(e.target), `边 ${e.id} 端点必须存在`);
    }
  });

  test('列表 nodeCount/edgeCount 与归一化一致', async () => {
    const res = await fetch(`${base}/api/canvases`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const list = (await res.json()) as any[];
    const board = list.find((c) => c.id === BOARD_ID);
    assert.ok(board);
    assert.equal(board.nodeCount, 2);
    assert.equal(board.edgeCount, 1);
  });
});
