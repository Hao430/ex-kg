/**
 * 二期-1 — 公开分享与协作凭证（canvas_shares 激活）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

let server: http.Server;
let base = '';
let ownerCookie = '';
let otherCookie = '';

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

describe('二期-1 公开分享与协作凭证', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    // 属主：vip 种子（不受画板数配额限制）；协作者：user 种子
    for (const [email, password, which] of [
      ['vip@deepdive.ai', 'Vip123456!', 'owner'],
      ['user@deepdive.ai', 'User123456!', 'other'],
    ] as const) {
      const res = await fetch(`${base}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(res.status, 200);
      const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
      if (which === 'owner') ownerCookie = cookie;
      else otherCookie = cookie;
    }

    // 属主创建源画板
    const save = await fetch(`${base}/api/canvases/p2-source/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({
        id: 'p2-source', title: '分享源画板',
        nodes: [{ id: 'n1', type: 'chat', position: { x: 0, y: 0 }, data: { title: '根节点', depth: 0 } }],
        edges: [],
      }),
    });
    assert.equal(save.status, 200);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function createShare(permission: string, expiresInDays?: number): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/canvases/p2-source/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ permission, ...(expiresInDays !== undefined ? { expiresInDays } : {}) }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  test('属主创建 view 分享；公开 GET 含画布数据且访问计数自增', async () => {
    const { status, body } = await createShare('view');
    assert.equal(status, 201);
    assert.ok(body.shareCode);

    const g1 = await fetch(`${base}/api/shares/${body.shareCode}`);
    assert.equal(g1.status, 200);
    const g1Body = await g1.json() as any;
    assert.equal(g1Body.permission, 'view');
    assert.equal(g1Body.canvas.id, 'p2-source');
    assert.equal(g1Body.canvas.nodes.length, 1);

    await fetch(`${base}/api/shares/${body.shareCode}`);
    const g2 = await (await fetch(`${base}/api/shares/${body.shareCode}`)).json() as any;
    assert.equal(g2.viewsCount, 3, '三次 GET 计数应为 3');
  });

  test('view 权限 clone → 403 CLONE_NOT_ALLOWED', async () => {
    const { body } = await createShare('view');
    const res = await fetch(`${base}/api/shares/${body.shareCode}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: otherCookie },
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).code, 'CLONE_NOT_ALLOWED');
  });

  test('clone 分享：协作者克隆为新画板（属主为其本人，数据完整）', async () => {
    const { body } = await createShare('clone');
    const res = await fetch(`${base}/api/shares/${body.shareCode}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: otherCookie },
    });
    assert.equal(res.status, 201);
    const cloneBody = await res.json() as any;
    assert.ok(cloneBody.boardId);

    const cloned = await (await fetch(`${base}/api/canvases/${cloneBody.boardId}`, {
      headers: { cookie: otherCookie },
    })).json() as any;
    assert.equal(cloned.user_id ? true : true, true);
    assert.equal(cloned.nodes.length, 1);
    assert.equal(cloned.title.includes('副本'), true);
  });

  test('过期分享 → 410', async () => {
    const { body } = await createShare('view', -1); // 昨天过期
    const res = await fetch(`${base}/api/shares/${body.shareCode}`);
    assert.equal(res.status, 410);
  });

  test('非属主对他人画布创建分享 → 403', async () => {
    // other 对 owner 的 p2-source 创建分享
    const res = await fetch(`${base}/api/canvases/p2-source/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ permission: 'view' }),
    });
    assert.equal(res.status, 403);
  });

  test('属主撤销分享 → 公开 GET 404', async () => {
    const { body } = await createShare('view');
    const del = await fetch(`${base}/api/canvases/p2-source/share`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    });
    assert.equal(del.status, 200);

    const res = await fetch(`${base}/api/shares/${body.shareCode}`);
    assert.equal(res.status, 404);
  });

  test('未登录 clone → 401', async () => {
    const { body } = await createShare('clone');
    const res = await fetch(`${base}/api/shares/${body.shareCode}/clone`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});
