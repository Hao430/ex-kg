/**
 * Spec Q1 真库 — 画板级灵感开关（`canvases.suggestions_enabled`）。
 *
 * 内存套件测不到的东西在这里钉死：
 * - 列名 `suggestions_enabled` 拼写正确（写错 → handlePgError → 静默落内存，只有真库能发现）
 * - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 在既有的 canvases 表上落列成功（部署期迁移路径）
 * - PATCH /meta 的 COALESCE 分支在真库上生效，且列表回读与服务端一致（服务端唯一真源）
 *
 * 运行：docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *       PG_SMOKE=1 npx tsx --test --test-concurrency=1 tests/pg/q1-suggestions-flag.pg.test.ts（必须空库）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
process.env.APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

// 动态 import：静态导入会被提升到 process.env.DATABASE_URL 赋值之前
const { initDbSchema } = await import('../../server/core/schema.js');
const { createApp } = await import('../../server/app.js');

let server: http.Server;
let base = '';
let userCookie = '';
const BOARD_ID = 'p-pg-q1-suggestions-board';

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function boardFromList(): Promise<any> {
  const res = await fetch(`${base}/api/canvases`, { headers: { cookie: userCookie } });
  assert.equal(res.status, 200);
  const list = (await res.json()) as any[];
  return list.find((b: any) => b.id === BOARD_ID);
}

describe('Q1 PG 画板级灵感开关', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await initDbSchema();
    await waitPgReady();
    userCookie = await signIn('user@deepdive.ai', 'User123456!');

    const save = await fetch(`${base}/api/canvases/${BOARD_ID}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ id: BOARD_ID, title: BOARD_ID, nodes: [], edges: [] }),
    });
    assert.equal(save.status, 200, '真库建板应成功');
  });
  after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  t('真库列存在且默认 TRUE（列名拼写正确，未静默落内存）', async () => {
    const board = await boardFromList();
    assert.ok(board, '列表应能取到该板');
    assert.equal(board.suggestionsEnabled, true, '列默认值应为 TRUE；若为 undefined 说明 SQL 列名拼写错误已静默降级');
  });

  t('PATCH suggestionsEnabled=false 在真库持久化（COALESCE 分支生效）', async () => {
    const res = await fetch(`${base}/api/canvases/${BOARD_ID}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ suggestionsEnabled: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.canvas.suggestionsEnabled, false);

    const board = await boardFromList();
    assert.equal(board.suggestionsEnabled, false, '列表回读必须与写入一致（服务端唯一真源）');

    // 改回 TRUE：证明 COALESCE($7, ...) 不是单向的
    const back = await fetch(`${base}/api/canvases/${BOARD_ID}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ suggestionsEnabled: true }),
    });
    assert.equal(back.status, 200);
    assert.equal((await boardFromList()).suggestionsEnabled, true);
  });
});
