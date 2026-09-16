/**
 * ADR-0023 — 账号绑定（微信 ↔ 邮箱，单向）
 *
 * 覆盖面：回调的「有会话 = 绑定」分支（含幂等、抢绑他人微信、一账号一微信）、
 * 补绑邮箱全链路（不设密码、email_verified 保持 true、会话不踢、全站唯一性预检）、
 * 绑定后的找回密码、运营台解绑逃生舱、限流与审计。
 *
 * 出站 HTTP 由 fetch 分发器 stub（`api.weixin.qq.com` 命中即应答，其余透传），测试不触网。
 * 先例：tests/wechat-login.test.ts。
 *
 * 注：用户已授权本次新增 tests/（只读约定豁免）。
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { getOutboxForTest } from '../server/lib/mailer.js';
import { getAuditLogsForTest } from '../server/repositories/audit.repository.js';
import { findUserByEmail } from '../server/repositories/user.repository.js';
import { findOAuthIdentityByUserId } from '../server/repositories/oauth.repository.js';
import {
  wechatAuthorizeRateLimiter,
  wechatCallbackRateLimiter,
  bindEmailSendCodeRateLimiter,
  bindEmailRateLimiter,
  signupRateLimiter,
  sendRegisterCodeRateLimiter,
  loginRateLimiter,
} from '../server/middleware/auth.js';

let server: http.Server;
let base = '';

const TEST_IP = ipKeyGenerator('127.0.0.1');
const origFetch = globalThis.fetch;

let wxTokenReply: any = { access_token: 'AT', openid: 'OPENID', unionid: 'UNIONID' };
let wxUserinfoReply: any = { openid: 'OPENID', nickname: '微信小明' };
let wxCalls = 0;

function resetLimiters(): void {
  for (const l of [
    wechatAuthorizeRateLimiter,
    wechatCallbackRateLimiter,
    bindEmailSendCodeRateLimiter,
    bindEmailRateLimiter,
    signupRateLimiter,
    sendRegisterCodeRateLimiter,
    loginRateLimiter,
  ]) {
    (l as any).resetKey(TEST_IP);
    (l as any).resetKey('user_00000000-0000-0000-0000-000000000001');
  }
}

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.userCount >= 3) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

async function userCount(): Promise<number> {
  const res = await fetch(`${base}/api/db/status`);
  return ((await res.json()) as any).userCount;
}

function cookieValue(res: Response, name: string): string | null {
  const headers = res.headers as any;
  const all: string[] =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const c of all) {
    if (c.startsWith(`${name}=`)) return c.split(';')[0];
  }
  return null;
}

async function me(cookie: string): Promise<any> {
  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal(res.status, 200, '/me 应 200');
  return ((await res.json()) as any).user;
}

/** 提取某邮箱最新一封指定主题的验证码邮件里的 6 位码 */
function extractCode(email: string, subject: string): string {
  const mail = getOutboxForTest().find((m) => m.to === email && m.subject === subject);
  assert.ok(mail, `应发出「${subject}」邮件（${email}）`);
  const match = mail.text?.match(/\b(\d{6})\b/);
  assert.ok(match, '邮件应含 6 位数字验证码');
  return match![1];
}

async function registerEmailUser(
  tag: string,
  password = 'Pass123456'
): Promise<{ email: string; cookie: string; userId: string }> {
  const email = `bind-${tag}@example.com`;
  const send = await fetch(`${base}/api/auth/send-register-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(send.status, 200, `send-register-code ${email}`);
  const code = extractCode(email, '枝想 注册验证码');

  const res = await fetch(`${base}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, code, name: '绑定用例' }),
  });
  assert.equal(res.status, 201, `sign-up ${email}`);
  const body = (await res.json()) as any;
  const cookie = cookieValue(res, 'session_token');
  assert.ok(cookie, 'sign-up 应下发会话 cookie');
  return { email, cookie: cookie!, userId: body.user.id };
}

