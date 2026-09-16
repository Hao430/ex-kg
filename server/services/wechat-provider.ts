/**
 * 微信开放平台「网站应用」登录客户端（ADR-0022）。
 *
 * 刻意**不引入微信 SDK**：整条链路只需要两个只读 GET 接口，用 Node 内置 `fetch`
 * 直调即可。新 runtime 依赖会牵动 esbuild `--packages=external` 与服务端
 * `npm install --omit=dev`（漏装即重启后 `Cannot find module`），为零依赖收益不值当。
 *
 * 官方文档：
 * - 授权入口 https://open.weixin.qq.com/connect/qrconnect（scope=snsapi_login）
 * - 换 token https://api.weixin.qq.com/sns/oauth2/access_token
 * - 取资料 https://api.weixin.qq.com/sns/userinfo
 *
 * 我们**只在登录那一刻**用掉 access_token，随即丢弃（不落库）——登录只需要 openid，
 * 而 refresh_token 无法续期（30 天），存下来只会多一份可泄漏的凭据。
 * 代价是昵称/头像只取首次授权时的快照，不会随微信侧变化自动刷新。
 */

/**
 * 运行时惰性读取：`dotenv.config()` 在 `server.ts` 里晚于所有 import 执行，
 * 模块级读 `process.env` 恒为 undefined（本项目已踩三次，见 CODEBUDDY「dotenv 时序坑」）。
 */
function getAppId(): string {
  return (process.env.WECHAT_APP_ID || '').trim();
}

function getAppSecret(): string {
  return (process.env.WECHAT_APP_SECRET || '').trim();
}

/** 两要素齐备才启用微信渠道；缺任一 → 前端不展示按钮、`/authorize` 直接回 NOT_CONFIGURED（绝不半死） */
export function isWechatConfigured(): boolean {
  return Boolean(getAppId() && getAppSecret());
}

/** 换 code / 取资料任一环节失败。`errcode` 只留给服务端日志，**绝不回显给浏览器** */
export class WechatAuthError extends Error {
  readonly errcode?: number;

  constructor(errcode: number | undefined, message: string) {
    super(message);
    this.name = 'WechatAuthError';
    this.errcode = errcode;
  }
}

export interface WechatProfile {
  openid: string;
  /** 未绑定开放平台主体时微信不返回；仅用于将来跨应用认出「同一个人」，不作查找主键 */
  unionid: string | null;
  nickname: string;
  avatarUrl: string | null;
}

/** 构造整页跳转的授权地址（`state` 由调用方生成并已写入双提交 cookie） */
export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    appid: getAppId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'snsapi_login',
    state,
  });
  // `#wechat_redirect` 是微信要求的锚点（缺了会走异常分支）；必须排在 query 之后
  return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`;
}

/** 微信接口在**出错时也返回 HTTP 200**，因此必须解析 body 判 `errcode`，不能只看状态码 */
async function getJson(url: string): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e: any) {
    throw new WechatAuthError(undefined, `微信接口不可达：${e?.message || e}`);
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new WechatAuthError(undefined, `微信接口返回了非 JSON（HTTP ${res.status}）`);
  }

  if (body?.errcode) {
    // errcode 是排查的唯一线索（40029 无效 code / 40163 code 已用 / 40001 密钥错 / 42001 token 过期）
    throw new WechatAuthError(Number(body.errcode), String(body.errmsg || 'wechat error'));
  }
  return body;
}

/** 用户头像 URL 归一：微信返回 http，浏览器在 https 页面下会拦混合内容 */
function normalizeAvatar(headimgurl: unknown): string | null {
  const raw = typeof headimgurl === 'string' ? headimgurl.trim() : '';
  if (!raw) return null;
  return raw.startsWith('http://') ? `https://${raw.slice('http://'.length)}` : raw;
}

/**
 * 用一次性的 `code` 换 openid 并取回资料（`code` 10 分钟有效且只能成功使用一次）。
 *
 * ⚠️ 资料接口（`/sns/userinfo`）失败**不阻断登录**：openid 已从换 token 的响应里拿到，
 * 账号照样建得起来，只是昵称/头像退化为默认值（用户可在个人中心改）。
 * 反过来「因为取不到显示名就把已授权的用户挡在门外」是更差的取舍。
 * 该降级会在服务端日志留 warn，不至于无声。
 */
export async function exchangeCodeForProfile(code: string): Promise<WechatProfile> {
  const tokenBody = await getJson(
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(getAppId())}` +
      `&secret=${encodeURIComponent(getAppSecret())}` +
      `&code=${encodeURIComponent(code)}&grant_type=authorization_code`
  );

  const openid = typeof tokenBody.openid === 'string' ? tokenBody.openid : '';
  const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
  if (!openid || !accessToken) {
    throw new WechatAuthError(undefined, '微信未返回 openid / access_token');
  }

  const unionid = typeof tokenBody.unionid === 'string' && tokenBody.unionid ? tokenBody.unionid : null;

  let profileBody: Record<string, any> = {};
  try {
    profileBody = await getJson(
      `https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(accessToken)}` +
        `&openid=${encodeURIComponent(openid)}&lang=zh_CN`
    );
  } catch (e: any) {
    console.warn('[wechat] 取用户资料失败，降级为「仅 openid」登录:', e?.errcode ?? e?.message);
  }

  return {
    openid,
    unionid,
    nickname: typeof profileBody.nickname === 'string' ? profileBody.nickname : '',
    avatarUrl: normalizeAvatar(profileBody.headimgurl),
  };
}
