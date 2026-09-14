/**
 * 支付宝电脑网站支付链路（ADR-0014）——资金安全核心用例
 *
 * tests/ 只读豁免：用户 2026-09-10 显式授权新增本文件（接入支付宝支付）。
 *
 * 测试策略：不打真实网关、不 mock SDK 内部逻辑——
 * - 用 crypto.generateKeyPairSync 生成测试 RSA2 密钥对：应用私钥给 SDK 签请求，
 *   同一对私钥在测试侧扮演「支付宝」签 notify 与网关响应，SDK 用配置的
 *   ALIPAY_ALIPAY_PUBLIC_KEY（= 测试公钥）验签——全链路真实签名/验签代码路径；
 * - ALIPAY_GATEWAY 指向本地假网关（http.createServer），按 fixture 返回 v3 查单响应
 *   （含 alipay-timestamp/nonce/signature 响应头，SDK 会真实验签）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { subscriptionRateLimiter } from '../server/middleware/auth.js';
import { ipKeyGenerator } from 'express-rate-limit';

// —— 测试密钥对与环境（必须在首个支付请求前就位：getAlipayProvider 懒初始化单例）——
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.PAYMENT_ENABLED = 'true';
process.env.ALIPAY_APP_ID = 'test-app-id';
process.env.ALIPAY_PRIVATE_KEY = privateKey;
process.env.ALIPAY_ALIPAY_PUBLIC_KEY = publicKey;
// ALIPAY_GATEWAY 在 before() 里指向本地假网关（端口 listen 后可知）

function signWithPrivateKey(content: string): string {
  return crypto.createSign('RSA-SHA256').update(content, 'utf-8').sign(privateKey, 'base64');
}

/** 本地假网关：alipay.trade.query fixture（null 时返回 TRADE_NOT_EXIST 错误码） */
let gateway: http.Server;
let gatewayQueryFixture: { trade_status?: string; total_amount?: string } | null = null;

let server: http.Server;
let base = '';
let userCookie = '';

/** 复位订阅限流器（/notify 不挂限流器，无需复位） */
function resetSubLimiter(): void {
  subscriptionRateLimiter.resetKey(ipKeyGenerator('127.0.0.1'));
}

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

/**
 * 构造支付宝异步通知表单（测试私钥真实签名，签名串规则与 SDK notifyRSACheck 一致：
 * 除 sign 外按 key ASCII 排序 k=v&…）。overrides 用于构造合法签名但参数异常的场景。
 */
function buildNotifyForm(orderNo: string, totalAmount: string, overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    app_id: 'test-app-id',
    trade_no: '2026091022001400001234',
    out_trade_no: orderNo,
    total_amount: totalAmount,
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'RSA2',
    ...overrides,
  };
  const signContent = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const sign = signWithPrivateKey(signContent);
  return new URLSearchParams({ ...params, sign }).toString();
}

async function postNotify(formBody: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/api/subscriptions/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  return { status: res.status, text: await res.text() };
}

