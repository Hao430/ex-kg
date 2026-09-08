/**
 * Spec I — 业务事件埋点（event_logs）
 *
 * 断言点：
 * - 409 保存冲突 → event_logs 记录 canvas_save_conflict（category/entity/user 归因）
 * - 体验版画板配额拦截（BOARD_LIMIT_REACHED）→ event_logs 记录 board_limit_reached
 * - GET /api/admin/event-logs：admin 200 + 分页；普通用户 403
 * - GET /api/admin/ai-logs：admin 200（空列表也 200）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { getEventLogsForTest } from '../server/repositories/event-log.repository.js';

let server: http.Server;
let base = '';
let adminCookie = '';
let userCookie = '';
let userId = '';

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

async function saveCanvas(cookie: string, id: string, body: Record<string, unknown> = {}) {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes: [], edges: [], ...body }),
  });
}

describe('I1 业务事件埋点', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    const admin = await signIn('admin@deepdive.ai', 'Admin123456!');
    adminCookie = admin.cookie;
    const user = await signIn('user@deepdive.ai', 'User123456!');
    userCookie = user.cookie;
    userId = user.id;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('409 保存冲突 → event_logs 记录 canvas_save_conflict 且归因齐全', async () => {
    const first = await (await saveCanvas(userCookie, 'i1-conflict')).json() as any;
    assert.ok(first.canvas.updatedAt);

    // 推进版本（模拟另一标签页先保存）
    await saveCanvas(userCookie, 'i1-conflict', { expectedUpdatedAt: first.canvas.updatedAt });

    // 过期版本 → 409
    const res = await saveCanvas(userCookie, 'i1-conflict', { expectedUpdatedAt: first.canvas.updatedAt });
    assert.equal(res.status, 409);

    const ev = getEventLogsForTest().find((e) => e.event === 'canvas_save_conflict');
    assert.ok(ev, '应记录 canvas_save_conflict 事件');
    assert.equal(ev.category, 'canvas');
    assert.equal(ev.entity_id, 'i1-conflict');
    assert.equal(ev.user_id, userId);
  });

  test('画板配额拦截 → event_logs 记录 board_limit_reached', async () => {
    // 体验版 BOARD_LIMIT=3：i1-conflict 已占 1 块，补满 3 块后第 4 块 → 403
    await saveCanvas(userCookie, 'i1-b2');
    await saveCanvas(userCookie, 'i1-b3');
    const res = await saveCanvas(userCookie, 'i1-b4');
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.equal(body.code, 'BOARD_LIMIT_REACHED');

    const ev = getEventLogsForTest().find((e) => e.event === 'board_limit_reached');
    assert.ok(ev, '应记录 board_limit_reached 事件');
    assert.equal(ev.category, 'quota');
    assert.equal(ev.entity_id, 'i1-b4');
    assert.equal(ev.user_id, userId);
  });

  test('admin 拉取 /api/admin/event-logs → 200 分页；普通用户 403', async () => {
    const ok = await fetch(`${base}/api/admin/event-logs?page=1&limit=10`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.ok(body.total >= 2, '前两个用例应已落至少 2 条事件');
    assert.ok(Array.isArray(body.logs));

    const forbidden = await fetch(`${base}/api/admin/event-logs`, {
      headers: { cookie: userCookie },
    });
    assert.equal(forbidden.status, 403);
  });

  test('admin 拉取 /api/admin/ai-logs → 200（空列表也 200）', async () => {
    const ok = await fetch(`${base}/api/admin/ai-logs`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.ok(Array.isArray(body.logs));
  });
});
