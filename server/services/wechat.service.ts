import crypto from 'node:crypto';
import { OAUTH_UNSET_PASSWORD_HASH, generateSessionToken } from '../lib/crypto.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { createSession } from '../repositories/session.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { resetFailedLogin } from '../repositories/user.repository.js';
import {
  findOAuthIdentity,
  findOAuthIdentityByUnionid,
  createWechatUserWithIdentity,
  rebindOAuthIdentityToNewUser,
  linkOAuthIdentity,
} from '../repositories/oauth.repository.js';
import { exchangeCodeForProfile } from './wechat-provider.js';
import type { UserRecord } from '../core/records.js';

/**
 * 微信登录编排（ADR-0022）。
 *
 * 本模块必须整体在 **`runWithSystem`** 作用域下被调用：按 openid 查/建账号发生在
 * 「还不知道是谁」的阶段，与 `sign-in`/`sign-up` 同理（见 routes/wechat.ts 的调用点）。
 */

/** 身份表里的 provider 取值（唯一出处：路由、绑定服务与仓储都引用它，不要各写一份字面量） */
export const WECHAT_PROVIDER = 'wechat';

/** 占位邮箱域：`.invalid` 是 RFC 2606 保留 TLD，DNS 永不解析 → 该地址永远收不到信、也永不可验证 */
const PLACEHOLDER_EMAIL_DOMAIN = 'wechat.invalid';

/**
 * 注册口必须拒掉占位域（`signUp` / `sendRegisterCode` 都调它）。
 *
 * 不拒的后果是一个**定向拒绝服务**：攻击者抢先用 `wx_<受害者openid的哈希>@wechat.invalid`
 * 走正常注册占位，受害者微信首登就会撞 `users.email` 唯一索引，且没有身份行可供回退，
 * 只能看到「登录失败」。
 */
export function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * 由 openid 推出**确定性**占位邮箱。
 *
 * 为什么不直接 `wx_${openid}@...`：openid 是大小写敏感的标识，而邮箱在服务端一律
 * lower-case 归一（`createUser`），两个仅大小写不同的 openid 会被压成同一个邮箱 →
 * 第二个人的首登撞唯一索引且无从收敛。取哈希同时把长度与字符集一起钉死。
 *
 * 确定性本身是并发收敛的前提：两个标签页同时回调会算出同一个邮箱，
 * 输的那一路靠 23505 重查即可登录赢家的账号。
 */