async function startOrder(plan: string): Promise<{ orderNo: string; payUrl: string }> {
  const res = await fetch(`${base}/api/subscriptions/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: userCookie },
    body: JSON.stringify({ plan }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as any;
  return { orderNo: body.orderNo, payUrl: body.payUrl };
}

async function getMe(): Promise<any> {
  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie } });
  return (await res.json()) as any;
}

describe('支付宝支付链路（ADR-0014）', () => {
  before(async () => {
    // 本地假网关：POST /v3/alipay/trade/query → 签名 fixture（SDK 会对响应验签）
    gateway = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/v3/alipay/trade/query')) {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          const body = gatewayQueryFixture
            ? JSON.stringify(gatewayQueryFixture)
            : JSON.stringify({ code: 'ACQ.TRADE_NOT_EXIST', message: 'trade not exist' });
          const ts = String(Date.now());
          const nonce = crypto.randomUUID();
          res.writeHead(200, {
            'content-type': 'application/json',
            'alipay-timestamp': ts,
            'alipay-nonce': nonce,
            'alipay-signature': signWithPrivateKey(`${ts}\n${nonce}\n${body}\n`),
          });
          res.end(body);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    process.env.ALIPAY_GATEWAY = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
    resetSubLimiter();

    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@deepdive.ai', password: 'User123456!' }),
    });
    assert.equal(res.status, 200);
    userCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => gateway.close(() => resolve())),
  ]));

  test('下单 → 支付宝收银台跳转 URL（网关/接口名/商品码/订单号/金额齐全）', async () => {
    resetSubLimiter();
    const { payUrl } = await startOrder('weekly');
    assert.ok(payUrl.includes('/gateway.do'));
    assert.ok(payUrl.includes('alipay.trade.page.pay'));
    const decoded = decodeURIComponent(payUrl);
    assert.ok(decoded.includes('FAST_INSTANT_TRADE_PAY'));
    assert.ok(decoded.includes('9.90'));
    const orderNo = new URL(payUrl).searchParams.get('out_trade_no') || (decoded.match(/out_trade_no["=:]+([^&"]+)/)?.[1] ?? '');
    assert.ok(orderNo.startsWith('ORD-'), `payUrl 应携带 out_trade_no，实际 ${decoded}`);
  });

  test('合法签名 notify → success，订单 paid、VIP 生效', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('weekly');
    const { status, text } = await postNotify(buildNotifyForm(orderNo, '9.90'));
    assert.equal(status, 200);
    assert.equal(text, 'success');

    const st = await (await fetch(`${base}/api/subscriptions/orders/${orderNo}`, {
      headers: { cookie: userCookie },
    })).json() as any;
    assert.equal(st.order.status, 'paid');
    const me = await getMe();
    assert.equal(me.user.entitlements.plan, 'vip');
  });

  test('金额篡改（签名合法但金额不符）→ fail 且订单仍 pending', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    // 攻击者重写金额为 0.01 并重签（签名合法绕过验签，但与订单金额不符）
    const { status, text } = await postNotify(buildNotifyForm(orderNo, '0.01'));
    assert.equal(status, 200);
    assert.equal(text, 'fail');

    const st = await (await fetch(`${base}/api/subscriptions/orders/${orderNo}`, {
      headers: { cookie: userCookie },
    })).json() as any;
    assert.equal(st.order.status, 'pending');
  });

  test('签名非法（字段被篡改未重签）→ fail', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    // 先构造合法签名，再把金额改掉（签名不再匹配）
    const legit = buildNotifyForm(orderNo, '24.90');
    const tampered = legit.replace('total_amount=24.90', 'total_amount=0.01');
    assert.notEqual(tampered, legit);
    const { text } = await postNotify(tampered);
    assert.equal(text, 'fail');
  });

  test('app_id 不匹配（签名合法）→ fail', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    const { status, text } = await postNotify(buildNotifyForm(orderNo, '24.90', { app_id: 'evil-app-id' }));
    assert.equal(status, 200);
    assert.equal(text, 'fail');
  });

  test('幂等：同一 notify 重发两次 → 均 success，VIP 有效期不重复叠期', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    const first = await postNotify(buildNotifyForm(orderNo, '24.90'));
    assert.equal(first.text, 'success');
    const meAfterFirst = await getMe();
    const expiryAfterFirst = meAfterFirst.user.vip_expires_at;

    const second = await postNotify(buildNotifyForm(orderNo, '24.90'));
    assert.equal(second.text, 'success');
    const meAfterSecond = await getMe();
    assert.equal(meAfterSecond.user.vip_expires_at, expiryAfterFirst, '重复通知不得重复叠期');
  });

  test('查单对账兜底：notify 未到达时，查单接口主动同步 TRADE_SUCCESS → paid 并激活', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    gatewayQueryFixture = { trade_status: 'TRADE_SUCCESS', total_amount: '24.90' };
    try {
      const st = await (await fetch(`${base}/api/subscriptions/orders/${orderNo}`, {
        headers: { cookie: userCookie },
      })).json() as any;
      assert.equal(st.order.status, 'paid');
      const me = await getMe();
      assert.equal(me.user.entitlements.plan, 'vip');
    } finally {
      gatewayQueryFixture = null;
    }
  });

  test('查单兜底：官方侧 TRADE_CLOSED → 本地置 failed', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    gatewayQueryFixture = { trade_status: 'TRADE_CLOSED', total_amount: '24.90' };
    try {
      const st = await (await fetch(`${base}/api/subscriptions/orders/${orderNo}`, {
        headers: { cookie: userCookie },
      })).json() as any;
      assert.equal(st.order.status, 'failed');
    } finally {
      gatewayQueryFixture = null;
    }
  });

  /**
   * 资金安全回归（2026-09-14）：mock-pay 曾只挡 NODE_ENV=production，与生效渠道无关。
   * 预发/灰度/忘了设 NODE_ENV=production 的线上，支付宝已是生效渠道，用户仍可对自己的
   * pending 单 POST 一次就自助开通 VIP（实测 200 + VIP 生效）。判据改为「渠道就是 mock」。
   */
  test('支付宝渠道生效时 mock-pay 不可达 → 404 且订单保持 pending（防自助开通）', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');

    const pay = await fetch(`${base}/api/subscriptions/orders/${orderNo}/mock-pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: userCookie },
    });
    assert.equal(pay.status, 404, '支付宝渠道下 mock-pay 必须不可达');

    const st = await (await fetch(`${base}/api/subscriptions/orders/${orderNo}`, {
      headers: { cookie: userCookie },
    })).json() as any;
    assert.equal(st.order.status, 'pending', '自助开通不得发生，订单必须仍是 pending');
  });

  test('非成功态 notify（TRADE_CLOSED）→ success 但不激活（查单兜底负责终态）', async () => {
    resetSubLimiter();
    const { orderNo } = await startOrder('monthly');
    const { text } = await postNotify(buildNotifyForm(orderNo, '24.90', { trade_status: 'TRADE_CLOSED' }));
    assert.equal(text, 'success');
    const st = await (await fetch(`${base}/api/subscriptions/orders/${orderNo}`, {
      headers: { cookie: userCookie },
    })).json() as any;
    assert.equal(st.order.status, 'pending');
  });
});
