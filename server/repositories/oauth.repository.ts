import crypto from 'node:crypto';
import { getDb } from '../core/db.js';
import { inMemoryStore } from '../core/memory-store.js';
import { type OAuthIdentityRecord, type UserRecord, mapRowToUser } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

/**
 * 第三方登录身份绑定仓储（ADR-0022 微信网站应用登录）。
 *
 * 查找一律以 **`openid`** 为键：它是「应用维度」的唯一标识。`unionid` 是
 * 「开放平台主体维度」的——同一个人的小程序 openid 与网站应用 openid 是两行、
 * `unionid` 相同，所以它**不能带唯一约束**，只能作普通索引供「同人收敛」查询，
 * 由 `wechat.service` 在建号前先查一次（详见该文件）。
 *
 * 本表**无 `deleted_at`**：身份是凭据映射而非用户数据。用户注销（软删）时刻意不动
 * 身份行 —— F4 语义由调用方「JOIN 出的 user.deleted_at」判定（与 `findSession`
 * 同构：软删用户不得复活）；30 天硬删时由 PG 的 FK `ON DELETE CASCADE` 与内存分支的
 * `purgeUserDataMemory` 各自清理。
 */

/** 内存分支的身份键，与 PG 的 `(provider, openid)` 唯一索引对齐 */
function identityKey(provider: string, openid: string): string {
  return `${provider}:${openid}`;
}

/** 将 PG 行（oi_* 别名列）映射为 OAuthIdentityRecord */
function mapRowToIdentity(row: any): OAuthIdentityRecord {
  return {
    id: row.oi_id,
    user_id: row.oi_user_id,
    provider: row.oi_provider,
    openid: row.oi_openid,
    unionid: row.oi_unionid,
    nickname: row.oi_nickname,
    avatar_url: row.oi_avatar_url,
    created_at: row.oi_created_at,
    updated_at: row.oi_updated_at,
  };
}

/**
 * `oauth_identities` 的列名与 `users` 重名（id/created_at/updated_at），
 * 故身份侧必须显式取别名——`SELECT oi.*, u.*` 会让 `u` 的同名列**静默覆盖**身份行，
 * 身份 id 变成用户 id、时间戳串味，且不会有任何报错。
 * 下面两份常量共用同一串别名：只查身份时用 `IDENTITY_COLUMNS`，
 * join 用户时用 `IDENTITY_JOIN_COLUMNS`（多处一个 `u.*`）。
 */
const IDENTITY_COLUMNS = `
  oi.id AS oi_id,
  oi.user_id AS oi_user_id,
  oi.provider AS oi_provider,
  oi.openid AS oi_openid,
  oi.unionid AS oi_unionid,
  oi.nickname AS oi_nickname,
  oi.avatar_url AS oi_avatar_url,
  oi.created_at AS oi_created_at,
  oi.updated_at AS oi_updated_at`;

const IDENTITY_JOIN_COLUMNS = `${IDENTITY_COLUMNS},
  u.*`;

/**
 * 按 `(provider, openid)` 查身份及其用户。
 *
 * ⚠️ 返回的 `user` **保留 `deleted_at`**，不在这里过滤：软删用户是否可用是
 * 业务判断（F4），仓储只如实回传，别把「已注销」偷偷变成「查不到」。
 */
export async function findOAuthIdentity(
  provider: string,
  openid: string
): Promise<{ identity: OAuthIdentityRecord; user: UserRecord } | null> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT ${IDENTITY_JOIN_COLUMNS}
           FROM oauth_identities oi
           JOIN users u ON u.id = oi.user_id
          WHERE oi.provider = $1 AND oi.openid = $2`,
        [provider, openid]
      );
      if (res.rows.length > 0) {
        return { identity: mapRowToIdentity(res.rows[0]), user: mapRowToUser(res.rows[0]) };
      }
    } catch (e) {
      handlePgError(e);
      console.warn('PG findOAuthIdentity fallback to in-memory:', e);
    }
  }

  const key = identityKey(provider, openid);
  for (const identity of inMemoryStore.oauthIdentities.values()) {
    if (identityKey(identity.provider, identity.openid) !== key) continue;
    const user = inMemoryStore.users.get(identity.user_id);
    if (!user) return null;
    return { identity, user };
  }
  return null;
}

/**
 * 按 `(provider, unionid)` 查身份——只有 `unionid` 非空时才有意义。
 * 用途：同一个人在**另一个应用**（另一个 openid）下已有记录时，把他认回同一个账号。
 */
export async function findOAuthIdentityByUnionid(
  provider: string,
  unionid: string
): Promise<{ identity: OAuthIdentityRecord; user: UserRecord } | null> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT ${IDENTITY_JOIN_COLUMNS}
           FROM oauth_identities oi
           JOIN users u ON u.id = oi.user_id
          WHERE oi.provider = $1 AND oi.unionid = $2`,
        [provider, unionid]
      );
      if (res.rows.length > 0) {
        return { identity: mapRowToIdentity(res.rows[0]), user: mapRowToUser(res.rows[0]) };
      }
    } catch (e) {
      handlePgError(e);
      console.warn('PG findOAuthIdentityByUnionid fallback to in-memory:', e);
    }
  }

  for (const identity of inMemoryStore.oauthIdentities.values()) {
    if (identity.provider !== provider || !identity.unionid || identity.unionid !== unionid) continue;
    const user = inMemoryStore.users.get(identity.user_id);
    if (!user) return null;
    return { identity, user };
  }
  return null;
}

