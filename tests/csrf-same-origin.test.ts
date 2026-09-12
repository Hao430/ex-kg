/**
 * 技术债 #0013 / ADR-0020 —— 变更方法同源守卫 + form-urlencoded 收窄
 *
 * 锁住三件事：
 * 1. **浏览器跨站变更请求被拒**（Origin 不在白名单 / `Sec-Fetch-Site: cross-site` / Referer 推导跨站）；
 * 2. **非浏览器客户端契约**——不带 Origin 的请求一律放行（curl、服务端调用、支付宝回调，
 *    以及全部既有测试都不带 Origin；一刀切会把整套测试打红，而浏览器跨站请求必带 Origin）；
 * 3. **守卫只管变更方法**：GET/HEAD/OPTIONS 不受影响（两个改状态的 GET 走不可猜 token 自保，
 *    见 ADR-0020「已接受」段）。
 *
 * 探测路径用 `/api/__csrf-probe`（无对应路由）：守卫拦下 → 403；放行 → 落到 Express 默认 404。
 * 用「403 vs 非 403」判别，避免被下游限流器/鉴权的状态码干扰。
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
const EVIL_ORIGIN = 'https://evil.example.com';
const PROBE = '/api/__csrf-probe';

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

/** 打探测路径；返回状态码与响应体 */
async function probe(
  method: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${base}${PROBE}`, { method, headers });
  let code: string | undefined;
  try {
    code = ((await res.json()) as { code?: string }).code;
  } catch { /* 404 空体 */ }
  return { status: res.status, code };
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

describe('变更方法同源守卫（#0013 / ADR-0020）', () => {
  test('跨站 Origin 的变更请求 → 403 CSRF_ORIGIN_REJECTED', async () => {
    const res = await probe('POST', { Origin: EVIL_ORIGIN });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'CSRF_ORIGIN_REJECTED');
  });

  test('全部变更方法一律受管（POST/PUT/PATCH/DELETE）', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await probe(method, { Origin: EVIL_ORIGIN });
      assert.equal(res.status, 403, `${method} 应被同源守卫拦下`);
      assert.equal(res.code, 'CSRF_ORIGIN_REJECTED');
    }
  });

  test('同源 Origin（req.protocol://host）→ 放行', async () => {
    const res = await probe('POST', { Origin: base });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 404); // 落到路由层，说明守卫放行
  });

  test('不带 Origin → 放行（非浏览器客户端契约）', async () => {
    const res = await probe('POST');
    assert.equal(res.status, 404);
  });

  test('Sec-Fetch-Site: cross-site → 403（即便 Origin 缺失）', async () => {
    const res = await probe('POST', { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'CSRF_ORIGIN_REJECTED');
  });

  test('Sec-Fetch-Site: same-origin → 放行', async () => {
    const res = await probe('POST', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(res.status, 404);
  });

  test('Referer 推导出的跨站来源 → 403', async () => {
    const res = await probe('POST', { Referer: `${EVIL_ORIGIN}/attack.html` });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'CSRF_ORIGIN_REJECTED');
  });

  test('Referer 同源 → 放行', async () => {
    const res = await probe('POST', { Referer: `${base}/board` });
    assert.equal(res.status, 404);
  });

  test('Origin 优先于 Referer：两者都在且 Origin 同源 → 放行', async () => {
    const res = await probe('POST', { Origin: base, Referer: `${EVIL_ORIGIN}/x.html` });
    assert.equal(res.status, 404);
  });

  test('GET 带跨站 Origin → 放行（守卫只作用于变更方法）', async () => {
    const res = await probe('GET', { Origin: EVIL_ORIGIN });
    assert.notEqual(res.status, 403);
  });

  test('APP_URL 配置的 origin 视为同源；其他 origin 仍被拒', async () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://app.arborize.example';
    try {
      const ok = await probe('POST', { Origin: 'https://app.arborize.example' });
      assert.notEqual(ok.status, 403, 'APP_URL 声明的 origin 应放行');

      const bad = await probe('POST', { Origin: 'https://app.arborize.example.evil.com' });
      assert.equal(bad.status, 403, '前缀相似但 origin 不同的地址必须拒绝');
      assert.equal(bad.code, 'CSRF_ORIGIN_REJECTED');
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });

  test('真实变更端点：跨站 Origin 被拒、无 Origin 正常进入业务逻辑', async () => {
    resetLoginLimiter();
    const crossSite = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: EVIL_ORIGIN },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(crossSite.status, 403, '正确凭据 + 跨站来源也必须被拒');
    assert.equal(((await crossSite.json()) as any).code, 'CSRF_ORIGIN_REJECTED');

    // 同源与无 Origin 两条路径都必须正常走到鉴权（200）
    for (const headers of [
      { 'Content-Type': 'application/json', Origin: base },
      { 'Content-Type': 'application/json' },
    ]) {
      resetLoginLimiter();
      const res = await fetch(`${base}/api/auth/sign-in`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
      });
      assert.equal(res.status, 200, `应正常登录（headers=${JSON.stringify(headers)}）`);
    }
  });
});

describe('form-urlencoded 收窄到支付宝通知单端点（#0013 加固项）', () => {
  test('表单编码打到 JSON 端点不再被解析（此前全局挂载会成功登录）', async () => {
    resetLoginLimiter();
    const form = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=user%40deepdive.ai&password=User123456!',
    });
    assert.equal(form.status, 400, '未解析 body → zod 校验失败，绝不能是 200');

    resetLoginLimiter();
    const json = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(json.status, 200, '同一凭据走 JSON 必须成功——两条路径对照');
  });

  test('通知端点仍接受表单编码（路由可达，不因收窄而 415/400）', async () => {
    const res = await fetch(`${base}/api/subscriptions/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'out_trade_no=none&trade_status=TRADE_SUCCESS',
    });
    // 未配 ALIPAY 三要素 → mock 渠道，验签前置直接 'fail'；此处只证明端点未被收窄误伤。
    // 表单体真被解析的完整证据在 tests/alipay-payment.test.ts（对已解析参数验签）。
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'fail');
  });
});
