/**
 * Spec A3 — nodes + edges 批量保存事务化
 * 功能性回归保护：批量改造后保存语义（全量替换/字段往返/特殊字符）不变。
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

async function startServerAndSignIn(): Promise<void> {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  await waitSeeds();

  // B1 配额生效后，体验版限 3 画板——本套件专注批量保存回归，改用不受限的 admin
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
  });
  assert.equal(res.status, 200);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}

async function saveCanvas(id: string, nodes: any[], edges: any[], title = 'A3 测试') {
  return fetch(`${base}/api/canvases/${id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ id, title, nodes, edges }),
  });
}

async function getCanvas(id: string) {
  const res = await fetch(`${base}/api/canvases/${id}`, { headers: { cookie } });
  assert.equal(res.status, 200, `getCanvas ${id} should 200`);
  return res.json() as any;
}

function makeNodes(count: number, prefix = 'n'): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    type: i % 5 === 0 ? 'note' : 'chat',
    position: { x: i * 10, y: i * -5 },
    data: {
      title: `节点${i}`,
      question: i % 5 === 0 ? '' : `问题${i}？`,
      answer: `回答${i}`,
      noteContent: i % 5 === 0 ? `便签内容${i}` : '',
      messages: [{ role: 'user', content: `msg-${i}` }],
      status: 'idle',
      depth: Math.floor(i / 3),
      parentId: i > 0 ? `${prefix}${i - 1}` : null,
      enableWebSearch: i % 2 === 0,
      isCollapsed: false,
    },
  }));
}

function makeEdges(nodes: any[]): any[] {
  return nodes.slice(1).map((n, i) => ({
    id: `e${i}`,
    source: nodes[i].id,
    target: n.id,
    type: 'smoothstep',
    animated: i % 3 === 0,
  }));
}

describe('A3 批量保存事务化（功能回归保护）', () => {
  before(async () => {
    await startServerAndSignIn();
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('保存 300 节点 + 299 边，回读数量完整', async () => {
    const nodes = makeNodes(300);
    const edges = makeEdges(nodes);
    const res = await saveCanvas('a3-big-board', nodes, edges);
    assert.equal(res.status, 200);

    const canvas = await getCanvas('a3-big-board');
    assert.equal(canvas.nodes.length, 300);
    assert.equal(canvas.edges.length, 299);
    assert.equal(canvas.nodes[299].data.title, '节点299');
  });

  test('覆盖保存为替换而非追加', async () => {
    const first = makeNodes(50, 'a');
    await saveCanvas('a3-overwrite', first, makeEdges(first));
    const second = makeNodes(10, 'b');
    await saveCanvas('a3-overwrite', second, makeEdges(second));

    const canvas = await getCanvas('a3-overwrite');
    assert.equal(canvas.nodes.length, 10);
    assert.equal(canvas.edges.length, 9);
    assert.ok(canvas.nodes.every((n: any) => n.id.startsWith('b')));
  });

  test('保存空 nodes/edges 清空原数据', async () => {
    const nodes = makeNodes(20, 'c');
    await saveCanvas('a3-empty', nodes, makeEdges(nodes));
    await saveCanvas('a3-empty', [], []);

    const canvas = await getCanvas('a3-empty');
    assert.equal(canvas.nodes.length, 0);
    assert.equal(canvas.edges.length, 0);
  });

  test('特殊字符往返无损（引号/emoji/反斜杠/SQL 通配符）', async () => {
    const tricky = [
      {
        id: 't0', type: 'note', position: { x: 0, y: 0 },
        data: {
          title: `含'单引号与"双引号`,
          noteContent: `反斜杠\\与百分号%及下划线_`,
          messages: [{ role: 'user', content: `emoji🙂与'引号'` }],
        },
      },
    ];
    const res = await saveCanvas('a3-tricky', tricky, []);
    if (res.status !== 200) console.log('DEBUG body=', JSON.stringify(await res.json()));
    assert.equal(res.status, 200);

    const canvas = await getCanvas('a3-tricky');
    assert.equal(canvas.nodes[0].data.title, `含'单引号与"双引号`);
    assert.ok(canvas.nodes[0].data.noteContent.includes('反斜杠\\'));
    assert.equal(canvas.nodes[0].data.messages[0].content, `emoji🙂与'引号'`);
  });

  test('富字段往返：grounding/custom_data/parentId/animated', async () => {
    const nodes = [
      {
        id: 'r0', type: 'chat', position: { x: 5, y: 6 },
        data: {
          title: '富字段根', question: 'q', answer: 'a',
          grounding: { sources: [{ index: 1, title: 't', uri: 'https://x', domain: 'x' }], queries: ['k'] },
          customTag: '自定义扩展字段',
          depth: 2,
        },
      },
      {
        id: 'r1', type: 'chat', position: { x: 7, y: 8 },
        data: { title: '子节点', parentId: 'r0', depth: 3 },
      },
    ];
    const edges = [{ id: 're0', source: 'r0', target: 'r1', animated: true }];
    await saveCanvas('a3-rich', nodes, edges);

    const canvas = await getCanvas('a3-rich');
    const r0 = canvas.nodes.find((n: any) => n.id === 'r0');
    const r1 = canvas.nodes.find((n: any) => n.id === 'r1');
    assert.deepEqual(r0.data.grounding, { sources: [{ index: 1, title: 't', uri: 'https://x', domain: 'x' }], queries: ['k'] });
    assert.equal(r0.data.customTag, '自定义扩展字段');
    assert.equal(r1.data.parentId, 'r0');
    assert.equal(canvas.edges[0].animated, true);
  });
});