/** 内存分支的唯一约束模拟：与 PG 的 23505 同款抛出，使两路的失败语义一致 */
function throwDuplicateKey(constraint: string): never {
  const err: any = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  err.code = '23505';
  throw err;
}

function buildOAuthUser(params: {
  email: string;
  passwordHash: string;
  name: string;
  avatarUrl: string | null;
}): UserRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    email: params.email,
    password_hash: params.passwordHash,
    name: params.name,
    avatar: params.avatarUrl || undefined,
    role: 'user',
    email_verified: true,
    is_active: true,
    failed_attempts: 0,
    locked_until: null,
    last_login_at: now,
    created_at: now,
    updated_at: now,
  };
}

/**
 * 首次第三方登录：在同一事务内建 `users` 行 + `oauth_identities` 行。
 *
 * 为什么必须同事务：拆成两步时，若建号成功而插身份失败，会留下一个「有账号、
 * 无任何登录方式」的孤儿（占位邮箱不可达、密码是哨兵），下次登录只会再造一个，
 * 每次重试各泄漏一个账号。先例：`billing.repository.ts` 的 `settlePaidOrder`
 * 也是在同一个 `withTransaction` 里写 `orders` + `users`。
 *
 * 唯一冲突（`23505`）**必须显式 rethrow 且置于 `handlePgError` 之前**：后者不特判
 * 23505，生产会把它变成 503 `DB_UNAVAILABLE`，把「并发收敛」变成「用户看到服务器错误」。
 * 调用方据此重查一次并登录赢家的账号（先例：`user.repository.ts` 的 restoreAccount）。
 */
