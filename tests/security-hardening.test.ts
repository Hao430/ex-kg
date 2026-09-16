/**
 * 安全审查（2026-09-16）回归套件 —— 数据暴露面与凭据面
 *
 * 锁定以下修复不被改回去：
 *   - H1：运营台用户列表**不得**回吐 `password_hash` / `verify_token` / `reset_token`
 *         （`reset_token` 是明文入库的一次性凭据，1h 内可直接换号）；
 *   - M1：会话令牌只经 httpOnly cookie 下发，响应体不得带 `token`；
 *   - M3：Host 头是请求方可控的 → 链接来源必须经字符白名单 + 邮件 HTML 必须转义；
 *   - L1：`reset-password` 有独立限流器（否则匿名端点可无限触发 scrypt）；
 *   - L3：`/api/health` 不回吐 `hasApiKey`；
 *   - L5：运营台写接口有独立限流器。
 *
 * 内存模式（本套件默认跑法）覆盖 H1 的内存分支；PG 分支的列投影由
 * `tests/pg/admin-count.pg.test.ts` 的真库用例覆盖——两路必须同形。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';

import { createApp } from '../server/app.js';
import { getOutboxForTest, clearOutboxForTest, sendPasswordResetEmail } from '../server/lib/mailer.js';
import { sanitizeHostHeader, resolveRequestOrigin } from '../server/lib/origin.js';
import { resetPasswordRateLimiter, adminUserWriteRateLimiter, sendRegisterCodeRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';
let adminCookie = '';
let userCookie = '';

const SEED_ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const SEED_USER_ID = '00000000-0000-0000-0000-000000000002';

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

async function signIn(email: string, password: string): Promise<{ cookie: string; body: any }> {
  const res = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in ${email} 应成功`);
  return {
    cookie: (res.headers.get('set-cookie') || '').split(';')[0],
    body: await res.json(),
  };
}

describe('安全审查回归：数据暴露面', () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    adminCookie = (await signIn('admin@deepdive.ai', 'Admin123456!')).cookie;
    userCookie = (await signIn('user@deepdive.ai', 'User123456!')).cookie;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  describe('H1 运营台用户列表列投影', () => {
    test('列表行不得含任何凭据列（password_hash / verify_token / reset_token）', async () => {
      const res = await fetch(`${base}/api/admin/users?limit=50`, { headers: { cookie: adminCookie } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.ok(Array.isArray(body.users) && body.users.length > 0, '应能列出种子用户');

      const credentialKeys = [
        'password_hash',
        'verify_token',
        'verify_expires_at',
        'reset_token',
        'reset_expires_at',
      ];
      for (const row of body.users) {
        for (const key of credentialKeys) {
          assert.equal(
            key in row,
            false,
            `用户列表不得包含 ${key}（H1）——它是运营台 UI 不消费的凭据字段`
          );
        }
      }
      // 整体再兜一次：响应文本里不该出现这些列名（防止有人改回 `SELECT u.*` 后逐字段过滤）
      const raw = JSON.stringify(body);
      for (const key of credentialKeys) {
        assert.equal(raw.includes(key), false, `响应体中不应出现字段名 ${key}`);
      }
    });

    test('运营台 UI 消费的字段仍在（列投影不能把功能一起砍掉）', async () => {
      const res = await fetch(`${base}/api/admin/users?limit=50`, { headers: { cookie: adminCookie } });
      const body = (await res.json()) as any;
      const admin = body.users.find((u: any) => u.id === SEED_ADMIN_ID);
      assert.ok(admin, '应包含种子管理员');
      for (const key of ['id', 'email', 'name', 'role', 'is_active', 'vip_expires_at', 'canvas_count', 'total_tokens_used']) {
        assert.ok(key in admin, `运营台用户行应保留字段 ${key}`);
      }
      assert.equal(typeof admin.canvas_count, 'number');
      assert.equal(typeof admin.total_tokens_used, 'number');
      assert.equal(admin.email, 'admin@deepdive.ai');
    });
  });

  describe('M1 会话令牌只走 httpOnly cookie', () => {
    test('sign-in 响应体不含 token，cookie 仍可鉴权', async () => {
      const { cookie, body } = await signIn('user@deepdive.ai', 'User123456!');
      assert.equal('token' in body, false, 'sign-in 不得回传 token（M1：会抵消 httpOnly）');
      assert.equal(JSON.stringify(body).includes('token'), false);
      assert.ok(cookie.startsWith('session_token='), 'cookie 仍应下发');

      const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
      assert.equal(me.status, 200, '仅凭 cookie 应能通过鉴权');
    });

    test('sign-up 响应体不含 token，cookie 仍可鉴权', async () => {
      (sendRegisterCodeRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
      clearOutboxForTest();
      const email = 'sec-m1-signup@test.local';

      const codeRes = await fetch(`${base}/api/auth/send-register-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.equal(codeRes.status, 200);
      const mail = getOutboxForTest().find((m) => m.to === email);
      assert.ok(mail, '应发出注册验证码邮件');
      const code = (mail!.text || '').match(/(\d{6})/)![1];

      const res = await fetch(`${base}/api/auth/sign-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'SecReview123', code, name: 'M1' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal('token' in body, false, 'sign-up 不得回传 token（M1）');

      const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
      const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
      assert.equal(me.status, 200, '仅凭 cookie 应能通过鉴权');
    });
  });

  describe('M3 Host 头白名单与邮件 HTML 转义', () => {
    test('sanitizeHostHeader：合法主机名/IPv6 通过，注入形态一律拒绝', () => {
      assert.equal(sanitizeHostHeader('example.com'), 'example.com');
      assert.equal(sanitizeHostHeader('EXAMPLE.com:3000'), 'example.com:3000');
      assert.equal(sanitizeHostHeader('127.0.0.1:3000'), '127.0.0.1:3000');
      assert.equal(sanitizeHostHeader('[::1]:3000'), '[::1]:3000');

      const bad = [
        'evil.com"><img src=x>',
        'evil.com\nX-Injected: 1',
        'evil.com/path',
        'user:pass@evil.com',
        'evil.com\\x',
        '',
        ' ',
      ];
      for (const host of bad) {
        assert.equal(sanitizeHostHeader(host), null, `应拒绝 Host: ${JSON.stringify(host)}`);
      }
    });

    test('APP_URL 已配置时完全不看 Host；未配置且 Host 非法时抛错（不回落 localhost）', () => {
      const prev = process.env.APP_URL;
      try {
        process.env.APP_URL = 'https://kg.hao430.cn/some/path';
        assert.equal(
          resolveRequestOrigin({ protocol: 'http', get: () => 'evil.com' }),
          'https://kg.hao430.cn',
          'APP_URL 优先：Host 被完全忽略'
        );

        delete process.env.APP_URL;
        assert.equal(
          resolveRequestOrigin({ protocol: 'http', get: () => '127.0.0.1:3000' }),
          'http://127.0.0.1:3000',
          '合法 Host 仍可用（本地开发与既有测试依赖这条）'
        );
        assert.throws(
          () => resolveRequestOrigin({ protocol: 'http', get: () => 'evil.com"><script>' }),
          /ORIGIN_UNRESOLVED|无法确定本站地址/,
          '非法 Host + 无 APP_URL → 响亮失败，绝不回落到一个明知错误的地址'
        );
      } finally {
        if (prev === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = prev;
      }
    });

    test('邮件 HTML 对插值转义：伪造 Host 无法撕开标记', async () => {
      clearOutboxForTest();
      // 模拟一个「来源被污染」的链接：引号必须被转义，否则 href 属性会被提前闭合
      const nasty = 'https://evil.example/"><img src=x onerror=alert(1)>';
      await sendPasswordResetEmail('sec-m3@test.local', nasty);

      const mail = getOutboxForTest().find((m) => m.to === 'sec-m3@test.local');
      assert.ok(mail, '应产生一封重置邮件');
      assert.equal(mail!.html!.includes('<img src=x'), false, '未转义的标签不得出现在邮件 HTML 里');
      assert.ok(mail!.html!.includes('&quot;&gt;&lt;img'), '引号与尖括号应被转义');
      // 纯文本部分不做 HTML 转义（不是 HTML 上下文），保持原样即可
      assert.ok(mail!.text!.includes(nasty), 'text 版本保持原文，便于用户识别可疑链接');
    });
  });

  describe('低危项', () => {
    test('L1：reset-password 有独立限流器（第 11 次 → 429）', async () => {
      (resetPasswordRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
      let lastStatus = 0;
      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${base}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'deadbeef', password: 'Whatever123' }),
        });
        lastStatus = res.status;
      }
      assert.equal(lastStatus, 429, '匿名端点跑 scrypt 必须有刹车');
    });

    test('L3：/api/health 不回吐 hasApiKey', async () => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.status, 'ok');
      assert.equal('hasApiKey' in body, false, '健康检查是匿名端点，不该暴露部署内部信息');
    });

    test('L5：运营台写接口有独立限流器（第 31 次 → 429）', async () => {
      (adminUserWriteRateLimiter as any).resetKey(`user_${SEED_ADMIN_ID}`);
      const call = () =>
        fetch(`${base}/api/admin/users/${SEED_USER_ID}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', cookie: adminCookie },
          body: JSON.stringify({ is_active: true }),
        });

      const first = await call();
      assert.equal(first.status, 200, '首次应放行');

      let lastStatus = 0;
      for (let i = 0; i < 30; i++) {
        lastStatus = (await call()).status;
      }
      assert.equal(lastStatus, 429, '运营台写接口需有刹车（30/min per admin）');
    });
  });
});
