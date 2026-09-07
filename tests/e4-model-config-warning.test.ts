/**
 * E4 — 模型配置单点依赖告警（跟踪清单 E4 / 里程碑 K8）
 *
 * 决策：管理员未配置模型 = 全站推理不可用（400 MODEL_NOT_CONFIGURED），不做默认模型回落。
 * 本测试锁定：
 * 1. GET /api/admin/overview 暴露 modelConfigured 布尔（未配置 → false，配置后 → true）；
 * 2. 未配置时普通用户 chat → 400 MODEL_NOT_CONFIGURED（新装忘配置的显式失败路径）；
 * 3. 管理员保存模型配置后状态翻转，chat 不再报「模型未配置」（联网测试不在后端测试范围，
 *    此处仅验证拦截翻转，chat 会因无真实 API Key 走后续流程，不 assert 其成功）。
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

async function getOverview(cookie: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/admin/overview`, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('E4 模型配置告警', () => {
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

  test('未配置模型：admin overview → modelConfigured=false', async () => {
    const { status, body } = await getOverview(adminCookie);
    assert.equal(status, 200);
    assert.equal(body.modelConfigured, false);
  });

  test('未配置模型：普通用户 chat → 400 MODEL_NOT_CONFIGURED（显式失败不静默）', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'MODEL_NOT_CONFIGURED');
  });

  test('管理员保存模型配置 → modelConfigured 翻转为 true，chat 不再报「模型未配置」', async () => {
    const saveRes = await fetch(`${base}/api/admin/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ provider: 'gemini', gemini_model: 'gemini-test-model', openai_model: 'test-model' }),
    });
    assert.equal(saveRes.status, 200);

    const { status, body } = await getOverview(adminCookie);
    assert.equal(status, 200);
    assert.equal(body.modelConfigured, true);

    // chat 不应再命中 MODEL_NOT_CONFIGURED（后续因测试环境无真实上游而失败，与 E4 无关）
    const chatRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.notEqual(chatRes.status, 400);
    const chatBody = await chatRes.json().catch(() => null);
    assert.notEqual(chatBody?.code, 'MODEL_NOT_CONFIGURED');
  });
});
