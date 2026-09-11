/**
 * K2 — 快照式只读分享（跟踪清单 B1 / 里程碑 K 组）
 *
 * 决策：一画板至多一个活跃分享（canvas_id 唯一索引，重复 POST 幂等返回同一 code）；
 * 分享内容为创建时刻的全量快照（不可变，后续画布编辑不传播）；
 * 撤销为软撤（revoked_at），画布软删后分享随之失效；
 * 公开读取无需登录，计 views_count，防枚举（base64url 随机 code）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import {
  signupRateLimiter,
  sendRegisterCodeRateLimiter,
  shareActionRateLimiter,
} from '../server/middleware/auth.js';

let server: http.Server;
let base = '';
let aliceCookie = '';
let bobCookie = '';
let adminCookie = '';

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

async function saveBoard(cookie: string, id: string, nodes: any[]): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

function createShare(cookie: string, canvasId: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${canvasId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({}),
  });
}

function revokeShare(cookie: string, canvasId: string): Promise<Response> {
  return fetch(`${base}/api/canvases/${canvasId}/share`, {
    method: 'DELETE',
    headers: { cookie },
  });
}

function getShare(code: string): Promise<Response> {
  return fetch(`${base}/api/shares/${code}`);
}

describe('K2 快照式只读分享（B1）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('k1-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('k1-bob@test.local', 'Bob123456!');

    const res = await saveBoard(aliceCookie, 'k1-alice-board', [
      { id: 'k1-n1', type: 'chat', position: { x: 0, y: 0 }, data: { question: '分享根问题', answer: '根答案', status: 'idle' } },
    ]);
    assert.equal(res.status, 200);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('未登录创建分享 → 401', async () => {
    const res = await createShare('', 'k1-alice-board');
    assert.equal(res.status, 401);
  });

  test('非属主创建分享 → 403（严格属主制）', async () => {
    const res = await createShare(bobCookie, 'k1-alice-board');
    assert.equal(res.status, 403);
  });

  test('属主创建分享 → 200，返回 shareCode 与 /share/ 链接', async () => {
    const res = await createShare(aliceCookie, 'k1-alice-board');
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(body.shareCode, '应返回 shareCode');
    assert.ok(String(body.url).includes(`/share/${body.shareCode}`), 'url 应指向 /share/:code');
  });

  test('公开读取（无 cookie）→ 200 快照内容；views_count 递增', async () => {
    const createRes = await createShare(aliceCookie, 'k1-alice-board');
    const { shareCode } = (await createRes.json()) as any;

    const r1 = await getShare(shareCode);
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as any;
    assert.equal(b1.title, 'k1-alice-board');
    assert.equal((b1.nodes || []).length, 1);
    assert.equal(b1.nodes[0].data.question, '分享根问题');

    const r2 = await getShare(shareCode);
    const b2 = (await r2.json()) as any;
    assert.equal(b2.viewCount, (b1.viewCount || 0) + 1, 'viewCount 应递增');
  });

  test('快照不可变：分享后修改画布，公开读取内容不变', async () => {
    const createRes = await createShare(aliceCookie, 'k1-alice-board');
    const { shareCode } = (await createRes.json()) as any;
    const before = (await (await getShare(shareCode)).json()) as any;

    await saveBoard(aliceCookie, 'k1-alice-board', [
      { id: 'k1-n1', type: 'chat', position: { x: 0, y: 0 }, data: { question: '分享根问题', answer: '已修改的答案', status: 'idle' } },
      { id: 'k1-n2', type: 'chat', position: { x: 100, y: 0 }, data: { question: '新节点', answer: '', status: 'idle' } },
    ]);

    const after = (await (await getShare(shareCode)).json()) as any;
    assert.equal(after.nodes.length, before.nodes.length, '快照节点数不变');
    assert.equal(after.nodes[0].data.answer, '根答案', '快照答案不变');
  });

  test('同画布重复 POST → 幂等返回同一 shareCode', async () => {
    const r1 = (await (await createShare(aliceCookie, 'k1-alice-board')).json()) as any;
    const r2 = (await (await createShare(aliceCookie, 'k1-alice-board')).json()) as any;
    assert.equal(r1.shareCode, r2.shareCode);
  });

  test('非属主撤销 → 403；属主撤销后公开读取 → 404', async () => {
    const { shareCode } = (await (await createShare(aliceCookie, 'k1-alice-board')).json()) as any;
    const forbidden = await revokeShare(bobCookie, 'k1-alice-board');
    assert.equal(forbidden.status, 403);

    const revoke = await revokeShare(aliceCookie, 'k1-alice-board');
    assert.equal(revoke.status, 200);
    const gone = await getShare(shareCode);
    assert.equal(gone.status, 404, '撤销后分享应 404');
  });

  test('画布软删后，分享链接随之失效 → 404', async () => {
    await saveBoard(aliceCookie, 'k1-doomed-board', [
      { id: 'k1-dn1', type: 'chat', position: { x: 0, y: 0 }, data: { question: '待删画布', answer: '', status: 'idle' } },
    ]);
    const { shareCode } = (await (await createShare(aliceCookie, 'k1-doomed-board')).json()) as any;
    assert.ok((await getShare(shareCode)).status === 200);

    const del = await fetch(`${base}/api/canvases/k1-doomed-board`, {
      method: 'DELETE',
      headers: { cookie: aliceCookie },
    });
    assert.equal(del.status, 200);

    const gone = await getShare(shareCode);
    assert.equal(gone.status, 404, '画布删除后分享应失效');
  });

  test('不存在的 shareCode → 404', async () => {
    const res = await getShare('no-such-code-abc');
    assert.equal(res.status, 404);
  });

  test('审计日志不落 shareCode：admin 无法据此绕过属主读取快照', async () => {
    (shareActionRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
    const createRes = await createShare(aliceCookie, 'k1-alice-board');
    assert.equal(createRes.status, 200);
    const { shareCode } = (await createRes.json()) as any;
    assert.ok(shareCode, '创建分享应返回 shareCode');

    const res = await fetch(`${base}/api/admin/audit-logs?action=share_create&page=1&limit=100`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 200, 'admin 应能读取审计日志');
    const logs = ((await res.json()) as any).logs as any[];
    assert.ok(logs.length > 0, '应有 share_create 审计记录');

    assert.ok(
      !JSON.stringify(logs).includes(shareCode),
      '审计日志任何位置都不得出现 shareCode'
    );
    for (const l of logs) {
      const details = l.details || {};
      assert.ok(!('shareCode' in details), 'details 不得含 shareCode 字段');
      assert.ok(!('share_code' in details), 'details 不得含 share_code 字段');
    }
    // 审计语义未被削弱：仍记录创建事实与重建标记，归属由 targetId 锚定
    assert.ok(
      logs.some((l) => l.target_id === 'k1-alice-board' && 'recreatedRevoked' in (l.details || {})),
      'share_create 记录应保留 targetId 与 recreatedRevoked'
    );
  });
});
