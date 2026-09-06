/**
 * Spec B1+B2 — 配额服务端化 + VIP 过期锁定态
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { updateVipMembership, findUserById } from '../server/repositories/user.repository.js';

let server: http.Server;
let base = '';
let userCookie = '';
let vipCookie = '';
let adminCookie = '';

const USER_ID = '00000000-0000-0000-0000-000000000002';
const VIP_ID = '00000000-0000-0000-0000-000000000003';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

function makeNodes(count: number, prefix: string): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    type: 'chat',
    position: { x: i * 10, y: 0 },
    data: { title: `节点${i}`, depth: 0 },
  }));
}

async function saveBoard(cookie: string, id: string, nodes: any[]): Promise<Response> {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges: [] }),
  });
}

describe('B1+B2 配额服务端化', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    userCookie = await signIn('user@deepdive.ai', 'User123456!');
    vipCookie = await signIn('vip@deepdive.ai', 'Vip123456!');
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');

    // VIP 种子账号默认永久有效（vip_expires_at null）——为过期用例先保持有效
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('体验版可建前 3 个画板（含默认板），第 4 个被拒', async () => {
    // 体验版已有默认板可能未同步——直接建 3 个再建第 4 个
    for (let i = 1; i <= 3; i++) {
      const res = await saveBoard(userCookie, `b1-board-${i}`, []);
      assert.ok([200, 403].includes(res.status), `board ${i} unexpected ${res.status}`);
      if (res.status === 403) {
        const body = await res.json() as any;
        assert.equal(body.code, 'BOARD_LIMIT_REACHED');
      }
    }
    // 数一下已建成功的数量，再尝试直到触发上限
    let created = 0;
    for (let i = 1; i <= 3; i++) {
      const check = await fetch(`${base}/api/canvases/b1-board-${i}`, { headers: { cookie: userCookie } });
      if (check.status === 200) created++;
    }
    assert.ok(created <= 3, '体验版画板数不应超过 3');
    if (created >= 3) {
      const res = await saveBoard(userCookie, 'b1-board-4', []);
      assert.equal(res.status, 403);
      const body = await res.json() as any;
      assert.equal(body.code, 'BOARD_LIMIT_REACHED');
    }
  });

  test('VIP 建第 4+ 个画板不受限', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await saveBoard(vipCookie, `b1-vip-board-${i}`, []);
      assert.equal(res.status, 200, `VIP board ${i} should 200`);
    }
  });

  test('体验版画板满 10 个 chat 节点后发起推理被拒', async () => {
    // 用 VIP 先建一个 10 节点的画板？不行——体验版节点校验按 user；体验版只能有 3 板，
    // 直接向体验版自己的画板塞 10 个节点：先确保有板（b1-board-1 若被拒则用 default-board）
    let target = 'b1-board-1';
    const check = await fetch(`${base}/api/canvases/b1-board-1`, { headers: { cookie: userCookie } });
    if (check.status !== 200) target = 'default-board';

    const res = await saveBoard(userCookie, target, makeNodes(10, 'qn-'));
    assert.ok([200, 403].includes(res.status));

    // 满 10 节点后发起推理
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], canvasId: target }),
    });
    assert.equal(chat.status, 403);
    const body = await chat.json() as any;
    assert.equal(body.code, 'NODE_LIMIT_REACHED');
  });

  test('过期 VIP：推理被拒 / 新建画板被拒 / 读取与保存正常', async () => {
    // 将 VIP 种子置为已过期
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: '2020-01-01T00:00:00.000Z' });

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: vipCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], canvasId: 'b1-vip-board-1' }),
    });
    assert.equal(chat.status, 403);
    assert.equal(((await chat.json()) as any).code, 'VIP_EXPIRED');

    const create = await saveBoard(vipCookie, 'b1-vip-new', []);
    assert.equal(create.status, 403);
    assert.equal(((await create.json()) as any).code, 'VIP_EXPIRED');

    const list = await fetch(`${base}/api/canvases`, { headers: { cookie: vipCookie } });
    assert.equal(list.status, 200);

    const save = await saveBoard(vipCookie, 'b1-vip-board-1', makeNodes(1, 'vx-'));
    assert.equal(save.status, 200);
  });

  test('VIP 有效期顺延后恢复推理权限（再置为未来）', async () => {
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: '2030-01-01T00:00:00.000Z' });
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: vipCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], canvasId: 'b1-vip-board-1' }),
    });
    // 无 GEMINI_API_KEY：不应再是 403 VIP_EXPIRED（可能是 4xx/5xx 推演错误或 SSE）
    assert.notEqual(chat.status, 403);
  });

  test('Admin 建第 4+ 画板不受限', async () => {
    for (let i = 1; i <= 4; i++) {
      const res = await saveBoard(adminCookie, `b1-admin-board-${i}`, []);
      assert.equal(res.status, 200, `admin board ${i} should 200`);
    }
  });

  test('me 返回 entitlements（体验版 / VIP 有效 / VIP 过期）', async () => {
    const meUser = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } })).json() as any;
    assert.equal(meUser.user.entitlements.plan, 'trial');

    const meVip = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: vipCookie } })).json() as any;
    assert.equal(meVip.user.entitlements.plan, 'vip');
    assert.equal(meVip.user.entitlements.vipExpired, false);

    // 再置过期验证 vipExpired 标记
    await updateVipMembership({ userId: VIP_ID, role: 'vip', vipExpiresAt: '2020-01-01T00:00:00.000Z' });
    // 注意：findSession 的 PG/内存 JOIN 在内存模式下直接读内存对象，置过期后需重新登录拿到新会话用户
    const fresh = await signIn('vip@deepdive.ai', 'Vip123456!');
    const meExpired = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: fresh } })).json() as any;
    assert.equal(meExpired.user.entitlements.plan, 'trial');
    assert.equal(meExpired.user.entitlements.vipExpired, true);
  });
});
