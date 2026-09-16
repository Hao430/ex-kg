/**
 * ADR-0022 — 网站应用微信登录（开放平台 OAuth2）
 *
 * 覆盖面：state 双提交 cookie、换 code / 取资料、find-or-create 与并发收敛、
 * 占位账号的三条硬性质（不可密码登录 / 出生即 email_verified / 注册口封杀占位域）、
 * F4 注销后建新号、unionid 同人收敛、昵称清洗、审计、限流。
 *
 * 出站 HTTP 全部由 fetch 分发器 stub（`api.weixin.qq.com` 命中即应答，其余透传），
 * 测试不触网。先例：tests/h2-grounding-chain.test.ts。
 *
 * 注：用户已授权本次新增 tests/（只读约定豁免）。
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import { createApp } from '../server/app.js';
import { inMemoryStore } from '../server/core/memory-store.js';
import { getAuditLogsForTest } from '../server/repositories/audit.repository.js';
import { findUserByEmail, cleanupDeletedUsers } from '../server/repositories/user.repository.js';
import {
  linkOAuthIdentity,
  findOAuthIdentity,
  findOAuthIdentityByUnionid,
} from '../server/repositories/oauth.repository.js';
import { wechatAuthorizeRateLimiter, wechatCallbackRateLimiter } from '../server/middleware/auth.js';

let server: http.Server;
let base = '';

const TEST_IP = ipKeyGenerator('127.0.0.1');
const origFetch = globalThis.fetch;

/** 微信 API stub 的可变应答，每个用例自己摆 */
let wxTokenReply: any = { access_token: 'AT-1', openid: 'OPENID-1', unionid: 'UNIONID-1' };
let wxUserinfoReply: any = { openid: 'OPENID-1', nickname: '微信小明', headimgurl: 'http://thirdwx.qlogo.cn/a/0' };
/** 命中微信 API 的次数——用来证明「state 不匹配时一次外呼都没发」 */
let wxCalls = 0;

function resetLimiters(): void {
  (wechatAuthorizeRateLimiter as any).resetKey(TEST_IP);
  (wechatCallbackRateLimiter as any).resetKey(TEST_IP);
}

/**
 * 摆一组全新的微信身份。**每个「期望建号」的用例都要用自己的 tag**：
 * 内存模式的身份是全局单例，共用 openid 会让后一个用例命中前一个建的账号，
 * 「账号数 +1」之类的断言就会以难以定位的方式失败。
 */
function useFreshWechatIdentity(tag: string): string {
  const openid = `OPENID-${tag}`;
  wxTokenReply = { access_token: `AT-${tag}`, openid, unionid: `UNIONID-${tag}` };
  wxUserinfoReply = { openid, nickname: '微信小明', headimgurl: 'http://thirdwx.qlogo.cn/a/0' };
  return openid;
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

/** 从一次可能带多个 Set-Cookie 的响应里取出指定 cookie 的 `name=value` */
function cookieValue(res: Response, name: string): string | null {
  const headers = res.headers as any;
  const all: string[] =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const c of all) {
    if (c.startsWith(`${name}=`)) return c.split(';')[0];
  }
  return null;
}

/** 走一遍 /authorize，拿到 state 与它种下的 cookie */
async function startAuthorize(): Promise<{ state: string; stateCookie: string; location: string }> {
  const res = await fetch(`${base}/api/auth/wechat/authorize`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'authorize 应是 302');
  const location = res.headers.get('location') || '';
  const state = new URL(location).searchParams.get('state') || '';
  assert.ok(state, 'authorize 必须带上 state');
  const stateCookie = cookieValue(res, 'wechat_oauth_state');
  assert.ok(stateCookie, 'authorize 必须种下 state cookie');
  return { state, stateCookie, location };
}

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

/** 完整登录一次，返回会话 cookie 与用户档案 */
async function loginViaWechat(): Promise<{ sessionCookie: string; user: any; location: string }> {
  const { state, stateCookie } = await startAuthorize();
  const res = await callback({ code: `CODE-${Date.now()}-${Math.random()}`, state }, stateCookie);
  const location = res.headers.get('location') || '';
  assert.equal(location, '/?wechat=ok', `回调应成功，实际 ${location}`);
  const sessionCookie = cookieValue(res, 'session_token');
  assert.ok(sessionCookie, '成功回调必须下发会话 cookie');
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: sessionCookie } });
  const body = (await me.json()) as any;
  return { sessionCookie, user: body.user, location };
}

