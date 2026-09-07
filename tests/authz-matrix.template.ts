/**
 * 越权矩阵测试模板（Spec J4 / 跟踪清单 E3）
 * =============================================================
 * 用途：新增或修改资源型端点时，复制本文件为 `tests/<id>-authz-matrix.test.ts`
 * 并按 TODO 填空，把「读/写/删 × 属主/他人/admin/匿名」矩阵变成例行动作。
 * 文件名以 .template.ts 结尾，不会被 `npm test`（glob tests/*.test.ts）加载。
 *
 * 使用步骤：
 *   1. cp 本文件 tests/xx-authz-matrix.test.ts（tests/ 只读豁免需用户显式授权，豁免写提交信息）
 *   2. 替换所有 TODO 标记
 *   3. 删除与本端点无关的动作块（如资源不可删）
 *   4. 运行 npx tsx --test tests/xx-authz-matrix.test.ts 确认全绿
 *
 * 矩阵语义约定（详见 docs/安全发布checklist.md §1）：
 *   - 读：非属主 404（不泄露存在性）；admin 200；匿名 401
 *   - 写：非属主 403（独立错误码）；admin 200；匿名 401
 *   - 删：非属主 403；admin 200；匿名 401；已删资源幂等语义测试锁定
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import { signupRateLimiter, sendRegisterCodeRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';
let ownerCookie = ''; // TODO: 资源属主
let strangerCookie = ''; // TODO: 无关第三方
let adminCookie = '';

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

async function registerViaCode(email: string, password: string, name?: string): Promise<void> {
  (signupRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  (sendRegisterCodeRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
  await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === '枝想 注册验证码');
  assert.ok(mail, `应发出验证码邮件（${email}）`);
  const code = (mail.text || mail.html || '').match(/\b(\d{6})\b/)![1];
  const res = await fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code }),
  });
  assert.ok([200, 201].includes(res.status), `sign-up ${email} 应成功`);
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

// ---------------------------------------------------------------------------
// TODO: 替换为被测端点的请求封装。示例以「资源 ID 通过路径参数传递」的端点为模板；
// 归属由 query/body 传递的端点（如 GET /api/quota?canvasId=）同样适用，改 URL 构造即可。
// ---------------------------------------------------------------------------
const RESOURCE_ID = 'todo-resource-id';

function readResource(cookie?: string): Promise<Response> {
  return fetch(`${base}/api/TODO/${RESOURCE_ID}`, { headers: cookie ? { cookie } : {} });
}

function writeResource(cookie?: string): Promise<Response> {
  return fetch(`${base}/api/TODO/${RESOURCE_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ /* TODO */ }),
  });
}

function deleteResource(cookie?: string): Promise<Response> {
  return fetch(`${base}/api/TODO/${RESOURCE_ID}`, {
    method: 'DELETE',
    headers: cookie ? { cookie } : {},
  });
}

describe('AuthZ 矩阵：TODO 端点（J4 模板）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();

    adminCookie = await signIn('admin@deepdive.ai', 'Admin123456!');
    await registerViaCode('mx-owner@test.local', 'Owner123456!', 'Owner');
    ownerCookie = await signIn('mx-owner@test.local', 'Owner123456!');
    await registerViaCode('mx-stranger@test.local', 'Stranger123456!', 'Stranger');
    strangerCookie = await signIn('mx-stranger@test.local', 'Stranger123456!');

    // TODO: 属主创建资源
    // const res = await fetch(...);
    // assert.ok([200, 201].includes(res.status));
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('匿名读 → 401', async () => {
    assert.equal((await readResource()).status, 401);
  });

  test('匿名写 → 401', async () => {
    assert.equal((await writeResource()).status, 401);
  });

  test('匿名删 → 401', async () => {
    assert.equal((await deleteResource()).status, 401);
  });

  test('非属主读 → 404（不泄露存在性）', async () => {
    assert.equal((await readResource(strangerCookie)).status, 404);
  });

  test('非属主写 → 403 且错误码独立', async () => {
    const res = await writeResource(strangerCookie);
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    // TODO: 替换为该端点的实际错误码（如 CANVAS_FORBIDDEN）
    assert.equal(body.code, 'TODO_FORBIDDEN');
  });

  test('非属主删 → 403', async () => {
    assert.equal((await deleteResource(strangerCookie)).status, 403);
  });

  test('属主读 → 200', async () => {
    assert.equal((await readResource(ownerCookie)).status, 200);
  });

  test('属主写 → 2xx', async () => {
    const res = await writeResource(ownerCookie);
    assert.ok([200, 201].includes(res.status));
  });

  test('admin 读 → 200（管理放行）', async () => {
    assert.equal((await readResource(adminCookie)).status, 200);
  });

  test('admin 写 → 2xx（管理放行）', async () => {
    const res = await writeResource(adminCookie);
    assert.ok([200, 201].includes(res.status));
  });

  test('admin 删 → 2xx；属主再读 404；删除幂等语义锁定', async () => {
    const del = await deleteResource(adminCookie);
    assert.ok([200, 204].includes(del.status));
    assert.equal((await readResource(ownerCookie)).status, 404);
    // 幂等语义（按端点实际口径二选一保留）：
    const again = await deleteResource(adminCookie);
    assert.ok([200, 404].includes(again.status), '重复删除语义需与设计口径一致并锁定');
  });

  // TODO: 若资源支持软删/复活防护，追加：
  // test('属主对已删 id 再 save → 404（防复活）', ...)
});
