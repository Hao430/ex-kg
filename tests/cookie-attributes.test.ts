/**
 * 技术债 #0013 / ADR-0020 —— 会话 cookie 属性契约
 *
 * 把此前**完全隐式**的 CSRF 防线变成会变红的显式契约：会话 cookie 的
 * `HttpOnly` / `SameSite=Lax` / `Path=/` / 无 `Domain` 此前只存在于 `routes/auth.ts` 的
 * 一行 `res.cookie` 里，谁把它改成 `sameSite:'none'` 都不会有任何测试失败。
 * 现在属性收敛到 `server/lib/session-cookie.ts`（单一事实源），并由本文件锁定。
 *
 * `Secure` 只在 `NODE_ENV=production` 出现——本地开发/测试走 http，恒 Secure 会让
 * cookie 根本发不出去，因此这里同时锁定两个方向（生产必须有、非生产必须没有）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { loginRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';

const SEED_EMAIL = 'user@deepdive.ai';
const SEED_PASSWORD = 'User123456!';

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as { userCount?: number };
      if ((body.userCount ?? 0) >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

function resetLoginLimiter(): void {
  (loginRateLimiter as any).resetKey(ipKeyGenerator('127.0.0.1'));
}

/** 取响应里名为 session_token 的 Set-Cookie 原文（可能有多条） */
function sessionSetCookie(res: Response): string {
  const all = res.headers.getSetCookie();
  const found = all.find((c) => c.startsWith('session_token='));
  assert.ok(found, `应下发 session_token cookie，实际：${JSON.stringify(all)}`);
  return found;
}

async function signIn(): Promise<Response> {
  resetLoginLimiter();
  return fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD }),
  });
}

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  await waitSeeds();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('会话 cookie 属性契约（#0013 / ADR-0020）', () => {
  test('登录 cookie：HttpOnly + SameSite=Lax + Path=/ + 无 Domain + 7 天', async () => {
    const res = await signIn();
    assert.equal(res.status, 200);
    const cookie = sessionSetCookie(res);

    assert.match(cookie, /HttpOnly/i, 'HttpOnly 缺失 → JS 可读会话令牌');
    assert.match(cookie, /SameSite=Lax/i, 'SameSite=Lax 缺失/被改 → CSRF 防线失守');
    assert.match(cookie, /Path=\//i, 'Path 必须为 /，否则部分路径带不上 cookie');
    assert.doesNotMatch(cookie, /Domain=/i, '不得设 Domain：host-only cookie 才不向父域泄漏');
    assert.match(cookie, /Max-Age=604800/i, '有效期应为 7 天（与 sessions.expires_at 同口径）');
  });

  test('非生产不带 Secure（本地 http 要能收发 cookie）', async () => {
    assert.notEqual(process.env.NODE_ENV, 'production', '本套件默认跑在非生产模式');
    const cookie = sessionSetCookie(await signIn());
    assert.doesNotMatch(cookie, /;\s*Secure/i);
  });

  /**
   * 属性必须在**调用时**求值：`dotenv.config()` 晚于所有 import，
   * 模块级常量读 NODE_ENV 会恒为 undefined（CODEBUDDY「dotenv 时序坑」）。
   */
  test('生产模式带上 Secure（属性运行期求值，不受模块加载时序影响）', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const cookie = sessionSetCookie(await signIn());
      assert.match(cookie, /;\s*Secure/i, '生产必须带 Secure');
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  test('登出清空 cookie，且属性与下发时一致（不留属性更弱的清除头）', async () => {
    const cookie = sessionSetCookie(await signIn());
    const authCookie = cookie.split(';')[0];

    const res = await fetch(`${base}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: authCookie, 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 200);

    const cleared = sessionSetCookie(res);
    assert.match(cleared, /^session_token=;/, '清除 cookie 必须置空值');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/i, '清除 cookie 必须带过期时间');
    assert.match(cleared, /HttpOnly/i);
    assert.match(cleared, /SameSite=Lax/i);
    assert.match(cleared, /Path=\//i);
  });
});