async function startAuthorize(): Promise<{ state: string; stateCookie: string }> {
  const res = await fetch(`${base}/api/auth/wechat/authorize`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const state = new URL(res.headers.get('location') || '').searchParams.get('state') || '';
  const stateCookie = cookieValue(res, 'wechat_oauth_state');
  assert.ok(state && stateCookie, 'authorize 应给出 state 并种下 cookie');
  return { state, stateCookie };
}

/** 带任意 cookie 组合访问回调 */
async function callback(
  params: { code?: string; state?: string },
  cookie?: string
): Promise<Response> {
  const qs = new URLSearchParams();
  if (params.code !== undefined) qs.set('code', params.code);
  if (params.state !== undefined) qs.set('state', params.state);
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}/api/auth/wechat/callback?${qs.toString()}`, { redirect: 'manual', headers });
}

function useWechatIdentity(tag: string, nickname = `微信-${tag}`): string {
  const openid = `OPENID-${tag}`;
  wxTokenReply = { access_token: `AT-${tag}`, openid, unionid: `UNIONID-${tag}` };
  wxUserinfoReply = { openid, nickname };
  return openid;
}

/** 以**未登录**身份走一次微信登录（自动建号），返回会话与账号 */
async function loginWechatOnly(tag: string): Promise<{ cookie: string; userId: string; email: string }> {
  useWechatIdentity(tag);
  const { state, stateCookie } = await startAuthorize();
  const res = await callback({ code: `LOGIN-${tag}`, state }, stateCookie);
  assert.equal(res.headers.get('location'), '/?wechat=ok', `微信登录应成功（${tag}）`);
  const cookie = cookieValue(res, 'session_token');
  assert.ok(cookie, '微信登录应下发会话 cookie');
  const user = await me(cookie!);
  return { cookie: cookie!, userId: user.id, email: user.email };
}

/** 以**已登录**身份走一次微信授权（应走绑定分支） */
async function bindWechat(sessionCookie: string, tag: string): Promise<Response> {
  useWechatIdentity(tag);
  const { state, stateCookie } = await startAuthorize();
  return callback({ code: `BIND-${tag}`, state }, `${stateCookie}; ${sessionCookie}`);
}

async function sendBindCode(cookie: string, email: string): Promise<Response> {
  return fetch(`${base}/api/auth/bind-email/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ email }),
  });
}