describe('ADR-0022 微信网站应用登录', () => {
  before(async () => {
    process.env.WECHAT_APP_ID = 'wx_test_appid';
    process.env.WECHAT_APP_SECRET = 'wx_test_secret';

    // fetch 分发器：微信 API 命中即应答，其余（含打向本服务的请求）透传
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
    wxTokenReply = { access_token: 'AT-1', openid: 'OPENID-1', unionid: 'UNIONID-1' };
    wxUserinfoReply = { openid: 'OPENID-1', nickname: '微信小明', headimgurl: 'http://thirdwx.qlogo.cn/a/0' };
  });

  test('authorize：302 到微信扫码页，参数齐备且种下 state cookie', async () => {
    const { location, state } = await startAuthorize();

    const url = new URL(location);
    assert.equal(url.origin + url.pathname, 'https://open.weixin.qq.com/connect/qrconnect');
    assert.equal(url.searchParams.get('appid'), 'wx_test_appid');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'snsapi_login');
    assert.equal(url.searchParams.get('state'), state);
    assert.ok(
      (url.searchParams.get('redirect_uri') || '').endsWith('/api/auth/wechat/callback'),
      'redirect_uri 必须指向本站回调路径'
    );
    assert.ok(location.endsWith('#wechat_redirect'), '微信要求带 #wechat_redirect 锚点');
  });

  test('authorize 种下的 state cookie 属性：HttpOnly / SameSite=Lax / 收窄 path / 10 分钟', async () => {
    const res = await fetch(`${base}/api/auth/wechat/authorize`, { redirect: 'manual' });
    const headers = res.headers as any;
    const raw: string[] =
      typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const stateCookie = raw.find((c) => c.startsWith('wechat_oauth_state='));
    assert.ok(stateCookie, '应有 state cookie');

    assert.match(stateCookie!, /HttpOnly/i);
    assert.match(stateCookie!, /SameSite=Lax/i);
    assert.match(stateCookie!, /Path=\/api\/auth\/wechat/i);
    assert.match(stateCookie!, /Max-Age=600(?!\d)/);
    assert.doesNotMatch(stateCookie!, /Domain=/i, 'host-only：不得设置 Domain');
  });

  test('未配置凭据：authorize 直接回 NOT_CONFIGURED 且零外呼', async () => {
    const appId = process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_ID;
    try {
      const res = await fetch(`${base}/api/auth/wechat/authorize`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/?wechat_error=NOT_CONFIGURED');
      assert.equal(wxCalls, 0);
      assert.equal(cookieValue(res, 'wechat_oauth_state'), null, '未配置时不该种 state cookie');
    } finally {
      process.env.WECHAT_APP_ID = appId;
    }
  });

  test('status：未配置 false / 配置 true', async () => {
    const on = await fetch(`${base}/api/auth/wechat/status`);
    assert.deepEqual(await on.json(), { enabled: true });

    const appId = process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_ID;
    try {
      const off = await fetch(`${base}/api/auth/wechat/status`);
      assert.deepEqual(await off.json(), { enabled: false });
    } finally {
      process.env.WECHAT_APP_ID = appId;
    }
  });

  test('首登：自动建号并登录，占位邮箱 + 出生即 email_verified', async () => {
    useFreshWechatIdentity('first');
    const before = await userCount();
    const { user } = await loginViaWechat();

    assert.equal(await userCount(), before + 1, '首登应恰好建一个新账号');
    assert.equal(user.role, 'user');
    assert.equal(user.email_verified, true, '否则 chat 会被 EMAIL_NOT_VERIFIED 拦死');
    assert.match(user.email, /^wx_[0-9a-f]{32}@wechat\.invalid$/, '占位邮箱口径');
    assert.equal(user.name, '微信小明');
    assert.equal(user.avatar, 'https://thirdwx.qlogo.cn/a/0', '头像 URL 应由 http 归一为 https');
    assert.equal(user.email_placeholder, true);
    assert.equal(user.has_password, false, '纯微信账号没有可用口令');
  });

  test('state 不匹配：回 STATE 且在任何外呼之前就返回', async () => {
    const before = await userCount();
    const { state, stateCookie } = await startAuthorize();
    wxCalls = 0;

    // 1) cookie 缺失
    const noCookie = await callback({ code: 'C1', state }, undefined);
    assert.equal(noCookie.headers.get('location'), '/?wechat_error=STATE');
    // 2) cookie 不匹配
    const wrong = await callback({ code: 'C1', state: `${state}x` }, stateCookie);
    assert.equal(wrong.headers.get('location'), '/?wechat_error=STATE');
    // 3) state 缺失
    const noState = await callback({ code: 'C1' }, stateCookie);
    assert.equal(noState.headers.get('location'), '/?wechat_error=STATE');

    assert.equal(wxCalls, 0, 'state 校验必须先于任何外呼');
    assert.equal(cookieValue(noCookie, 'session_token'), null);
    assert.equal(await userCount(), before, '不得建号');
  });

  test('callback 缺 code：回 STATE，不建号', async () => {
    const before = await userCount();
    const { state, stateCookie } = await startAuthorize();
    const res = await callback({ state }, stateCookie);
    assert.equal(res.headers.get('location'), '/?wechat_error=STATE');
    assert.equal(wxCalls, 0);
    assert.equal(await userCount(), before);
  });

  test('换 code 返回 errcode（HTTP 仍 200）：回 EXCHANGE，不建号', async () => {
    const before = await userCount();
    wxTokenReply = { errcode: 40029, errmsg: 'invalid code' };

    const { state, stateCookie } = await startAuthorize();
    const res = await callback({ code: 'USED-CODE', state }, stateCookie);

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?wechat_error=EXCHANGE');
    assert.equal(cookieValue(res, 'session_token'), null);
    assert.equal(await userCount(), before, '换 code 失败不得建号');
    // 失败原因必须落在服务端审计里（不回显 errmsg）
    const failure = getAuditLogsForTest().find((l) => l.action === 'wechat_login_failed');
    assert.ok(failure, '应记录 wechat_login_failed');
    assert.equal((failure!.details as any).reason, 'EXCHANGE');
    assert.equal((failure!.details as any).errcode, 40029);
  });

  test('取资料失败：降级为「仅 openid」登录，不阻断（拿得到 openid 就该让人进来）', async () => {
    const openid = useFreshWechatIdentity('degrade');
    const before = await userCount();
    wxUserinfoReply = { errcode: 40003, errmsg: 'invalid openid' };

    const { user } = await loginViaWechat();
    assert.equal(await userCount(), before + 1);
    assert.equal(user.name, '微信用户', '取不到昵称应回落默认展示名');
    assert.equal(user.avatar, undefined, '取不到头像则为空');
    assert.equal(user.email_verified, true);
    assert.match(user.email, /^wx_[0-9a-f]{32}@wechat\.invalid$/, `openid=${openid} 仍应建出占位账号`);
  });

  test('同 openid 二次登录：复用同一账号，不新建、不报错', async () => {
    useFreshWechatIdentity('repeat');
    const first = await loginViaWechat();
    const before = await userCount();
    const second = await loginViaWechat();

    assert.equal(second.user.id, first.user.id, '同一 openid 必须回到同一账号');
    assert.equal(await userCount(), before, '不得重复建号');
  });

  test('F4：注销后同一微信再来 → 建新账号（不复活旧账号）', async () => {
    const openid = useFreshWechatIdentity('f4');
    const first = await loginViaWechat();

    const del = await fetch(`${base}/api/auth/account`, {
      method: 'DELETE',
      headers: { cookie: first.sessionCookie },
    });
    assert.equal(del.status, 200, '自助注销应成功');

    // 身份行仍在（软删不动它），但它的账号已注销
    const identity = await findOAuthIdentity('wechat', openid);
    assert.ok(identity, '注销不删身份行（30 天硬删才清）');

    const second = await loginViaWechat();
    assert.notEqual(second.user.id, first.user.id, 'F4：注销后回来是新账号，不是复活');
    assert.equal(second.user.email_placeholder, true);
    const stale = await findOAuthIdentity('wechat', openid);
    assert.equal(stale!.user.id, second.user.id, '身份行应已重指到新账号');
  });

  test('同 unionid 不同 openid（另一个应用）：认回同一个账号', async () => {
    const seed = await findUserByEmail('user@deepdive.ai');
    assert.ok(seed, '种子账号应存在');
    await linkOAuthIdentity({
      userId: seed!.id,
      provider: 'wechat',
      openid: 'OPENID-APP-A',
      unionid: 'UNIONID-SAME-PERSON',
      nickname: '同一个人',
      avatarUrl: null,
    });

    // 另一个应用下的 openid 首次登录 → 撞 unionid 唯一索引 → 应认回上面的账号
    wxTokenReply = { access_token: 'AT-2', openid: 'OPENID-APP-B', unionid: 'UNIONID-SAME-PERSON' };
    wxUserinfoReply = { openid: 'OPENID-APP-B', nickname: '同一个人' };

    const before = await userCount();
    const { user } = await loginViaWechat();

    assert.equal(user.id, seed!.id, 'unionid 相同 = 同一个人，必须回到同一账号');
    assert.equal(await userCount(), before, '不得为同一个人建第二个账号');
    // 新的 openid 应作为**独立一行**挂上（同一个人的多个 openid 各占一行，unionid 不作唯一键）
    const linked = await findOAuthIdentity('wechat', 'OPENID-APP-B');
    assert.ok(linked, 'OPENID-APP-B 应已建出身份行');
    assert.equal(linked!.user.id, seed!.id, '新身份行必须指向同一个账号');
    assert.equal(linked!.identity.unionid, 'UNIONID-SAME-PERSON');
    // 「同人收敛」查询本身也应能命中（两行 unionid 相同，返回哪一行都合法）
    const byUnionid = await findOAuthIdentityByUnionid('wechat', 'UNIONID-SAME-PERSON');
    assert.equal(byUnionid!.user.id, seed!.id);
  });

  test('昵称清洗：控制字符剔除、按码点截断到 50、全空回落默认名', async () => {
    useFreshWechatIdentity('nick');
    wxUserinfoReply = {
      openid: 'OPENID-nick',
      nickname: `\u0000A\u200B\u200F  B  ${'字'.repeat(200)}😀😀`,
    };
    const long = await loginViaWechat();
    assert.ok(long.user.name.length <= 50, `昵称应截断到 50，实际 ${long.user.name.length}`);
    assert.doesNotMatch(long.user.name, /[\u0000-\u001F\u200B-\u200F]/, '不得残留控制/零宽字符');
    // ⚠️ 不能断言「不含 U+FFFD」—— 若按 UTF-16 切断代理对，产出的是**孤立代理项**
    // （U+D83D 之类）而不是 U+FFFD，那条断言永远为真、等于没写。真正的判据是
    // 「每个码点都是完整标量」：按码点切（Array.from）时不会出现长度为 1 的代理项。
    const trimmed: string = long.user.name;
    assert.ok(
      Array.from(trimmed).every(
        (c) => !(c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)
      ),
      `昵称里出现了孤立代理项（半个 emoji）：${JSON.stringify(trimmed)}`
    );

    useFreshWechatIdentity('nick-empty');
    wxUserinfoReply = { openid: 'OPENID-nick-empty', nickname: '   \u0000\u200B  ' };
    const empty = await loginViaWechat();
    assert.equal(empty.user.name, '微信用户');
  });

  test('占位账号无法用密码登录（哨兵口令不可满足）', async () => {
    useFreshWechatIdentity('pw');
    const { user } = await loginViaWechat();

    const res = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'wechat' }),
    });
    assert.equal(res.status, 401, '占位邮箱 + 任意口令必须登录失败');
    assert.equal(((await res.json()) as any).code, 'INVALID_CREDENTIALS');
  });

  test('注册口封杀占位域（防抢注导致微信首登被定向 DoS）', async () => {
    const email = 'wx_whatever@wechat.invalid';

    const code = await fetch(`${base}/api/auth/send-register-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(code.status, 400);
    assert.equal(((await code.json()) as any).code, 'EMAIL_DOMAIN_RESERVED');

    const signup = await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Pass123456', code: '123456' }),
    });
    assert.equal(signup.status, 400);
    assert.equal(((await signup.json()) as any).code, 'EMAIL_DOMAIN_RESERVED');
  });

  test('微信账号不被邮箱闸拦：chat 不返回 EMAIL_NOT_VERIFIED', async () => {
    useFreshWechatIdentity('chat');
    const { sessionCookie } = await loginViaWechat();
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'wechat-probe' }], canvasId: null }),
    });
    if (chat.status === 403) {
      assert.notEqual(((await chat.json()) as any).code, 'EMAIL_NOT_VERIFIED');
    }
    await chat.body?.cancel();
  });

  test('审计：首登记 wechat_sign_up，老账号登录记 wechat_login', async () => {
    useFreshWechatIdentity('audit');
    await loginViaWechat(); // 首登
    await loginViaWechat(); // 二次

    const actions = getAuditLogsForTest().map((l) => l.action);
    assert.ok(actions.includes('wechat_sign_up'), '应记录 wechat_sign_up');
    assert.ok(actions.includes('wechat_login'), '应记录 wechat_login');
  });

  test('限流：callback 超阈值改 302 回前端（而不是甩一坨 JSON 429 给浏览器）', async () => {
    const { state, stateCookie } = await startAuthorize();
    let sawRateLimited = false;
    for (let i = 0; i < 40; i++) {
      const res = await callback({ code: `RR-${i}`, state: `${state}x` }, stateCookie);
      if (res.headers.get('location') === '/?wechat_error=RATE_LIMITED') {
        sawRateLimited = true;
        break;
      }
    }
    assert.ok(sawRateLimited, '超过 30/min 后应回 RATE_LIMITED');
    resetLimiters();
  });

  test('限流：authorize 超阈值返回 429', async () => {
    let status = 0;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/auth/wechat/authorize`, { redirect: 'manual' });
      status = res.status;
      if (status === 429) break;
    }
    assert.equal(status, 429, '超过 20/min 后 authorize 应 429');
    resetLimiters();
  });

  test('内存硬删对等：cleanupDeletedUsers(0) 一并清掉身份行（对齐 PG 外键 CASCADE）', async () => {
    useFreshWechatIdentity('gc');
    await loginViaWechat();
    assert.ok(inMemoryStore.oauthIdentities.size > 0, '前置：应有身份行');

    await cleanupDeletedUsers(0);

    assert.equal(inMemoryStore.oauthIdentities.size, 0, '硬删后不得残留身份行');
  });
});
