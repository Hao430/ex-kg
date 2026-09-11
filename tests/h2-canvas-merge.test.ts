/**
 * H2 — 画布节点级合并写入（ADR-0017，protocolVersion >= 2）
 *
 * 背景：服务端一直是整板替换（DELETE-all + 全量重插），任何一次保存都会抹掉整块板上
 * 他人的改动。叠加客户端在 409 时本地胜出，结果就是「最后同步的设备赢」而不是
 * 「最后编辑的赢」——用户原话是「半天不上传，改完被云端的覆盖掉了」。
 *
 * 本套件验证合并写入的语义分水岭：**「没带」不再等于「删除」，而是「不动」**。
 * 删除必须显式声明（deletedNodeIds / deletedEdgeIds），删除胜出（墓碑不得复活）。
 *
 * 协议判别靠显式 protocolVersion，**不能猜结构**：旧客户端的整板 payload 与新客户端的
 * 「本次改动」结构上无法区分，且空数组在旧客户端是「清空」、在新客户端是「无删除」。
 * 因此本套件既验证 protocolVersion:2 走合并，也验证缺省时仍走替换（旧客户端零中断）。
 *
 * 注意：节点 id 在 PG 里是**全局主键**，跨画板复用同名 id 本来就建不出来。因此每个
 * 用例用自己独立的前缀造 id——这既是真库约束，也让内存分支的跨板校验与 PG 同口径。
 *
 * 内存分支（本进程未配 DATABASE_URL）；PG 分支同语义另见 tests/pg/。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

let server: http.Server;
let base = '';
let adminCookie = '';
let userCookie = '';

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
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** 合并保存（protocolVersion:2）。缺省字段刻意不传，验证「缺省 = 不动」 */
async function mergeSave(
  cookie: string,
  id: string,
  body: Record<string, any>
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, protocolVersion: 2, nodes: [], edges: [], ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 旧客户端保存（不带 protocolVersion）→ 整板替换 */
async function legacySave(
  cookie: string,
  id: string,
  nodes: any[],
  edges: any[] = [],
  title = 'H2 测试'
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title, nodes, edges }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getCanvas(cookie: string, id: string): Promise<any> {
  const res = await fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
  assert.equal(res.status, 200, `getCanvas ${id} 应 200`);
  return res.json();
}

/** 造节点：id 用 p1/p2 这类带前缀的形式，避免撞上别的画板 */
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

const nodeIds = (canvas: any): string[] => canvas.nodes.map((n: any) => n.id).sort();
const edgeIds = (canvas: any): string[] => canvas.edges.map((e: any) => e.id).sort();
const questionOf = (canvas: any, id: string): string | undefined =>
  canvas.nodes.find((n: any) => n.id === id)?.data?.question;
const parentOf = (canvas: any, id: string): string | null =>
  canvas.nodes.find((n: any) => n.id === id)?.data?.parentId;

describe('H2 画布节点级合并（内存分支）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    userCookie = await signIn('user@deepdive.ai', 'User123456!');
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('核心验收：两设备各改不同节点，两边改动都在（同一个过期基线）', async () => {
    const id = 'h2-two-devices';
    const seeded = await legacySave(adminCookie, id, [node('td1', '原始1'), node('td2', '原始2')]);
    assert.equal(seeded.status, 200);
    const staleBase = seeded.body.canvas.updatedAt; // 两台设备拿到的都是这个版本

    // 设备 A 只改 td1
    const a = await mergeSave(adminCookie, id, {
      nodes: [node('td1', 'A改的1')],
      expectedUpdatedAt: staleBase,
    });
    assert.equal(a.status, 200, '合并模式下画板级乐观锁不得挡住节点 op');

    // 设备 B 只改 td2，同样携带**过期的**基线
    const b = await mergeSave(adminCookie, id, {
      nodes: [node('td2', 'B改的2')],
      expectedUpdatedAt: staleBase,
    });
    assert.equal(b.status, 200, '第二个设备的节点 op 同样必须落库');

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(nodeIds(final), ['td1', 'td2'], '两个节点都必须在');
    assert.equal(questionOf(final, 'td1'), 'A改的1', 'A 的改动静默消失了');
    assert.equal(questionOf(final, 'td2'), 'B改的2', 'B 的改动静默消失了');
  });

  test('未带 = 不动：只提交 ut1 的改动，ut2 原样保留', async () => {
    const id = 'h2-untouched';
    await legacySave(adminCookie, id, [node('ut1', '原始1'), node('ut2', '原始2')]);

    const r = await mergeSave(adminCookie, id, { nodes: [node('ut1', '改过')] });
    assert.equal(r.status, 200);

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(nodeIds(final), ['ut1', 'ut2']);
    assert.equal(questionOf(final, 'ut2'), '原始2', '未出现在 payload 里的节点不得被删');
  });

  test('协议判别：缺省 protocolVersion 仍走整板替换（旧客户端零中断）', async () => {
    const id = 'h2-protocol-split';
    await legacySave(adminCookie, id, [node('ps1', '原始1'), node('ps2', '原始2')]);

    // 旧客户端语义 = 「板内只有 ps1」→ ps2 被删
    const legacy = await legacySave(adminCookie, id, [node('ps1', '原始1')]);
    assert.equal(legacy.status, 200);
    assert.deepEqual(nodeIds(await getCanvas(adminCookie, id)), ['ps1'], '替换语义：省略即删除');

    // 新客户端语义：同一个 payload = 「本次只动了 ps1」→ ps2 不动。
    // 空数组在两种客户端语义相反，所以判据只能是显式版本号。
    await mergeSave(adminCookie, id, { nodes: [node('ps2', '原始2')] });
    const merge = await mergeSave(adminCookie, id, { nodes: [node('ps1', '再改')] });
    assert.equal(merge.status, 200);
    assert.deepEqual(nodeIds(await getCanvas(adminCookie, id)), ['ps1', 'ps2'], '合并语义：省略 = 不动');
  });

  test('显式删除：deletedNodeIds 删除节点并级联删除其关联边', async () => {
    const id = 'h2-explicit-delete';
    await legacySave(
      adminCookie,
      id,
      [node('ed1', '根'), node('ed2', '子', 'ed1')],
      [edge('ede1', 'ed1', 'ed2')]
    );

    const r = await mergeSave(adminCookie, id, { deletedNodeIds: ['ed2'] });
    assert.equal(r.status, 200);

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(nodeIds(final), ['ed1']);
    assert.deepEqual(edgeIds(final), [], '节点没了，挂在它上面的边必须一并墓碑');
  });

  test('删除胜出：墓碑后陈旧设备再 upsert 同一 id 不得复活', async () => {
    const id = 'h2-tombstone-wins';
    await legacySave(adminCookie, id, [node('tw1', '根'), node('tw2', '将删', 'tw1')]);

    await mergeSave(adminCookie, id, { deletedNodeIds: ['tw2'] });

    // 挂机设备（内存里还是旧内容）把 tw2 再推上来
    const stale = await mergeSave(adminCookie, id, { nodes: [node('tw2', '旧设备推的')] });
    assert.equal(stale.status, 200, '不报错，但也不得复活');
    assert.deepEqual(
      stale.body.canvas.ignoredNodeIds,
      ['tw2'],
      '被墓碑守卫拒绝的 id 必须在回执里报出，供观测与排障'
    );
    assert.deepEqual(nodeIds(await getCanvas(adminCookie, id)), ['tw1']);
  });

  test('同节点并发：后到者胜，且节点级 LWW 不牵连其他节点', async () => {
    const id = 'h2-same-node-lww';
    await legacySave(adminCookie, id, [node('lw1', 'v0'), node('lw2', '旁观')]);

    await mergeSave(adminCookie, id, { nodes: [node('lw1', '先到')] });
    await mergeSave(adminCookie, id, { nodes: [node('lw1', '后到')] });

    const final = await getCanvas(adminCookie, id);
    assert.equal(questionOf(final, 'lw1'), '后到', '同一节点仍是最先落库者胜');
    assert.equal(questionOf(final, 'lw2'), '旁观', '节点级冲突不得影响其他节点');
  });

  test('边端点按服务端存活节点校验：连到未改动节点的新边必须保留', async () => {
    const id = 'h2-edge-to-untouched';
    await legacySave(adminCookie, id, [node('eu1', '甲'), node('eu2', '乙'), node('eu3', '丙')]);

    // payload 只带 eu1，新边却连到不在 payload 里的 eu2
    const r = await mergeSave(adminCookie, id, {
      nodes: [node('eu1', '甲改了')],
      edges: [edge('eue1', 'eu1', 'eu2')],
    });
    assert.equal(r.status, 200);

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(
      edgeIds(final),
      ['eue1'],
      '端点校验若仍按 payload 节点集合做，这条边会被静默丢掉（合并模式最容易踩的坑）'
    );
  });

  test('边墓碑：deletedEdgeIds 删除边，端点节点保留；陈旧设备不得复活该边', async () => {
    const id = 'h2-edge-tombstone';
    await legacySave(
      adminCookie,
      id,
      [node('et1', '甲'), node('et2', '乙')],
      [edge('ete1', 'et1', 'et2')]
    );

    const r = await mergeSave(adminCookie, id, { deletedEdgeIds: ['ete1'] });
    assert.equal(r.status, 200);
    assert.deepEqual(edgeIds(await getCanvas(adminCookie, id)), []);

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(nodeIds(final), ['et1', 'et2'], '删边不得波及端点节点');

    await mergeSave(adminCookie, id, { edges: [edge('ete1', 'et1', 'et2')] });
    assert.deepEqual(edgeIds(await getCanvas(adminCookie, id)), [], '墓碑后不得复活');
  });

  test('跨板搬节点被拒：400 NODE_CANVAS_MISMATCH，两边画板都不受影响', async () => {
    const mine = 'h2-cross-owner-a';
    const theirs = 'h2-cross-owner-b';
    await legacySave(adminCookie, mine, [node('ca1', '我的')]);
    await legacySave(adminCookie, theirs, [node('cb1', '别处的')]);

    const r = await mergeSave(adminCookie, mine, { nodes: [node('cb1', '偷来的')] });
    assert.equal(r.status, 400);
    assert.equal(r.body?.code, 'NODE_CANVAS_MISMATCH');

    assert.deepEqual(nodeIds(await getCanvas(adminCookie, mine)), ['ca1'], '本板不得被写入');
    assert.deepEqual(
      nodeIds(await getCanvas(adminCookie, theirs)),
      ['cb1'],
      '他人画板内容不得被改动'
    );
  });

  test('父节点不可达 → parentId 置空并在回执报出，保存不失败', async () => {
    const id = 'h2-orphan-parent';
    await legacySave(adminCookie, id, [node('op1', '根')]);

    const r = await mergeSave(adminCookie, id, { nodes: [node('op2', '孤儿', 'op-不存在')] });
    assert.equal(r.status, 200, '父不可达不该让整次保存 500——用户表现为「画板存不进去」');
    assert.deepEqual(r.body.canvas.repairedNodeIds, ['op2']);

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(nodeIds(final), ['op1', 'op2']);
    assert.equal(parentOf(final, 'op2'), null);
  });

  test('父子同批提交按拓扑序落库（子先于父不得 FK 失败）', async () => {
    const id = 'h2-topo-order';
    await legacySave(adminCookie, id, [node('to1', '根')]);

    // 刻意把子放在父前面
    const r = await mergeSave(adminCookie, id, {
      nodes: [node('to2', '子', 'to3'), node('to3', '父', 'to1')],
    });
    assert.equal(r.status, 200);
    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(nodeIds(final), ['to1', 'to2', 'to3']);
    assert.equal(parentOf(final, 'to2'), 'to3');
  });

  test('跨 payload 与服务端的环被拒绝（只看 payload 会漏判）', async () => {
    const id = 'h2-cycle-cross';
    await legacySave(adminCookie, id, [node('cc1', '甲'), node('cc2', '乙', 'cc1')]);

    // 把 cc1 的父改成 cc2：环横跨「本次 payload 的 cc1」与「服务端的 cc2」
    const r = await mergeSave(adminCookie, id, { nodes: [node('cc1', '甲', 'cc2')] });
    assert.equal(r.status, 400);
    assert.equal(r.body?.code, 'NODE_PARENT_CYCLE');
  });

  test('回执计数为板内总量而非 payload 长度', async () => {
    const id = 'h2-counts';
    await legacySave(adminCookie, id, [node('ct1', '甲'), node('ct2', '乙'), node('ct3', '丙')]);

    const r = await mergeSave(adminCookie, id, { nodes: [node('ct1', '改')] });
    assert.equal(r.status, 200);
    assert.equal(r.body.canvas.nodeCount, 3, 'payload 只带 1 个节点，但板内有 3 个');
  });

  test('SAVE_LEGACY_REPLACE_ENABLED=false：旧 payload 返回 409 CLIENT_OUTDATED 且不带 latest_updated_at', async () => {
    const id = 'h2-client-outdated';
    await legacySave(adminCookie, id, [node('co1', '甲')]);

    process.env.SAVE_LEGACY_REPLACE_ENABLED = 'false';
    try {
      const r = await legacySave(adminCookie, id, [node('co1', '乙')]);
      assert.equal(r.status, 409);
      assert.equal(r.body?.code, 'CLIENT_OUTDATED');
      // 带上 latest_updated_at 会让旧客户端进入「刷新版本号后重发」的循环
      assert.equal(r.body?.latest_updated_at, undefined);
      assert.equal(questionOf(await getCanvas(adminCookie, id), 'co1'), '甲', '整板替换必须已被拦下');

      // 新客户端不受影响
      const ok = await mergeSave(adminCookie, id, { nodes: [node('co1', '乙')] });
      assert.equal(ok.status, 200);
      assert.equal(questionOf(await getCanvas(adminCookie, id), 'co1'), '乙');
    } finally {
      delete process.env.SAVE_LEGACY_REPLACE_ENABLED;
    }
  });

  test('非属主不得写入（合并路径同样受严格属主约束）', async () => {
    const id = 'h2-owner-guard';
    await legacySave(userCookie, id, [node('og1', 'user 的')]);

    const r = await mergeSave(adminCookie, id, { nodes: [node('og2', 'admin 塞的')] });
    assert.equal(r.status, 403);
    assert.deepEqual(nodeIds(await getCanvas(userCookie, id)), ['og1']);
  });

  test('缺省 title/viewport 不覆盖已存值（合并模式只上行真正改过的整字段）', async () => {
    const id = 'h2-canvas-fields';
    const seeded = await legacySave(adminCookie, id, [node('cf1', '甲')], [], '原标题');
    assert.equal(seeded.status, 200);
    await mergeSave(adminCookie, id, {
      nodes: [node('cf2', '乙')],
      viewport: { x: 12, y: 34, zoom: 2 },
    });

    // 一次不带 title / viewport 的节点 op 不得把画板名与视口冲回默认值
    const r = await mergeSave(adminCookie, id, { nodes: [node('cf3', '丙')] });
    assert.equal(r.status, 200);

    const res = await fetch(`${base}/api/canvases`, { headers: { cookie: adminCookie } });
    const list = await res.json() as any[];
    const meta = list.find((c: any) => c.id === id);
    assert.equal(meta.title, '原标题', '缺省 title = 本次没改，不是「重置为默认名」');

    const final = await getCanvas(adminCookie, id);
    assert.deepEqual(final.viewport, { x: 12, y: 34, zoom: 2 }, '缺省 viewport 同理不得被重置');
  });
});
