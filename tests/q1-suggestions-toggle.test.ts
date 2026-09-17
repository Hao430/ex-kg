/**
 * Spec Q1 — 灵感开关改为画板级：关闭即清理
 *
 * 覆盖两处：
 * - `collectSuggestedLeafIds`：关闭灵感时「哪些节点可删」的判据（只选未激活占位、跳过有子节点的异常态）
 * - 服务端真源：`suggestions_enabled` 经 `PATCH /api/canvases/:id/meta` 持久化（列表回读一致、
 *   默认开、严格属主制）——**绝不用 localStorage 之类的本地偏好裁决**（#0082 云优先口径）
 *
 * 不测交互（确认框/重排/toast）——那部分在 Spec Q1 的验收清单里手工走查。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { collectSuggestedLeafIds } from '../src/lib/suggestions.js';

let server: http.Server;
let base = '';
let userCookie = '';
let otherCookie = '';

const BOARD_ID = 'q1-suggestions-board';
const OTHER_BOARD_ID = 'q1-other-user-board';

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function createBoard(cookie: string, id: string): Promise<void> {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes: [], edges: [] }),
  });
  assert.equal(res.status, 200, `建板 ${id} 应成功`);
}

async function patchMeta(cookie: string, id: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/canvases/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json().catch(() => ({}))) as any };
}

async function listBoards(cookie: string): Promise<any[]> {
  const res = await fetch(`${base}/api/canvases`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as any[];
}

describe('Q1 collectSuggestedLeafIds — 关闭灵感时哪些节点可清理', () => {
  test('混合画板：只返回未激活的 suggested 占位', () => {
    const nodes = [
      { id: 'root', data: { status: 'idle' } },
      { id: 'sug-1', data: { status: 'suggested', parentId: 'root' } },
      { id: 'gen', data: { status: 'generating', parentId: 'root' } },
      { id: 'sug-2', data: { status: 'suggested', parentId: 'root' } },
      { id: 'note', type: 'note', data: { parentId: 'root' } },
      { id: 'sug-3', data: { status: 'suggested', parentId: 'root' } },
    ];
    assert.deepEqual(collectSuggestedLeafIds(nodes), ['sug-1', 'sug-2', 'sug-3']);
  });

  test('有子节点的 suggested（异常态）不返回——宁可留着也不误删用户内容', () => {
    const nodes = [
      { id: 'sug-parent', data: { status: 'suggested', parentId: 'root' } },
      { id: 'child', data: { status: 'idle', parentId: 'sug-parent' } },
      { id: 'sug-leaf', data: { status: 'suggested', parentId: 'root' } },
    ];
    assert.deepEqual(collectSuggestedLeafIds(nodes), ['sug-leaf']);
  });

  test('全为非占位 / 空画板 → 空数组', () => {
    assert.deepEqual(collectSuggestedLeafIds([{ id: 'a', data: { status: 'idle' } }]), []);
    assert.deepEqual(collectSuggestedLeafIds([]), []);
  });

  test('缺 status / 缺 data 的节点不误判', () => {
    const nodes = [
      { id: 'no-data' },
      { id: 'no-status', data: { parentId: 'root' } },
      { id: 'sug', data: { status: 'suggested' } },
    ];
    assert.deepEqual(collectSuggestedLeafIds(nodes), ['sug']);
  });

  test('结果稳定且不重复（与节点顺序一致，不依赖哈希/Map 序）', () => {
    const nodes = [
      { id: 'b', data: { status: 'suggested' } },
      { id: 'a', data: { status: 'suggested' } },
      { id: 'c', data: { status: 'suggested' } },
    ];
    const first = collectSuggestedLeafIds(nodes);
    assert.deepEqual(first, ['b', 'a', 'c']);
    assert.deepEqual(collectSuggestedLeafIds(nodes), first);
  });
});

describe('Q1 灵感开关：服务端为唯一真源（PATCH /meta 持久化）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    userCookie = await signIn('user@deepdive.ai', 'User123456!');
    otherCookie = await signIn('vip@deepdive.ai', 'Vip123456!');
    await createBoard(userCookie, BOARD_ID);
    await createBoard(otherCookie, OTHER_BOARD_ID);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('新建画板默认开启（列默认值经列表回读）', async () => {
    const board = (await listBoards(userCookie)).find((b: any) => b.id === BOARD_ID);
    assert.ok(board, '应能取到刚建的画板');
    assert.equal(board.suggestionsEnabled, true);
  });

  test('PATCH suggestionsEnabled=false → 回包与列表回读一致（服务端已持久化）', async () => {
    const { res, body } = await patchMeta(userCookie, BOARD_ID, { suggestionsEnabled: false });
    assert.equal(res.status, 200);
    assert.equal(body.canvas.suggestionsEnabled, false, '回包应带回新值');

    const board = (await listBoards(userCookie)).find((b: any) => b.id === BOARD_ID);
    assert.equal(board.suggestionsEnabled, false, '列表回读必须与服务端一致（真源）');
  });

  test('只带该字段也算合法补丁；改回 true 同样生效', async () => {
    const { res } = await patchMeta(userCookie, BOARD_ID, { suggestionsEnabled: true });
    assert.equal(res.status, 200);
    const board = (await listBoards(userCookie)).find((b: any) => b.id === BOARD_ID);
    assert.equal(board.suggestionsEnabled, true);
  });

  test('空补丁 400；他人的画板不可改（严格属主制）', async () => {
    const empty = await patchMeta(userCookie, BOARD_ID, {});
    assert.equal(empty.res.status, 400, '至少提供一个可更新字段');

    const foreign = await patchMeta(userCookie, OTHER_BOARD_ID, { suggestionsEnabled: false });
    assert.ok([403, 404].includes(foreign.res.status), `跨租户改设置应被拒，实际 ${foreign.res.status}`);
    const otherBoard = (await listBoards(otherCookie)).find((b: any) => b.id === OTHER_BOARD_ID);
    assert.equal(otherBoard.suggestionsEnabled, true, '他人设置不得被改动');
  });
});