export function placeholderEmailFor(openid: string): string {
  const digest = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32);
  return `wx_${digest}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/**
 * 外部昵称清洗：控制字符/零宽字符剔除、空白折叠、按**码点**截断到 50。
 * 50 与 `SignUpSchema`/`UpdateProfileSchema` 的 `name max(50)` 口径一致（`users.name`
 * 是 VARCHAR(100)，留足余量不触 PG 22001）。按码点截断是为了不把 emoji 的代理对切成两半。
 * 全空则回落「微信用户」——必须显式给值，否则会落到 `createUser` 里
 * `email.split('@')[0]` 的兜底，得到一个 `wx_xxxx` 的展示名。
 */
export function sanitizeExternalNickname(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // C0/C1 控制字符与 DEL
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '') // 零宽字符与 BOM
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 50).join('') || '微信用户';
}

export interface WechatLoginResult {
  user: UserRecord;
  token: string;
  /** true = 本次建了账号（审计记 `wechat_sign_up`），false = 老账号登录（记 `wechat_login`） */
  isNewUser: boolean;
}

/** 登录收尾：刷新 last_login_at、建会话、写审计。与 `signIn` 的后置副作用对齐 */
async function finishLogin(
  user: UserRecord,
  isNewUser: boolean,
  ip?: string,
  userAgent?: string
): Promise<WechatLoginResult> {
  if (!user.is_active) {
    throw new ForbiddenError('账号已被系统冻结，请联系运营管理员', 'ACCOUNT_FROZEN');
  }

  // 复用邮箱登录那条路径的收尾：清零失败计数并盖上 last_login_at
  await resetFailedLogin(user.id);

  const token = generateSessionToken();
  await createSession({ userId: user.id, token, ipAddress: ip, userAgent });
  await recordAuditLog({
    userId: user.id,
    action: isNewUser ? 'wechat_sign_up' : 'wechat_login',
    ip,
    userAgent,
    details: { provider: WECHAT_PROVIDER },
  });

  return { user, token, isNewUser };
}

/**
 * 唯一冲突（23505）后的一次性收敛：并发的另一路（两个标签页同时回调）已经把这层身份
 * 建好了，重查一次并登录**赢家**的账号即可，不要让用户看到服务器错误。
 *
 * 只可能是 `(provider, openid)` 撞——`unionid` 上没有唯一约束（它必须允许
 * 「同一个人的多个 openid 各占一行」），那条路径靠建号前的显式查询处理。
 */
async function resolveDuplicate(openid: string): Promise<UserRecord | null> {
  const byOpenid = await findOAuthIdentity(WECHAT_PROVIDER, openid);
  if (byOpenid && !byOpenid.user.deleted_at) return byOpenid.user;
  return null;
}

/**
 * 微信授权回调 → 登录（或自动建号并登录）。
 *
 * 账号认领规则：
 * 1. 身份命中且账号未注销 → 直接登录；
 * 2. 身份命中但账号**已注销（F4 软删）** → 建**新账号**并把身份行重指过去
 *    （不复活旧账号，与「注销后同邮箱可重新注册为新 id」一致）；
 * 3. 身份未命中、但 `unionid` 命中别人的身份行 → **同一个人**（另一个应用下的 openid），
 *    把当前 openid 挂到他已有的账号上，不新建；
 * 4. 都不命中 → 事务内建号 + 建身份（占位邮箱 + 不可满足的口令哨兵 + `email_verified=true`）。
 */
export async function loginWithWechat(data: {
  code: string;
  ip?: string;
  userAgent?: string;
}): Promise<WechatLoginResult> {
  const profile = await exchangeCodeForProfile(data.code);
  const email = placeholderEmailFor(profile.openid);
  const nickname = sanitizeExternalNickname(profile.nickname);
  const avatarUrl = profile.avatarUrl;

  const existing = await findOAuthIdentity(WECHAT_PROVIDER, profile.openid);
  if (existing && !existing.user.deleted_at) {
    return finishLogin(existing.user, false, data.ip, data.userAgent);
  }

  const identityParams = {
    provider: WECHAT_PROVIDER,
    openid: profile.openid,
    unionid: profile.unionid,
    nickname,
    avatarUrl,
    email,
    passwordHash: OAUTH_UNSET_PASSWORD_HASH,
  };

  // 规则 3：同一个人的另一个 openid（一期只有一个 appid 走不到，但接小程序/公众号时就是这条路）。
  // 这里必须显式查一次：unionid 上没有唯一约束可依赖（见 oauth.repository 的说明）。
  if (!existing && profile.unionid) {
    const samePerson = await findOAuthIdentityByUnionid(WECHAT_PROVIDER, profile.unionid);
    if (samePerson && !samePerson.user.deleted_at) {
      try {
        await linkOAuthIdentity({ userId: samePerson.user.id, ...identityParams });
      } catch (e: any) {
        if (e?.code !== '23505') throw e;
        // 并发下已被另一路挂上：无害，直接用那个账号登录
      }
      return finishLogin(samePerson.user, false, data.ip, data.userAgent);
    }
  }

  let user: UserRecord;
  try {
    user = existing
      ? await rebindOAuthIdentityToNewUser({ identityId: existing.identity.id, ...identityParams })
      : await createWechatUserWithIdentity(identityParams);
  } catch (e: any) {
    if (e?.code !== '23505') throw e;
    const converged = await resolveDuplicate(profile.openid);
    if (!converged) {
      // 极端并发（如注销后两个标签页同时回调）——让用户重试即可
      throw new AppError(500, 'WECHAT_IDENTITY_CONFLICT', '微信登录身份冲突，请重试');
    }
    return finishLogin(converged, false, data.ip, data.userAgent);
  }

  return finishLogin(user, true, data.ip, data.userAgent);
}
