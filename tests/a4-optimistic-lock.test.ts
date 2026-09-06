/**
 * Spec A4 — 画布保存乐观锁冲突检测
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

let server: http.Server;
let base = '';
let cookie = '';

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

async function saveCanvas(body: Record<string, unknown>) {
  return fetch(`${base}/api/canvases/a4-lock/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id: 'a4-lock', title: 'A4 乐观锁', nodes: [], edges: [], ...body }),
  });
}

describe('A4 乐观锁冲突检测', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(res.status, 200);
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('新建画布（不带 expectedUpdatedAt）→ 200 并返回 updatedAt', async () => {
    const res = await saveCanvas({});
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.canvas.updatedAt);
  });

  test('携带正确的 expectedUpdatedAt → 200', async () => {
    const first = await (await saveCanvas({})).json() as any;
    const res = await saveCanvas({ expectedUpdatedAt: first.canvas.updatedAt });
    assert.equal(res.status, 200);
  });

  test('携带过期的 expectedUpdatedAt → 409 CANVAS_SAVE_CONFLICT 且不覆盖', async () => {
    const first = await (await saveCanvas({})).json() as any;
    const stale = first.canvas.updatedAt;

    // 另一次保存推进版本（模拟另一标签页先保存）
    await saveCanvas({ expectedUpdatedAt: stale });

    // 后保存方用过期版本 → 409
    const res = await saveCanvas({ expectedUpdatedAt: stale });
    assert.equal(res.status, 409);
    const body = await res.json() as any;
    assert.equal(body.code, 'CANVAS_SAVE_CONFLICT');
    assert.ok(body.latest_updated_at);
    assert.notEqual(body.latest_updated_at, stale);
  });

  test('画布不存在时携带任意 expectedUpdatedAt → 正常新建', async () => {
    const res = await fetch(`${base}/api/canvases/a4-new/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        id: 'a4-new', title: '新画布', nodes: [], edges: [],
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(res.status, 200);
  });

  test('不携带 expectedUpdatedAt → 200（旧客户端兼容）', async () => {
    const res = await saveCanvas({});
    assert.equal(res.status, 200);
  });
});
