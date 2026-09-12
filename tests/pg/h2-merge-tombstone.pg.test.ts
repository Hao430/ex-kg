/**
 * H2（PG 真库）— 节点级合并写入的 SQL 层验证（ADR-0017）
 *
 * 为什么必须单独跑真库：内存分支走的是数组过滤，**证明不了**下面这几件事——
 * - `ON CONFLICT (id) DO UPDATE ... WHERE nodes.deleted_at IS NULL` 真的会拒绝墓碑行复活，
 *   且被拒绝的行**不出现在 RETURNING 里**（ignoredNodeIds 就是靠这个算出来的）
 * - `rev = nodes.rev + 1` 在行锁下真的严格递增（节点级定序的唯一判据）
 * - 级联墓碑、partial 索引下的读路径过滤、计数重算子查询
 * 内存分支全绿不代表真库绿。
 *
 * 运行方式（不进默认套件）：
 *   docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *   PG_SMOKE=1 npx tsx --test tests/pg/h2-merge-tombstone.pg.test.ts
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

// 建表必须显式调用（ADR-0019：懒迁移已从仓储摘除，生产改由部署期 migrate 步骤）。
// 用动态 import：静态导入会被提升到 process.env.DATABASE_URL 赋值之前。
const { initDbSchema } = await import('../../server/core/schema.js');
const { createApp } = await import('../../server/app.js');
const { getSystemPool } = await import('../../server/core/pool.js');

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

function node(id: string, question: string, parentId: string | null = null): any {
  return {
    id,
    type: 'chat',
    position: { x: 0, y: 0 },
    data: { question, answer: `答-${question}`, parentId, status: 'idle' },
  };
}

function edge(id: string, source: string, target: string): any {
  return { id, source, target, type: 'smoothstep' };
}

async function mergeSave(id: string, body: Record<string, any>) {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, protocolVersion: 2, nodes: [], edges: [], ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function legacySave(id: string, nodes: any[], edges: any[] = []) {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title: id, nodes, edges }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getCanvas(id: string): Promise<any> {
  const res = await fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
  assert.equal(res.status, 200, `getCanvas ${id} 应 200`);
  return res.json();
}

/** 直查行：rev / deleted_at 不经 API 暴露，只能从库里看 */
async function row(sql: string, params: any[]): Promise<any[]> {
  const p = getSystemPool()!;
  const res = await p.query(sql, params);
  return res.rows;
}

const nodeIds = (c: any): string[] => c.nodes.map((n: any) => n.id).sort();
const edgeIds = (c: any): string[] => c.edges.map((e: any) => e.id).sort();

