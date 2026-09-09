/**
 * K8 — 「我的分享」管理（2026-09-09）：按用户列出生效中的分享 + 浏览次数
 *
 * 决策锁定：
 * - GET /api/shares 仅返回本人、仅生效中（未撤销 + 画布未软删）的分享；admin 同样只看自己
 * - 列表读取不递增 views_count（与公开读取端口径区分）
 * - 每行含画布现名（JOIN canvases.title）、url、浏览次数、分享时间；不含快照大对象
 * - 刷新快照（重复 POST）幂等：code 不变、views_count 保留
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

async function saveBoard(cookie: string, id: string, title = id): Promise<void> {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title, nodes: [], edges: [] }),
  });
  assert.equal(res.status, 200, `saveBoard ${id} 应成功`);
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

async function listMyShares(cookie: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/shares`, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('K8 我的分享管理', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    aliceCookie = await signIn('user@deepdive.ai', 'User123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('k8-bob@test.local', 'Bob123456!', 'Bob');
    bobCookie = await signIn('k8-bob@test.local', 'Bob123456!');

    // alice 两块画板 + 各自分享；bob 一块无分享画板
    await saveBoard(aliceCookie, 'k8-board-a', '甲画板');
    await saveBoard(aliceCookie, 'k8-board-b', '乙画板');
    await saveBoard(bobCookie, 'k8-bob-board');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('未登录 GET /api/shares → 401', async () => {
    const res = await fetch(`${base}/api/shares`);
    assert.equal(res.status, 401);
  });

  test('属主列表：两画板各分享 → 2 行，字段齐全', async () => {
    await createShare(aliceCookie, 'k8-board-a');
    await createShare(aliceCookie, 'k8-board-b');

    const { status, body } = await listMyShares(aliceCookie);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.shares));
    assert.equal(body.shares.length, 2);

    const rowA = body.shares.find((s: any) => s.canvasId === 'k8-board-a');
    assert.ok(rowA, '应含 k8-board-a');
    assert.equal(rowA.canvasTitle, '甲画板', '画板名应为画布现名');
    assert.ok(rowA.shareCode, '应含 shareCode');
    assert.ok(String(rowA.url).includes(`/share/${rowA.shareCode}`), 'url 应指向 /share/:code');
    assert.equal(rowA.viewsCount, 0, '初始浏览次数为 0');
    assert.ok(rowA.createdAt, '应含分享时间');

    // 快照大对象不得透出
    assert.equal(rowA.nodes, undefined, '列表行不应含 nodes');
    assert.equal(rowA.edges, undefined, '列表行不应含 edges');
  });

  test('属主隔离：bob 列表为空，不含 alice 的分享', async () => {
    const { status, body } = await listMyShares(bobCookie);
    assert.equal(status, 200);
    assert.equal(body.shares.length, 0);
  });

  test('仅生效中：撤销其一 → 列表只剩 1 行', async () => {
    assert.equal((await revokeShare(aliceCookie, 'k8-board-b')).status, 200);
    const { body } = await listMyShares(aliceCookie);
    assert.equal(body.shares.length, 1);
    assert.equal(body.shares[0].canvasId, 'k8-board-a');
    assert.ok(!body.shares.some((s: any) => s.canvasId === 'k8-board-b'), '已撤销分享不得出现');
  });

  test('撤销后重建 → 行重现且为新 code', async () => {
    const before = (await (await listMyShares(aliceCookie)).body).shares as any[];
    const oldCode = before.find((s) => s.canvasId === 'k8-board-b')?.shareCode;

    const createRes = await createShare(aliceCookie, 'k8-board-b');
    assert.equal(createRes.status, 200);
    const { recreated, shareCode } = (await createRes.json()) as any;
    assert.equal(recreated, true, '撤销态重建应标记 recreated');
    assert.notEqual(shareCode, oldCode, '重建应换新 code');

    const { body } = await listMyShares(aliceCookie);
    assert.equal(body.shares.length, 2, '重建后行重现');
    const row = body.shares.find((s: any) => s.canvasId === 'k8-board-b');
    assert.equal(row.shareCode, shareCode);
  });

  test('浏览次数：公开读取两次 → 列表 viewsCount=2；列表读取自身不计数', async () => {
    const { shareCode } = (await (await createShare(aliceCookie, 'k8-board-a')).json()) as any;

    await getShare(shareCode);
    await getShare(shareCode);

    const first = await listMyShares(aliceCookie);
    const row1 = first.body.shares.find((s: any) => s.canvasId === 'k8-board-a');
    assert.equal(row1.viewsCount, 2, '列表应读到累计浏览次数');

    const second = await listMyShares(aliceCookie);
    const row2 = second.body.shares.find((s: any) => s.canvasId === 'k8-board-a');
    assert.equal(row2.viewsCount, 2, '列表读取自身不得递增浏览次数');
  });

  test('刷新快照幂等：重复 POST → code 不变、viewsCount 保留', async () => {
    await createShare(aliceCookie, 'k8-board-a');
    const before = (await (await listMyShares(aliceCookie)).body).shares.find(
      (s: any) => s.canvasId === 'k8-board-a'
    );

    await createShare(aliceCookie, 'k8-board-a');

    const after = (await (await listMyShares(aliceCookie)).body).shares.find(
      (s: any) => s.canvasId === 'k8-board-a'
    );
    assert.equal(after.shareCode, before.shareCode, '活跃分享刷新应复用原 code');
    assert.equal(after.viewsCount, before.viewsCount, '刷新不得清零浏览次数');
  });

  test('画布软删后 → 行从列表消失', async () => {
    await saveBoard(aliceCookie, 'k8-doomed-board', '待删画板');
    await createShare(aliceCookie, 'k8-doomed-board');
    let body = (await (await listMyShares(aliceCookie)).body);
    assert.ok(body.shares.some((s: any) => s.canvasId === 'k8-doomed-board'), '删除前应在列表');

    const del = await fetch(`${base}/api/canvases/k8-doomed-board`, {
      method: 'DELETE',
      headers: { cookie: aliceCookie },
    });
    assert.equal(del.status, 200);

    body = (await (await listMyShares(aliceCookie)).body);
    assert.ok(!body.shares.some((s: any) => s.canvasId === 'k8-doomed-board'), '软删后行应消失');
  });

  test('admin 分享 default-board → 出现在 admin 自己列表（admin 只看自己）', async () => {
    await saveBoard(adminCookie, 'default-board', '全局默认板');
    await createShare(adminCookie, 'default-board');

    const adminList = (await (await listMyShares(adminCookie)).body).shares;
    const row = adminList.find((s: any) => s.canvasId === 'default-board');
    assert.ok(row, 'admin 列表应含 default-board（属主是 admin）');
    assert.equal(row.canvasTitle, '全局默认板');

    // alice 的列表不受影响（不出现 admin 的分享）
    const aliceList = (await (await listMyShares(aliceCookie)).body).shares;
    assert.ok(!aliceList.some((s: any) => s.canvasId === 'default-board'));
  });
});