export async function createWechatUserWithIdentity(params: {
  provider: string;
  openid: string;
  unionid: string | null;
  nickname: string;
  avatarUrl: string | null;
  email: string;
  passwordHash: string;
}): Promise<UserRecord> {
  const { provider, openid, unionid, nickname, avatarUrl, email, passwordHash } = params;
  const db = getDb();
  if (db) {
    try {
      return await db.withTransaction(async (client) => {
        const userId = crypto.randomUUID();
        const created = await client.query(
          `INSERT INTO users
             (id, email, password_hash, name, avatar, role, is_active, failed_attempts, email_verified, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'user', TRUE, 0, TRUE, NOW(), NOW())
           RETURNING *`,
          [userId, email, passwordHash, nickname, avatarUrl]
        );
        await client.query(
          `INSERT INTO oauth_identities
             (id, user_id, provider, openid, unionid, nickname, avatar_url, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [crypto.randomUUID(), userId, provider, openid, unionid, nickname, avatarUrl]
        );
        return mapRowToUser(created.rows[0]);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw e;
      handlePgError(e);
      console.warn('PG createWechatUserWithIdentity failed, falling back to memory:', e);
    }
  }

  // 内存分支：显式复刻唯一索引的语义（否则双模行为分叉，测试也测不到冲突路径）
  if (inMemoryStore.oauthIdentities.has(identityKey(provider, openid))) {
    throwDuplicateKey('idx_oauth_identities_provider_openid');
  }
  const user = buildOAuthUser({ email, passwordHash, name: nickname, avatarUrl });
  inMemoryStore.users.set(user.id, user);
  const now = new Date().toISOString();
  inMemoryStore.oauthIdentities.set(identityKey(provider, openid), {
    id: crypto.randomUUID(),
    user_id: user.id,
    provider,
    openid,
    unionid,
    nickname,
    avatar_url: avatarUrl,
    created_at: now,
    updated_at: now,
  });
  return user;
}

/**
 * F4：原账号已注销，`(provider, openid)` 行仍指着它 —— 建新账号并把该行**重指**过去。
 *
 * 为什么是 UPDATE 而不是删掉重插：`(provider, openid)` 唯一索引不允许同一身份有两行，
 * 而重插会先删后插、中途失败就丢了唯一线索。重指在事务内完成，语义是「同一个人、
 * 新账号」——与 F4「注销后同邮箱可重新注册为**新 id**」一致：**不复活旧账号**。
 */
export async function rebindOAuthIdentityToNewUser(params: {
  identityId: string;
  provider: string;
  openid: string;
  unionid: string | null;
  nickname: string;
  avatarUrl: string | null;
  email: string;
  passwordHash: string;
}): Promise<UserRecord> {
  const { identityId, provider, openid, unionid, nickname, avatarUrl, email, passwordHash } = params;
  const db = getDb();
  if (db) {
    try {
      return await db.withTransaction(async (client) => {
        const userId = crypto.randomUUID();
        const created = await client.query(
          `INSERT INTO users
             (id, email, password_hash, name, avatar, role, is_active, failed_attempts, email_verified, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'user', TRUE, 0, TRUE, NOW(), NOW())
           RETURNING *`,
          [userId, email, passwordHash, nickname, avatarUrl]
        );
        await client.query(
          `UPDATE oauth_identities
              SET user_id = $1, unionid = $2, nickname = $3, avatar_url = $4, updated_at = NOW()
            WHERE id = $5`,
          [userId, unionid, nickname, avatarUrl, identityId]
        );
        return mapRowToUser(created.rows[0]);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw e;
      handlePgError(e);
      console.warn('PG rebindOAuthIdentityToNewUser failed, falling back to memory:', e);
    }
  }

  const user = buildOAuthUser({ email, passwordHash, name: nickname, avatarUrl });
  inMemoryStore.users.set(user.id, user);
  const existing = inMemoryStore.oauthIdentities.get(identityKey(provider, openid));
  if (existing) {
    existing.user_id = user.id;
    existing.unionid = unionid;
    existing.nickname = nickname;
    existing.avatar_url = avatarUrl;
    existing.updated_at = new Date().toISOString();
  }
  return user;
}

/**
 * 把一个新的 `openid` 挂到**已有**账号上（同一个人在另一个应用下登录，
 * 或走了 23505 兜底收敛）。纯插入，不新建账号。
 */
export async function linkOAuthIdentity(params: {
  userId: string;
  provider: string;
  openid: string;
  unionid: string | null;
  nickname: string;
  avatarUrl: string | null;
}): Promise<OAuthIdentityRecord> {
  const { userId, provider, openid, unionid, nickname, avatarUrl } = params;
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `INSERT INTO oauth_identities
           (id, user_id, provider, openid, unionid, nickname, avatar_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING *`,
        [crypto.randomUUID(), userId, provider, openid, unionid, nickname, avatarUrl]
      );
      return res.rows[0];
    } catch (e: any) {
      if (e?.code === '23505') throw e;
      handlePgError(e);
      console.warn('PG linkOAuthIdentity failed, falling back to memory:', e);
    }
  }

  if (inMemoryStore.oauthIdentities.has(identityKey(provider, openid))) {
    throwDuplicateKey('idx_oauth_identities_provider_openid');
  }
  const now = new Date().toISOString();
  const record: OAuthIdentityRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    provider,
    openid,
    unionid,
    nickname,
    avatar_url: avatarUrl,
    created_at: now,
    updated_at: now,
  };
  inMemoryStore.oauthIdentities.set(identityKey(provider, openid), record);
  return record;
}

/**
 * 查某账号绑定的某个 provider 身份（ADR-0023）。
 *
 * 与两个 `findOAuthIdentity*` 的区别：那两者按**身份**找用户（登录前，跨租户，须 `runWithSystem`）；
 * 本函数按**用户**找身份（已登录，`WHERE user_id = $1` 在 `runWithUser` 作用域下天然满足
 * `oauth_identities` 的 RLS 谓词，不需要任何作用域升级）。
 *
 * 一个账号最多绑一个同 provider 身份（由服务层保证），这里仍然 `LIMIT 1` 兜住历史数据。
 */
export async function findOAuthIdentityByUserId(
  userId: string,
  provider: string
): Promise<OAuthIdentityRecord | null> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `SELECT ${IDENTITY_COLUMNS}
           FROM oauth_identities oi
          WHERE oi.user_id = $1 AND oi.provider = $2
          ORDER BY oi.created_at ASC
          LIMIT 1`,
        [userId, provider]
      );
      if (res.rows.length > 0) return mapRowToIdentity(res.rows[0]);
      return null;
    } catch (e) {
      handlePgError(e);
      console.warn('PG findOAuthIdentityByUserId fallback to in-memory:', e);
    }
  }

  for (const identity of inMemoryStore.oauthIdentities.values()) {
    if (identity.user_id === userId && identity.provider === provider) return identity;
  }
  return null;
}

/**
 * 解除某账号的第三方绑定（ADR-0023 的 admin 逃生舱）。
 *
 * 为什么需要它：绑定是**单向**的且只凭「有有效会话」放行，用户扫错微信（扫了别人的、
 * 或手机号被回收后微信号易主）就没有任何自助退路。用户侧仍不提供解绑，这里只给运营台用。
 * 返回删除行数（0 = 本来就没绑，调用方据此回 404）。
 */
export async function destroyOAuthIdentity(userId: string, provider: string): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        'DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2 RETURNING id',
        [userId, provider]
      );
      return res.rowCount || 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG destroyOAuthIdentity fallback to in-memory:', e);
    }
  }

  let removed = 0;
  for (const [key, identity] of inMemoryStore.oauthIdentities.entries()) {
    if (identity.user_id === userId && identity.provider === provider) {
      inMemoryStore.oauthIdentities.delete(key);
      removed++;
    }
  }
  return removed;
}