describe('H2 PG 真库：合并写入与墓碑', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await initDbSchema();
    await waitPgReady();
    cookie = await signIn('admin@deepdive.ai', 'Admin123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  t('schema 补列到位：nodes.rev / edges.rev / edges.deleted_at / edges.updated_at', async () => {
    const cols = await row(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'nodes' AND column_name = 'rev')
          OR (table_name = 'edges' AND column_name IN ('rev', 'deleted_at', 'updated_at'))`,
      []
    );
    const got = cols.map((c) => `${c.table_name}.${c.column_name}`).sort();
    assert.deepEqual(got, ['edges.deleted_at', 'edges.rev', 'edges.updated_at', 'nodes.rev']);
  });

  t('两设备各改不同节点，同一个过期基线，两边改动都在', async () => {
    const id = 'h2pg-two-devices';
    const seeded = await legacySave(id, [node('pg1', '原始1'), node('pg2', '原始2')]);
    assert.equal(seeded.status, 200);
    const stale = seeded.body.canvas.updatedAt;

    assert.equal((await mergeSave(id, { nodes: [node('pg1', 'A改')], expectedUpdatedAt: stale })).status, 200);
    assert.equal((await mergeSave(id, { nodes: [node('pg2', 'B改')], expectedUpdatedAt: stale })).status, 200);

    const final = await getCanvas(id);
    assert.deepEqual(nodeIds(final), ['pg1', 'pg2']);
    assert.equal(final.nodes.find((n: any) => n.id === 'pg1').data.question, 'A改');
    assert.equal(final.nodes.find((n: any) => n.id === 'pg2').data.question, 'B改');
  });

  t('节点 upsert 不动未提交的列（width/is_pinned/tokens_used/created_at 保留）', async () => {
    const id = 'h2pg-preserve-columns';
    await legacySave(id, [node('pgp1', '甲')]);
    const before = (await row('SELECT width, is_pinned, tokens_used, created_at FROM nodes WHERE id = $1', ['pgp1']))[0];

    // 合并语义下这些列不在前端可编辑字段里，必须原样保留（旧整板替换会全部重置为 DEFAULT）
    await mergeSave(id, { nodes: [node('pgp1', '乙')] });
    const after = (await row('SELECT width, is_pinned, tokens_used, created_at FROM nodes WHERE id = $1', ['pgp1']))[0];

    assert.equal(after.width, before.width);
    assert.equal(after.is_pinned, before.is_pinned);
    assert.equal(after.tokens_used, before.tokens_used);
    assert.equal(new Date(after.created_at).getTime(), new Date(before.created_at).getTime());
  });

  t('rev 行级严格递增（节点级定序的唯一判据）', async () => {
    const id = 'h2pg-rev';
    await legacySave(id, [node('pgr1', 'v0')]);
    const rev0 = (await row('SELECT rev FROM nodes WHERE id = $1', ['pgr1']))[0].rev;

    await mergeSave(id, { nodes: [node('pgr1', 'v1')] });
    const rev1 = (await row('SELECT rev FROM nodes WHERE id = $1', ['pgr1']))[0].rev;
    await mergeSave(id, { nodes: [node('pgr1', 'v2')] });
    const rev2 = (await row('SELECT rev FROM nodes WHERE id = $1', ['pgr1']))[0].rev;

    assert.ok(rev1 > rev0, `rev 应递增：${rev0} → ${rev1}`);
    assert.ok(rev2 > rev1, `rev 应递增：${rev1} → ${rev2}`);
    // 不能用 updated_at 定序：NOW() 是事务开始时间，同事务内所有行共享同一值
    assert.equal(rev1 - rev0, 1);
  });

  t('墓碑守卫：ON CONFLICT 的 WHERE 拒绝复活，且被拒行不出现在 RETURNING 里', async () => {
    const id = 'h2pg-tombstone';
    await legacySave(id, [node('pgt1', '根'), node('pgt2', '将删', 'pgt1')]);

    const del = await mergeSave(id, { deletedNodeIds: ['pgt2'] });
    assert.equal(del.status, 200);
    const tomb = (await row('SELECT deleted_at FROM nodes WHERE id = $1', ['pgt2']))[0];
    assert.ok(tomb.deleted_at, '节点必须是软删（墓碑），不是物理删除');

    const stale = await mergeSave(id, { nodes: [node('pgt2', '旧设备推的')] });
    assert.equal(stale.status, 200);
    assert.deepEqual(
      stale.body.canvas.ignoredNodeIds,
      ['pgt2'],
      'RETURNING id 未返回 ⇒ 守卫命中 ⇒ ignoredNodeIds 必须报出'
    );

    const after = (await row('SELECT deleted_at, question FROM nodes WHERE id = $1 FOR UPDATE', ['pgt2']))[0];
    assert.ok(after.deleted_at, '不得复活');
    assert.equal(after.question, '将删', '内容也不得被墓碑后的写入改动');
    assert.deepEqual(nodeIds(await getCanvas(id)), ['pgt1'], '墓碑行不得回吐给前端');
  });

  t('级联墓碑：删节点连带墓碑其关联边，端点节点保留', async () => {
    const id = 'h2pg-cascade';
    await legacySave(
      id,
      [node('pgc1', '甲'), node('pgc2', '乙'), node('pgc3', '丙')],
      [edge('pgce1', 'pgc1', 'pgc2'), edge('pgce2', 'pgc2', 'pgc3')]
    );

    await mergeSave(id, { deletedNodeIds: ['pgc2'] });
    const rows = await row('SELECT id, deleted_at FROM edges WHERE canvas_id = $1 ORDER BY id', [id]);
    assert.ok(rows.find((r) => r.id === 'pgce1')?.deleted_at, '挂在被删节点上的边必须一并墓碑');
    assert.ok(rows.find((r) => r.id === 'pgce2')?.deleted_at, '入边同样要墓碑');
    assert.deepEqual(nodeIds(await getCanvas(id)), ['pgc1', 'pgc3']);
    assert.deepEqual(edgeIds(await getCanvas(id)), []);
  });

  t('边端点按服务端存活集合校验：连到未改动节点的新边必须保留', async () => {
    const id = 'h2pg-edge-untouched';
    await legacySave(id, [node('pge1', '甲'), node('pge2', '乙')]);

    const r = await mergeSave(id, { nodes: [node('pge1', '甲改')], edges: [edge('pgee1', 'pge1', 'pge2')] });
    assert.equal(r.status, 200);
    assert.deepEqual(
      edgeIds(await getCanvas(id)),
      ['pgee1'],
      '端点校验若按 payload 节点集合做，这条边会被静默丢掉'
    );
  });

  t('边墓碑：陈旧设备不得复活已删边', async () => {
    const id = 'h2pg-edge-tombstone';
    await legacySave(id, [node('pget1', '甲'), node('pget2', '乙')], [edge('pgete1', 'pget1', 'pget2')]);

    await mergeSave(id, { deletedEdgeIds: ['pgete1'] });
    assert.deepEqual(edgeIds(await getCanvas(id)), []);

    const stale = await mergeSave(id, { edges: [edge('pgete1', 'pget1', 'pget2')] });
    assert.equal(stale.status, 200, '边墓碑后重推不报错，只是不生效');
    assert.deepEqual(edgeIds(await getCanvas(id)), [], '边墓碑后不得复活');
    assert.deepEqual(nodeIds(await getCanvas(id)), ['pget1', 'pget2']);
  });

  t('跨板搬节点：他人板内 id 提交到本板 → 400，他人板不变', async () => {
    const mine = 'h2pg-cross-a';
    const theirs = 'h2pg-cross-b';
    await legacySave(mine, [node('pgca1', '我的')]);
    await legacySave(theirs, [node('pgcb1', '别处的')]);

    const r = await mergeSave(mine, { nodes: [node('pgcb1', '偷来的')] });
    assert.equal(r.status, 400);
    assert.equal(r.body?.code, 'NODE_CANVAS_MISMATCH');
    assert.deepEqual(nodeIds(await getCanvas(mine)), ['pgca1']);
    assert.deepEqual(nodeIds(await getCanvas(theirs)), ['pgcb1']);
  });

  t('父子同批按拓扑序落库，孤儿父节点被修复并回执', async () => {
    const id = 'h2pg-topo';
    await legacySave(id, [node('pgtp1', '根')]);

    const r = await mergeSave(id, {
      nodes: [node('pgtp2', '子', 'pgtp3'), node('pgtp3', '父', 'pgtp1'), node('pgtp4', '孤儿', 'pg-不存在')],
    });
    assert.equal(r.status, 200, '父不可达不得让整次保存失败');
    assert.deepEqual(r.body.canvas.repairedNodeIds, ['pgtp4']);

    const final = await getCanvas(id);
    assert.deepEqual(nodeIds(final), ['pgtp1', 'pgtp2', 'pgtp3', 'pgtp4']);
    assert.equal(final.nodes.find((n: any) => n.id === 'pgtp2').data.parentId, 'pgtp3');
    assert.equal(final.nodes.find((n: any) => n.id === 'pgtp4').data.parentId, null);
  });

  t('计数在事务内重算为板内总量（不是 payload 长度）', async () => {
    const id = 'h2pg-counts';
    await legacySave(id, [node('pgct1', '甲'), node('pgct2', '乙'), node('pgct3', '丙')]);

    const r = await mergeSave(id, { nodes: [node('pgct1', '改')] });
    assert.equal(r.status, 200);
    assert.equal(r.body.canvas.nodeCount, 3);
    assert.equal(r.body.canvas.edgeCount, 0);
  });

  t('旧 payload 仍走整板替换；SAVE_LEGACY_REPLACE_ENABLED=false 时 409 CLIENT_OUTDATED', async () => {
    const id = 'h2pg-legacy';
    await legacySave(id, [node('pgl1', '甲'), node('pgl2', '乙')]);
    assert.equal((await legacySave(id, [node('pgl1', '甲')])).status, 200);
    assert.deepEqual(nodeIds(await getCanvas(id)), ['pgl1'], '替换语义：省略即删除');

    process.env.SAVE_LEGACY_REPLACE_ENABLED = 'false';
    try {
      const r = await legacySave(id, [node('pgl1', '丙')]);
      assert.equal(r.status, 409);
      assert.equal(r.body?.code, 'CLIENT_OUTDATED');
      assert.equal(r.body?.latest_updated_at, undefined, '带上会让旧客户端进入重发循环');
      assert.equal((await mergeSave(id, { nodes: [node('pgl1', '丙')] })).status, 200);
    } finally {
      delete process.env.SAVE_LEGACY_REPLACE_ENABLED;
    }
  });
});
