import { AppError, ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { sendEmailBindCodeEmail } from '../lib/mailer.js';
import { runWithSystem } from '../core/db-context.js';
import { getCode, upsertCode } from '../repositories/email-code.repository.js';
import { bindVerifiedEmail, findUserByEmail, findUserById } from '../repositories/user.repository.js';
import { findOAuthIdentityByUserId } from '../repositories/oauth.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { EMAIL_CODE_TTL_MS, consumeEmailCodeOrThrow, generateEmailCode } from './auth.service.js';
import { isPlaceholderEmail, WECHAT_PROVIDER } from './wechat.service.js';
import type { UserRecord } from '../core/records.js';

/**
 * 账号绑定（ADR-0023）：微信 ↔ 邮箱，**单向、不可自助解除**。
 *
 * 与 `wechat.service.ts` 的作用域约定正好相反：本模块服务于**已登录**路径，
 * 调用方必须在 `runWithUser` 作用域内（`authMiddleware` 已建立），因此这里不做也不该做
 * 「整体跨租户」的假设；唯一的例外是全站邮箱唯一性预检，见 `assertEmailUnused`。
 */

/**
 * 已登录路径：读本账号的微信绑定状态。
 * 按 `user_id` 查 —— `oauth_identities` 的 RLS 谓词就是 `user_id = app.user_id`，
 * 在 `runWithUser` 下天然放行，**不需要**（也不应）升级作用域。
 */
export async function getWechatBinding(
  userId: string
): Promise<{ bound: boolean; nickname: string | null }> {
  const identity = await findOAuthIdentityByUserId(userId, WECHAT_PROVIDER);
  return { bound: Boolean(identity), nickname: identity?.nickname ?? null };
}

/**
 * 补绑邮箱的前置校验：只有**占位邮箱**的账号（微信自动建号的产物）可以补绑。
 *
 * 这条限制同时替我们挡掉了「换绑」：真实邮箱账号根本进不来，因此不必实现解绑/换绑，
 * 也就没有了「解到没有登录方式」这类状态。
 */
async function loadBindableUser(userId: string): Promise<UserRecord> {
  const user = await findUserById(userId);
  if (!user) throw new NotFoundError('账号不存在');
  if (!isPlaceholderEmail(user.email)) {
    // 400（与 Spec D3 的 EMAIL_ALREADY_VERIFIED 同款口径）——是状态不允许，不是并发冲突
    throw new ValidationError('当前账号已绑定邮箱', 'EMAIL_ALREADY_BOUND');
  }
  return user;
}

/** 目标邮箱不得落在微信占位域上：那道防线见 ADR-0022（抢注占位 = 定向 DoS） */
function assertBindableTarget(rawEmail: string): string {
  const email = rawEmail.toLowerCase().trim();
  if (isPlaceholderEmail(email)) {
    throw new ValidationError('该邮箱域名不可用于绑定', 'EMAIL_DOMAIN_RESERVED');
  }
  return email;
}

/**
 * 全站邮箱唯一性预检。
 *
 * ⚠️ 必须跨租户：`users` 的 RLS 谓词是 `id = current_setting('app.user_id')`，
 * 在已登录的 `runWithUser(me)` 作用域下 `findUserByEmail(别人的邮箱)` 在 **PG 里恒返回 null**
 * （内存模式没有 RLS，能查到）——也就是「友好的 409」在生产永远不会触发，
 * 只剩一条静默的双模分叉。这里的 `runWithSystem` 是**刻意**的越权读，理由即此。
 *
 * 它只是友好提示；真正的兜底是 `users.email` 的唯一索引（`23505` → 409）。
 */
async function assertEmailUnused(email: string): Promise<void> {
  await runWithSystem('auth: 绑定邮箱前按 email 跨租户查重（需全站唯一性）', async () => {
    const existing = await findUserByEmail(email);
    if (existing) {
      throw new ConflictError('该邮箱已被注册，请直接登录', 'EMAIL_EXISTS');
    }
  });
}

/** 发送「绑定邮箱」验证码（6 位数字，10 分钟有效，每邮箱 60s 冷却） */
export async function bindEmailSendCode(data: { userId: string; email: string }): Promise<void> {
  await loadBindableUser(data.userId);
  const email = assertBindableTarget(data.email);
  await assertEmailUnused(email);

  const rec = await getCode(email);
  if (rec && Date.now() - new Date(rec.updated_at).getTime() < 60 * 1000) {
    throw new AppError(429, 'CODE_COOLDOWN', '验证码发送过于频繁，请 1 分钟后再试');
  }

  const code = generateEmailCode();
  const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
  await upsertCode(email, code, expiresAt);

  // 发信失败仅 warn，不影响响应（用户可重发，受冷却与限流保护）
  await sendEmailBindCodeEmail(email, code);
}

/**
 * 补绑邮箱（**只绑邮箱，不设密码**）。
 *
 * 口径说明（ADR-0023）：
 * - 用户已用 6 位验证码证明了邮箱归自己所有，故 `email_verified` 保持 TRUE
 *   —— 绝不能走 admin 的换绑路径（那会把 `email_verified` 置 false，
 *   而 `middleware/quota.ts` 对未验证邮箱一律 403，等于绑完邮箱所有 chat 全挂）；
 * - `password_hash` 保持哨兵不变，`has_password` 仍为 false；用户之后想用邮箱登录，
 *   走登录页「忘记密码」自助设置（此时该地址已经真的收得到信）；
 * - **不建会话、也不踢会话**。规则是「换凭据才踢（changeOwnPassword/resetPassword），
 *   新增凭据不踢」——绑邮箱是增加一个凭据，不削减任何既有凭据的爆炸半径，
 *   踢下线只会让刚绑完的用户被登出。
 */
export async function bindEmail(data: {
  userId: string;
  email: string;
  code: string;
  ip?: string;
  userAgent?: string;
}): Promise<UserRecord> {
  const user = await loadBindableUser(data.userId);
  const email = assertBindableTarget(data.email);
  // ⚠️ 必须在 UPDATE **之前**把旧邮箱取成局部常量：内存分支的 findUserById 返回的是
  // Map 里的**活对象引用**，`bindVerifiedEmail` 会直接改它 —— 事后再读 `user.email`
  // 拿到的已经是新值，审计里就会出现 oldEmail === newEmail（PG 分支返回的是新行对象，
  // 不会有这个现象，即一处只在内存模式下发生的双模分叉）。
  const oldEmail = user.email;
  // 先查重再消费：已确定被占用的邮箱不该白烧掉一个验证码
  await assertEmailUnused(email);
  await consumeEmailCodeOrThrow(email, data.code);

  let updated: UserRecord | null;
  try {
    updated = await bindVerifiedEmail(data.userId, email);
  } catch (e: any) {
    // 唯一索引冲突（并发双请求的最终兜底）→ 409，与预检同一出口
    if (e?.code === '23505') {
      throw new ConflictError('该邮箱已被注册，请直接登录', 'EMAIL_EXISTS');
    }
    throw e;
  }
  if (!updated) throw new NotFoundError('账号不存在');

  await recordAuditLog({
    userId: data.userId,
    action: 'email_bind',
    ip: data.ip,
    userAgent: data.userAgent,
    // 只记前后邮箱，**不记验证码、不记密码**（本流程也根本没有密码）
    details: { oldEmail, newEmail: updated.email },
  });

  return updated;
}
