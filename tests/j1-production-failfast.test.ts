/**
 * J1 — 生产 fail-fast 与健康检查 degraded（跟踪清单 E2 / 里程碑 J 组）
 *
 * 决策：生产环境（NODE_ENV=production）配置了 DATABASE_URL 时，PG 任何查询失败
 * 一律 503 DB_UNAVAILABLE，禁止静默降级内存造成 200 假成功；
 * 开发/测试环境保持内存降级行为不变。/api/db/status 暴露 degraded 字段供部署层探活告警。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// 必须在动态 import server 模块之前设置：
// mailer 在 production 下缺 SMTP 配置会于模块加载期抛错（dummy 值仅为通过加载校验，
// 实际发送不会发生——PG fail-fast 在写路径上先行拦截）；端口 9（discard）保证连接立即被拒。
process.env.NODE_ENV = 'production';
process.env.APP_URL = 'http://127.0.0.1:3000';
process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:9/arborize_failfast';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_USER = 'j1-test';
process.env.SMTP_PASS = 'j1-test';

const { createApp } = await import('../server/app.js');
const { getOutboxForTest } = await import('../server/lib/mailer.js');
const { sendRegisterCodeRateLimiter } = await import('../server/middleware/auth.js');
const { ipKeyGenerator } = await import('express-rate-limit');

let server: http.Server;
let base = '';

describe('J1 生产 fail-fast（E2）', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('生产 + PG 不可达：send-register-code → 503 DB_UNAVAILABLE（禁止静默降级内存）', async () => {
    const res = await fetch(`${base}/api/auth/send-register-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'j1@test.local' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as any;
    assert.equal(body.code, 'DB_UNAVAILABLE');
  });

  test('生产 + PG 不可达：outbox 不得出现验证码邮件（写路径确实未落内存）', () => {
    const hit = getOutboxForTest().some((m) => m.to === 'j1@test.local');
    assert.ok(!hit, 'fail-fast 模式下不应有邮件发出');
  });

  test('生产 + PG 不可达：/api/db/status 仍 200，degraded=true 供部署探活', async () => {
    const res = await fetch(`${base}/api/db/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.connected, false);
    assert.equal(body.databaseUrlConfigured, true);
    assert.equal(body.degraded, true);
  });

  test('切回开发环境：同一 PG 故障下降级内存照常（回归保障）', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    (sendRegisterCodeRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
    const res = await fetch(`${base}/api/auth/send-register-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'j1-dev@test.local' }),
    });
    assert.equal(res.status, 200);
    const mail = getOutboxForTest().find((m) => m.to === 'j1-dev@test.local');
    assert.ok(mail, '开发环境应经 jsonTransport 干跑发出验证码邮件');
  });
});