async function submitBind(cookie: string, email: string, code: string): Promise<Response> {
  return fetch(`${base}/api/auth/bind-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ email, code }),
  });
}

describe('ADR-0023 账号绑定', () => {
  before(async () => {
    process.env.WECHAT_APP_ID = 'wx_test_appid';
    process.env.WECHAT_APP_SECRET = 'wx_test_secret';

    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('api.weixin.qq.com')) {
        wxCalls++;
        const body = url.includes('/sns/oauth2/access_token') ? wxTokenReply : wxUserinfoReply;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return origFetch(input, init);
    };

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await waitSeeds();
  });

  after(() => {
    (globalThis as any).fetch = origFetch;
    delete process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_SECRET;
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetLimiters();
    wxCalls = 0;
    wxTokenReply = { access_token: 'AT', openid: 'OPENID', unionid: 'UNIONID' };
    wxUserinfoReply = { openid: 'OPENID', nickname: '微信小明' };
  });

  test('新邮箱账号 /me：wechat_bound 为 false', async () => {
    const { cookie } = await registerEmailUser('me');
    const user = await me(cookie);
    assert.equal(user.wechat_bound, false);
    assert.equal(user.wechat_nickname, null);
    assert.equal(user.email_placeholder, false);
    assert.equal(user.has_password, true);
  });

  test('已登录 + 未绑微信 → 绑到当前账号：不建号、不换会话', async () => {
    const { cookie, userId } = await registerEmailUser('bind-ok');
    const before = await userCount();

    const res = await bindWechat(cookie, 'bind-ok');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?wechat=bound');
    assert.equal(cookieValue(res, 'session_token'), null, '绑定分支不得下发新会话');
    assert.equal(await userCount(), before, '绑定不得建账号');

    const user = await me(cookie);
    assert.equal(user.id, userId, '仍是同一个账号');
    assert.equal(user.wechat_bound, true);
    assert.equal(user.wechat_nickname, '微信-bind-ok');

    const identity = await findOAuthIdentityByUserId(userId, 'wechat');
    assert.equal(identity?.openid, 'OPENID-bind-ok');
  });

  test('重复绑同一个微信：幂等，不重复插行、不重复审计', async () => {
    const { cookie, userId } = await registerEmailUser('bind-twice');
    assert.equal((await bindWechat(cookie, 'bind-twice')).headers.get('location'), '/?wechat=bound');
    const auditAfterFirst = getAuditLogsForTest().filter((l) => l.action === 'wechat_bind').length;

    assert.equal((await bindWechat(cookie, 'bind-twice')).headers.get('location'), '/?wechat=bound');

    const rows = [...getAuditLogsForTest()].filter((l) => l.action === 'wechat_bind').length;
    assert.equal(rows, auditAfterFirst, '幂等重复不得再记一条 wechat_bind');
    assert.ok(await findOAuthIdentityByUserId(userId, 'wechat'));
  });

  test('该微信已绑别的账号 → 拒绝，不改绑、不换会话', async () => {
    const a = await registerEmailUser('owner-a');
    const b = await registerEmailUser('victim-b');

    assert.equal((await bindWechat(a.cookie, 'shared')).headers.get('location'), '/?wechat=bound');

    const before = await userCount();
    const res = await bindWechat(b.cookie, 'shared');
    assert.equal(res.headers.get('location'), '/?wechat_bind_error=WECHAT_ALREADY_BOUND');
    assert.equal(cookieValue(res, 'session_token'), null);
    assert.equal(await userCount(), before);

    // B 仍是 B（没被登进 A），A 的绑定没被动
    assert.equal((await me(b.cookie)).id, b.userId);
    const boundToA = await findOAuthIdentityByUserId(a.userId, 'wechat');
    assert.equal(boundToA?.openid, 'OPENID-shared');
    assert.equal(await findOAuthIdentityByUserId(b.userId, 'wechat'), null);
  });

  test('一账号只允许一个微信身份：已绑一个再绑另一个 → 拒绝', async () => {
    const { cookie, userId } = await registerEmailUser('one-wechat');
    assert.equal((await bindWechat(cookie, 'first-wx')).headers.get('location'), '/?wechat=bound');

    const res = await bindWechat(cookie, 'second-wx');
    assert.equal(res.headers.get('location'), '/?wechat_bind_error=WECHAT_ALREADY_BOUND');
    assert.equal((await findOAuthIdentityByUserId(userId, 'wechat'))?.openid, 'OPENID-first-wx');
  });

  test('无会话首登仍走登录路径：回跳恰好 /?wechat=ok 且下发会话', async () => {
    const first = await loginWechatOnly('plain');
    assert.match(first.email, /^wx_[0-9a-f]{32}@wechat\.invalid$/);

    const before = await userCount();
    const second = await loginWechatOnly('plain');
    assert.equal(second.userId, first.userId, '同一 openid 回到同一账号');
    assert.equal(await userCount(), before);
  });

  test('失效会话 cookie：回落为登录（有意接受的行为）', async () => {
    const stale = 'session_token=deadbeefdeadbeefdeadbeefdeadbeef';
    const { state, stateCookie } = await startAuthorize();
    useWechatIdentity('stale');
    const res = await callback({ code: 'STALE', state }, `${stateCookie}; ${stale}`);
    assert.equal(res.headers.get('location'), '/?wechat=ok', '失效会话应按登录处理');
    assert.ok(cookieValue(res, 'session_token'), '应下发新会话');
  });

  test('有会话但 state 不匹配：回 STATE 且零外呼', async () => {
    const { cookie } = await registerEmailUser('state');
    const { state, stateCookie } = await startAuthorize();
    wxCalls = 0;
    const res = await callback({ code: 'X', state: `${state}x` }, `${stateCookie}; ${cookie}`);
    assert.equal(res.headers.get('location'), '/?wechat_error=STATE');
    assert.equal(wxCalls, 0);
  });

  test('审计：绑定记 wechat_bind 且带真实 userId', async () => {
    const { cookie, userId } = await registerEmailUser('audit');
    await bindWechat(cookie, 'audit');
    const entry = getAuditLogsForTest().find((l) => l.action === 'wechat_bind');
    assert.ok(entry, '应记录 wechat_bind');
    assert.equal(entry!.user_id, userId, '必须带真实 userId（不能是失败通道的 null 形状）');
  });

  test('send-code：未登录 401', async () => {
    const res = await fetch(`${base}/api/auth/bind-email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noauth@example.com' }),
    });
    assert.equal(res.status, 401);
  });

  test('send-code：占位域被拒（仅占位账号能走到这一步）', async () => {
    const wx = await loginWechatOnly('sendcode-reserved');
    const reserved = await sendBindCode(wx.cookie, 'someone@wechat.invalid');
    assert.equal(reserved.status, 400);
    assert.equal(((await reserved.json()) as any).code, 'EMAIL_DOMAIN_RESERVED');
  });

  test('send-code：已注册邮箱 409 / 60s 冷却 429 / 顺利路径发对主题的邮件', async () => {
    const wx = await loginWechatOnly('sendcode');
    const target = 'fresh-target@example.com';

    const taken = await sendBindCode(wx.cookie, 'user@deepdive.ai');
    assert.equal(taken.status, 409);
    assert.equal(((await taken.json()) as any).code, 'EMAIL_EXISTS');

    const ok = await sendBindCode(wx.cookie, target);
    assert.equal(ok.status, 200);
    // 邮件主题必须与注册验证码区分开
    const mail = getOutboxForTest().find((m) => m.to === target);
    assert.equal(mail?.subject, '枝想 邮箱绑定验证码');

    const again = await sendBindCode(wx.cookie, target);
    assert.equal(again.status, 429);
    assert.equal(((await again.json()) as any).code, 'CODE_COOLDOWN');
  });

  test('send-code：真实邮箱账号根本无法补绑（不做换绑）', async () => {
    const { cookie } = await registerEmailUser('sendcode-real');
    const res = await sendBindCode(cookie, 'fresh-for-real@example.com');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'EMAIL_ALREADY_BOUND');
  });

  test('补绑邮箱顺利路径：占位邮箱账号绑真实邮箱，不设密码、不改验证状态、不踢会话', async () => {
    const wx = await loginWechatOnly('bindemail');
    const target = 'wx-bound-target@example.com';

    assert.equal((await sendBindCode(wx.cookie, target)).status, 200);
    const code = extractCode(target, '枝想 邮箱绑定验证码');

    const res = await submitBind(wx.cookie, target, code);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as any;
    assert.equal(body.user.email, target);
    assert.equal(body.user.email_placeholder, false);
    assert.equal(body.user.email_verified, true, '绑定的邮箱已被验证码证明归属，必须保持 true');
    assert.equal(body.user.has_password, false, '本口径只绑邮箱，不设密码');

    // 会话未变（「新增凭据不踢会话」）
    const user = await me(wx.cookie);
    assert.equal(user.id, wx.userId);
    assert.equal(user.email, target);

    // 旧占位邮箱已不存在
    assert.equal(await findUserByEmail(wx.email), null, '占位邮箱应已被替换');

    // 仍无密码 → 邮箱+任意口令登录失败
    const signin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: target, password: 'Pass123456' }),
    });
    assert.equal(signin.status, 401);
  });

  test('已是真实邮箱的账号不能补绑（不做换绑）', async () => {
    const { cookie } = await registerEmailUser('real-email');
    const res = await sendBindCode(cookie, 'another@example.com');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'EMAIL_ALREADY_BOUND');

    const submit = await submitBind(cookie, 'another@example.com', '123456');
    assert.equal(submit.status, 400);
    assert.equal(((await submit.json()) as any).code, 'EMAIL_ALREADY_BOUND');
  });

  test('验证码错误：带剩余次数；连错 5 次作废', async () => {
    const wx = await loginWechatOnly('badcode');
    const target = 'wx-badcode@example.com';
    assert.equal((await sendBindCode(wx.cookie, target)).status, 200);

    for (let i = 1; i <= 4; i++) {
      const res = await submitBind(wx.cookie, target, '000000');
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.code, 'INVALID_CODE');
      assert.match(String(body.error), new RegExp(`还可尝试 ${5 - i} 次`), `第 ${i} 次的剩余次数`);
    }
    // 第 5 次：码作废
    const fifth = await submitBind(wx.cookie, target, '000000');
    assert.equal(fifth.status, 400);
    assert.match(String(((await fifth.json()) as any).error), /次数过多/);
    // 作废后即使拿对的码也不行（码已销毁）——此处只断言状态仍是 400
    assert.equal((await submitBind(wx.cookie, target, '000000')).status, 400);
  });

  test('目标邮箱已被他人注册：409（证明唯一性预检真的跨租户生效）', async () => {
    const wx = await loginWechatOnly('taken');
    const res = await submitBind(wx.cookie, 'user@deepdive.ai', '123456');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).code, 'EMAIL_EXISTS');
  });

  test('目标为占位域：即使验证码正确也拒（纵深防御）', async () => {
    const wx = await loginWechatOnly('reserved');
    const res = await submitBind(wx.cookie, 'wx_whatever@wechat.invalid', '123456');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).code, 'EMAIL_DOMAIN_RESERVED');
  });

  test('绑完邮箱后可用「忘记密码」自助设置密码并邮箱登录', async () => {
    const wx = await loginWechatOnly('recover');
    const target = 'wx-recover@example.com';
    assert.equal((await sendBindCode(wx.cookie, target)).status, 200);
    assert.equal((await submitBind(wx.cookie, target, extractCode(target, '枝想 邮箱绑定验证码'))).status, 200);

    const forgot = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: target }),
    });
    assert.equal(forgot.status, 200);

    const mail = getOutboxForTest().find((m) => m.to === target && m.subject.includes('重置'));
    assert.ok(mail, '应收到重置密码邮件');
    const token = (mail!.text || '').match(/token=([a-f0-9]+)/)?.[1];
    assert.ok(token, '重置邮件应含 token');

    const reset = await fetch(`${base}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'BrandNew123' }),
    });
    assert.equal(reset.status, 200);

    const signin = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: target, password: 'BrandNew123' }),
    });
    assert.equal(signin.status, 200, '设密后应能用邮箱+密码登录');
  });

  test('审计 email_bind 只记前后邮箱，不含验证码', async () => {
    const wx = await loginWechatOnly('audit-email');
    const target = 'wx-audit@example.com';
    assert.equal((await sendBindCode(wx.cookie, target)).status, 200);
    const code = extractCode(target, '枝想 邮箱绑定验证码');
    assert.equal((await submitBind(wx.cookie, target, code)).status, 200);

    // 审计是全局数组，必须按本次的 newEmail 定位，否则会命中前一个用例留下的记录
    const entry = getAuditLogsForTest().find(
      (l) => l.action === 'email_bind' && (l.details as any)?.newEmail === target
    );
    assert.ok(entry, '应记录 email_bind');
    assert.equal((entry!.details as any).newEmail, target);
    assert.match(String((entry!.details as any).oldEmail), /@wechat\.invalid$/);
    assert.ok(!JSON.stringify(entry!.details).includes(code), '审计不得含验证码');
  });

  test('运营台解绑：admin 200 且行消失、/me 变未绑；非 admin 403；重复解绑 404', async () => {
    const { cookie, userId } = await registerEmailUser('unbind');
    assert.equal((await bindWechat(cookie, 'unbind-wx')).headers.get('location'), '/?wechat=bound');
    assert.equal((await me(cookie)).wechat_bound, true);

    const forbidden = await fetch(`${base}/api/admin/users/${userId}/oauth/wechat`, {
      method: 'DELETE',
      headers: { cookie }, // 普通用户
    });
    assert.equal(forbidden.status, 403);

    const adminSignIn = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
    });
    assert.equal(adminSignIn.status, 200);
    const adminCookie = cookieValue(adminSignIn, 'session_token')!;

    const res = await fetch(`${base}/api/admin/users/${userId}/oauth/wechat`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 200);
    assert.equal(await findOAuthIdentityByUserId(userId, 'wechat'), null);
    assert.equal((await me(cookie)).wechat_bound, false, '/me 应变为未绑');

    const audit = getAuditLogsForTest().find((l) => l.action === 'admin_oauth_unbind');
    assert.ok(audit, '应记录 admin_oauth_unbind');
    assert.equal(audit!.target_id, userId);

    const again = await fetch(`${base}/api/admin/users/${userId}/oauth/wechat`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(again.status, 404);
  });

  test('限流：send-code 超阈值 429（各用不同邮箱以绕开 60s 冷却）', async () => {
    const { cookie } = await registerEmailUser('limit-send');
    let status = 0;
    for (let i = 0; i < 8; i++) {
      const res = await sendBindCode(cookie, `limit-target-${i}@example.com`);
      status = res.status;
      if (status === 429) break;
    }
    assert.equal(status, 429, '超过 5/h 后应 429');
    resetLimiters();
  });

  test('限流：bind-email 超阈值 429', async () => {
    const { cookie } = await registerEmailUser('limit-submit');
    let status = 0;
    for (let i = 0; i < 14; i++) {
      const res = await submitBind(cookie, `nobody-${i}@example.com`, '000000');
      status = res.status;
      if (status === 429) break;
    }
    assert.equal(status, 429, '超过 10/h 后应 429');
    resetLimiters();
  });
});
