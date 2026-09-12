/**
 * S6（PG 真库）— 画布墓碑 GC（ADR-0017 阶段 6）
 *
 * 为什么必须真库：GC 全是 SQL 语义——保留期由 `NOW() - make_interval(days => $1)` 判定、
 * 「先删边再删节点」的执行顺序、以及 partial 索引下的删除范围。内存分支是显式空操作
 * （墓碑随进程消亡），证明不了上面任何一条。
 *
 * 运行方式（不进默认套件）：
 *   docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *   PG_SMOKE=1 npx tsx --test tests/pg/s6-tombstone-gc.pg.test.ts
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

const { createApp } = await import('../../server/app.js');
const { getPool } = await import('../../server/core/pool.js');
const { cleanupCanvasTombstones } = await import('../../server/repositories/canvas.repository.js');

let server: http.Server;
let base = '';
let cookie = '';

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

function node(id: string, question: string): any {
  return {
    id,
    type: 'chat',
    position: { x: 0, y: 0 },
    data: { question, answer: `答-${question}`, parentId: null, status: 'idle' },
  };
}

function edge(id: string, source: string, target: string): any {
  return { id, source, target, type: 'smoothstep' };
}

async function save(id: string, body: Record<string, any>) {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, protocolVersion: 2, nodes: [], edges: [], ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function row(sql: string, params: any[]): Promise<any[]> {
  const p = getPool()!;
  const res = await p.query(sql, params);
  return res.rows;
}

/** 把某画布的墓碑行「变老」n 天：GC 的判据是 deleted_at，只能直接改库 */
async function backdate(canvasId: string, days: number): Promise<void> {
  const p = getPool()!;
  await p.query(
    `UPDATE nodes SET deleted_at = NOW() - make_interval(days => $2) WHERE canvas_id = $1 AND deleted_at IS NOT NULL`,
    [canvasId, days]
  );
  await p.query(
    `UPDATE edges SET deleted_at = NOW() - make_interval(days => $2) WHERE canvas_id = $1 AND deleted_at IS NOT NULL`,
    [canvasId, days]
  );
}

describe('S6 PG 真库：墓碑 GC', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitPgReady();
    cookie = await signIn('admin@deepdive.ai', 'Admin123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  t('过期墓碑被物理回收，未过期的墓碑与存活行一个不动', async () => {
    const id = 's6pg-gc-expired';
    assert.equal((await save(id, { nodes: [node('g1', '甲'), node('g2', '乙'), node('g3', '丙')], edges: [edge('ge1', 'g1', 'g2'), edge('ge2', 'g2', 'g3')] })).status, 200);
    // 删 g2：节点墓碑 + 级联边墓碑（g1-g2、g2-g3）
    assert.equal((await save(id, { deletedNodeIds: ['g2'] })).status, 200);

    const deadBefore = await row(
      `SELECT (SELECT COUNT(*)::int FROM nodes WHERE canvas_id = $1 AND deleted_at IS NOT NULL) AS n,
              (SELECT COUNT(*)::int FROM edges WHERE canvas_id = $1 AND deleted_at IS NOT NULL) AS e`,
      [id]
    );
    assert.deepEqual(deadBefore[0], { n: 1, e: 2 }, '前提：删除留下 1 个节点墓碑 + 2 个边墓碑');

    await backdate(id, 40); // 墓碑「已过期」（保留期 30 天）
    const freed = await cleanupCanvasTombstones(30);
    assert.ok(freed.nodes >= 1 && freed.edges >= 2, `应回收本画布的墓碑（实际 ${JSON.stringify(freed)}）`);

    const after = await row(
      `SELECT (SELECT COUNT(*)::int FROM nodes WHERE canvas_id = $1 AND deleted_at IS NOT NULL) AS n,
              (SELECT COUNT(*)::int FROM edges WHERE canvas_id = $1 AND deleted_at IS NOT NULL) AS e`,
      [id]
    );
    assert.deepEqual(after[0], { n: 0, e: 0 }, '过期墓碑必须被物理删掉（否则无限累积）');

    const live = await row(
      `SELECT (SELECT COUNT(*)::int FROM nodes WHERE canvas_id = $1 AND deleted_at IS NULL) AS n,
              (SELECT COUNT(*)::int FROM edges WHERE canvas_id = $1 AND deleted_at IS NULL) AS e`,
      [id]
    );
    assert.deepEqual(live[0], { n: 2, e: 0 }, '存活节点不受影响（连到 g2 的边已随 g2 一起墓碑）');
  });

  t('保留期内的新墓碑不回收：否则挂机设备会把刚删的内容复活', async () => {
    const id = 's6pg-gc-fresh';
    assert.equal((await save(id, { nodes: [node('f1', '甲'), node('f2', '乙')] })).status, 200);
    assert.equal((await save(id, { deletedNodeIds: ['f2'] })).status, 200);

    // 保留期 30 天，刚删的墓碑只有几毫秒龄 → 必须留着
    await cleanupCanvasTombstones(30);
    const fresh = await row(
      `SELECT COUNT(*)::int AS n FROM nodes WHERE canvas_id = $1 AND deleted_at IS NOT NULL`,
      [id]
    );
    assert.equal(fresh[0].n, 1, '新墓碑必须保留：它就是「删除胜出」的载体');

    // 同一个墓碑一旦过期就回收，且只有它是被回收的那批
    await backdate(id, 31);
    await cleanupCanvasTombstones(30);
    const gone = await row(
      `SELECT COUNT(*)::int AS n FROM nodes WHERE canvas_id = $1 AND deleted_at IS NOT NULL`,
      [id]
    );
    assert.equal(gone[0].n, 0);
  });

  t('回收墓碑后，陈旧设备重传同一节点 id 不再是「被拒绝的复活」而是真正重建（接受的风险边界）', async () => {
    const id = 's6pg-gc-revive';
    assert.equal((await save(id, { nodes: [node('r1', '甲'), node('r2', '乙')] })).status, 200);
    assert.equal((await save(id, { deletedNodeIds: ['r2'] })).status, 200);

    // 墓碑还在 → 陈旧设备重传被守卫拒绝（删除胜出）
    const guarded = await save(id, { nodes: [node('r2', '乙')] });
    assert.equal(guarded.status, 200);
    assert.deepEqual(guarded.body.canvas.ignoredNodeIds, ['r2'], '删除胜出：墓碑行不得复活');

    // 墓碑被 GC 之后，同一个 id 会被当作新节点插入（节点 id 由客户端生成、不可能与他人复用）
    await backdate(id, 40);
    await cleanupCanvasTombstones(30);
    const afterGc = await save(id, { nodes: [node('r2', '乙')] });
    assert.equal(afterGc.status, 200);
    assert.deepEqual(afterGc.body.canvas.ignoredNodeIds, [], '墓碑没了就没有守卫，节点被重建');
  });
});
