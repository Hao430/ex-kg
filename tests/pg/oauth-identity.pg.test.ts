/**
 * ADR-0022 / ADR-0023 — `oauth_identities` 与绑定邮箱的 **PG 分支**
 *
 * 为什么单独有这个文件：`tests/wechat-login.test.ts` 与 `tests/account-binding.test.ts`
 * 跑的是**内存模式**，而生产实际走的是 PG 分支。那两个文件覆盖了业务语义，但下面这些
 * 只能由真库证明：
 *
 *   1. 建号 + 建身份**同事务**的原子性 —— 身份行插失败时，先前插进去的 users 行必须回滚，
 *      否则留下「有账号、无任何登录方式」的孤儿（占位邮箱不可达、口令是哨兵）；
 *   2. 两条唯一索引的**真实 23505**：内存分支的冲突是我手写的 `throwDuplicateKey`，
 *      等于自己测自己的模拟；而 23505 能否**穿透到调用方**（而不是被 handlePgError
 *      改写成 503 DB_UNAVAILABLE）决定了「并发收敛」是否真的成立；
 *   3. `users.email` 是 **partial** 唯一索引（`WHERE deleted_at IS NULL`）——
 *      「目标邮箱属于已注销账号时可以绑成功」这条语义在内存里是模拟的；
 *   4. `oauth_identities` 的 RLS **WITH CHECK** 真的会拒绝「在 user 作用域下建号 /
 *      给他人 user_id 写身份行」（组二，需要受限角色）。
 *
 * 运行方式（与其余 pg 用例一致，两遍冒烟各用一个空库）：
 *   PG_SMOKE=1 PG_TEST_URL=postgres://arborize_app:... DATABASE_SYSTEM_URL=... \
 *     DATABASE_ADMIN_URL=... npx tsx --test --test-concurrency=1 'tests/pg/*.test.ts'
 *
 * 组二只在 `PG_TEST_URL` 指向受 RLS 约束的角色时有判别力；`PG_TEST_URL` 已配置却不受
 * 约束 ⇒ 判定为接线错误并**报错**（照 db-scope.pg.test.ts 的口径：少传一个变量不能让
 * 唯一的证据无声消失）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

const PG_TEST_URL = process.env.PG_TEST_URL || '';
const OWNER_URL =
  process.env.DATABASE_ADMIN_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
// 必须在动态 import 之前：连接池在模块加载时读 process.env
process.env.DATABASE_URL = PG_TEST_URL || OWNER_URL;

const { initDbSchema } = await import('../../server/core/schema.js');
const { closePools } = await import('../../server/core/pool.js');
const { runWithUser, runWithSystem } = await import('../../server/core/db-context.js');
const {
  findOAuthIdentity,
  findOAuthIdentityByUserId,
  createWechatUserWithIdentity,
  rebindOAuthIdentityToNewUser,
  linkOAuthIdentity,
  destroyOAuthIdentity,
} = await import('../../server/repositories/oauth.repository.js');
const { bindVerifiedEmail, findUserById } = await import('../../server/repositories/user.repository.js');
const { OAUTH_UNSET_PASSWORD_HASH } = await import('../../server/lib/crypto.js');

const ALICE = '00000000-0000-4000-8000-0000000000e1';
const BOB = '00000000-0000-4000-8000-0000000000e2';
const ALICE_EMAIL = 'oauth-pg-alice@test.local';
const BOB_EMAIL = 'oauth-pg-bob@test.local';

const ownerPool = new Pool({ connectionString: OWNER_URL });
const appPool = new Pool({ connectionString: process.env.DATABASE_URL });

/** 本文件通过仓储建出来的账号，after 里按 id 清掉（删 users 会级联清身份行） */
const createdUserIds: string[] = [];

let rlsActive = false;
let appRole = '';
let skipReason = '';

/** 与 `loginWithWechat` 同款：建号发生在「还不知道是谁」的阶段，必须走 system 作用域 */
async function newWechatAccount(tag: string, extras: { email?: string } = {}) {
  const openid = `PG-OPENID-${tag}`;
  const user = await runWithSystem('pg oauth 用例：微信首登建号（登录前无租户）', () =>
    createWechatUserWithIdentity({
      provider: 'wechat',
      openid,
      unionid: `PG-UNIONID-${tag}`,
      nickname: `微信-${tag}`,
      avatarUrl: null,
      email: extras.email ?? `wx_pg-${tag}@wechat.invalid`,
      passwordHash: OAUTH_UNSET_PASSWORD_HASH,
    })
  );
  createdUserIds.push(user.id);
  return { openid, user };
}

async function userCount(): Promise<number> {
  const r = await ownerPool.query('SELECT count(*)::int AS n FROM users');
  return r.rows[0].n;
}

describe('ADR-0022/0023 oauth_identities 的 PG 分支', () => {
  before(async () => {
    await initDbSchema();
    for (let i = 0; i < 60; i++) {
      const r = await ownerPool.query("SELECT to_regclass('public.oauth_identities') IS NOT NULL AS ok");
      if (r.rows[0]?.ok) break;
      await new Promise((res) => setTimeout(res, 500));
    }

    // 判据必须问**应用实际使用的那个角色**：属主天然绕过 RLS，拿夹具池判会永远是否
    const who = await appPool.query('SELECT current_user AS role');
    appRole = who.rows[0].role;
    const probe = await appPool.query("SELECT row_security_active('oauth_identities') AS active");
    rlsActive = probe.rows[0].active === true;
    if (!rlsActive) {
      assert.equal(
        PG_TEST_URL,
        '',
        `PG_TEST_URL 已配置（当前角色 ${appRole}），但该角色不受 RLS 约束：` +
          '请确认它指向 arborize_app，且不是 oauth_identities 的属主、也没有 BYPASSRLS。'
      );
      skipReason = `当前角色 ${appRole} 不受 RLS 约束：隔离断言不适用（组一已全跑）`;
    }

    await ownerPool.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES
         ($1, $2, 'x', 'OAuth Alice'),
         ($3, $4, 'x', 'OAuth Bob')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, deleted_at = NULL`,
      [ALICE, ALICE_EMAIL, BOB, BOB_EMAIL]
    );
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [[ALICE, BOB]]);
    await ownerPool.end();
    await appPool.end();
    await closePools();
  });

  // ---------- 组一：与角色无关，两种跑法都必须绿 ----------

  t('建号 + 建身份在同一事务内落地，且返回的是新账号（出生即 email_verified）', async () => {
    const { openid, user } = await newWechatAccount('create');

    assert.equal(user.role, 'user');
    assert.equal(user.email_verified, true, '否则 middleware/quota.ts 会把全部 chat 403');
    assert.equal(user.password_hash, OAUTH_UNSET_PASSWORD_HASH, '微信账号不落可用口令');

    const row = await ownerPool.query(
      'SELECT user_id, unionid, nickname FROM oauth_identities WHERE provider = $1 AND openid = $2',
      ['wechat', openid]
    );
    assert.equal(row.rows.length, 1, '身份行必须与账号同批落库');
    assert.equal(row.rows[0].user_id, user.id);
    assert.equal(row.rows[0].unionid, 'PG-UNIONID-create');
  });

  t('★ 身份行插失败时整笔回滚：不得留下「有账号、无任何登录方式」的孤儿', async () => {
    const { openid } = await newWechatAccount('dup');
    const before = await userCount();

    // 同一个 openid（身份索引冲突）但**换一个邮箱**，让 users 那一步先成功 ——
    // 这样冲突只会发生在身份行上，从而真正验证「后一步失败要回滚前一步」
    await assert.rejects(
      () =>
        runWithSystem('pg oauth 用例：并发同 openid 建号（触发身份唯一冲突）', () =>
          createWechatUserWithIdentity({
            provider: 'wechat',
            openid,
            unionid: null,
            nickname: '重复',
            avatarUrl: null,
            email: 'wx_pg-dup-second@wechat.invalid',
            passwordHash: OAUTH_UNSET_PASSWORD_HASH,
          })
        ),
      (e: any) => {
        assert.equal(
          e?.code,
          '23505',
          `唯一冲突必须原样穿透（23505），而不是被 handlePgError 变成 503 —— ` +
            `并发收敛全靠它：实际 ${e?.code} ${e?.message}`
        );
        return true;
      }
    );

    assert.equal(await userCount(), before, '事务必须整体回滚，users 行不得残留');
    const orphan = await ownerPool.query('SELECT id FROM users WHERE email = $1', [
      'wx_pg-dup-second@wechat.invalid',
    ]);
    assert.equal(orphan.rows.length, 0, '孤儿账号（有 users 行、无身份行）绝不允许存在');
  });

  t('findOAuthIdentity：如实回传 deleted_at，不替业务做 F4 判断', async () => {
    const { openid, user } = await newWechatAccount('softdel');

    const live = await runWithSystem('pg oauth 用例：按 openid 查身份（登录前无租户）', () =>
      findOAuthIdentity('wechat', openid)
    );
    assert.equal(live?.user.id, user.id);
    assert.equal(live?.user.deleted_at ?? null, null);

    await ownerPool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [user.id]);
    const soft = await runWithSystem('pg oauth 用例：软删后按 openid 查身份', () =>
      findOAuthIdentity('wechat', openid)
    );
    assert.ok(soft, '软删后仍必须查得到 —— 「注销不得复活」是 service 层的判断，不是仓储的');
    assert.ok(soft!.user.deleted_at, 'deleted_at 必须如实回传，否则 service 无从判断');
  });

  t('rebindOAuthIdentityToNewUser：建新账号并把身份行**重指**过去（不复活旧账号）', async () => {
    const { openid, user: oldUser } = await newWechatAccount('rebind');
    await ownerPool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [oldUser.id]);

    const identity = await runWithSystem('pg oauth 用例：取待重指的身份行', () =>
      findOAuthIdentity('wechat', openid)
    );
    assert.ok(identity);

    const fresh = await runWithSystem('pg oauth 用例：F4 注销后重登（重指身份到新账号）', () =>
      rebindOAuthIdentityToNewUser({
        identityId: identity!.identity.id,
        provider: 'wechat',
        openid,
        unionid: null,
        nickname: '重登',
        avatarUrl: null,
        email: 'wx_pg-rebind-new@wechat.invalid',
        passwordHash: OAUTH_UNSET_PASSWORD_HASH,
      })
    );
    createdUserIds.push(fresh.id);

    assert.notEqual(fresh.id, oldUser.id, '必须建新账号，不能复活已注销的那个');
    const rows = await ownerPool.query(
      'SELECT user_id FROM oauth_identities WHERE provider = $1 AND openid = $2',
      ['wechat', openid]
    );
    assert.equal(rows.rows.length, 1, '身份行必须仍是一行（重指，而不是新插一行）');
    assert.equal(rows.rows[0].user_id, fresh.id);
  });

  t('bindVerifiedEmail：置 email_verified=TRUE、清 verify_token，并返回新行', async () => {
    const { user } = await newWechatAccount('bind');
    await ownerPool.query(
      `UPDATE users SET email_verified = FALSE, verify_token = 'stale-token',
              verify_expires_at = NOW() + interval '1 day'
        WHERE id = $1`,
      [user.id]
    );

    const updated = await runWithUser(user.id, () =>
      bindVerifiedEmail(user.id, 'oauth-pg-bound@test.local')
    );
    assert.equal(updated?.email, 'oauth-pg-bound@test.local');
    assert.equal(
      updated?.email_verified,
      true,
      '邮箱已由验证码证明归属，必须保持 TRUE —— 置 false 会让该账号全部 chat 被 403（admin 换绑函数就是这样，故不能复用它）'
    );
    assert.equal(updated?.verify_token ?? null, null, '不得留下永不寄出的 verify_token');

    // 必须是 RETURNING 的新行：内存分支曾因「旧对象引用被就地改写」导致审计取到新值（双模分叉）
    const reread = await runWithUser(user.id, () => findUserById(user.id));
    assert.equal(reread?.email, 'oauth-pg-bound@test.local');
    assert.equal(reread?.email_verified, true);
  });

  t('★ bindVerifiedEmail 撞真实唯一索引 → 23505（PG 侧的兜底真的会响）', async () => {
    await ownerPool.query('UPDATE users SET email = $1, deleted_at = NULL WHERE id = $2', [
      'oauth-pg-taken@test.local',
      BOB,
    ]);
    const { user } = await newWechatAccount('bind-conflict');

    await assert.rejects(
      () => runWithUser(user.id, () => bindVerifiedEmail(user.id, 'oauth-pg-taken@test.local')),
      (e: any) => {
        assert.equal(e?.code, '23505', `应为唯一索引冲突，实际 ${e?.code} ${e?.message}`);
        return true;
      }
    );
  });

  t('★ partial 唯一索引语义：目标邮箱属于**已注销**账号时可以绑成功', async () => {
    await ownerPool.query('UPDATE users SET email = $1, deleted_at = NOW() WHERE id = $2', [
      'oauth-pg-orphan@test.local',
      BOB,
    ]);
    const { user } = await newWechatAccount('bind-orphan');

    const ok = await runWithUser(user.id, () =>
      bindVerifiedEmail(user.id, 'oauth-pg-orphan@test.local')
    );
    assert.equal(
      ok?.email,
      'oauth-pg-orphan@test.local',
      '唯一索引是 partial（WHERE deleted_at IS NULL），已注销行不占位 —— 与 F4「同邮箱可重新注册为新 id」一致'
    );

    // 复原 BOB：必须先改回原邮箱再取消注销，否则会和上面那条活体行一起撞 partial 唯一索引
    await ownerPool.query('UPDATE users SET email = $1 WHERE id = $2', [BOB_EMAIL, BOB]);
    await ownerPool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [BOB]);
  });

  t('findOAuthIdentityByUserId / destroyOAuthIdentity 的返回值语义', async () => {
    const { openid, user } = await newWechatAccount('destroy');

    const mine = await runWithUser(user.id, () => findOAuthIdentityByUserId(user.id, 'wechat'));
    assert.equal(mine?.openid, openid);
    assert.equal(mine?.user_id, user.id);

    assert.equal(await runWithUser(user.id, () => destroyOAuthIdentity(user.id, 'wechat')), 1);
    assert.equal(
      await runWithUser(user.id, () => destroyOAuthIdentity(user.id, 'wechat')),
      0,
      '二次解绑返回 0 —— admin 端点据此回 404'
    );
    assert.equal(await runWithUser(user.id, () => findOAuthIdentityByUserId(user.id, 'wechat')), null);
  });

  // ---------- 组二：隔离真的生效吗（需要受限角色）----------

  t('★ 受限角色下：oauth_identities 的行级隔离真的生效（含 system 跨租户对照）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const { user: bobUser } = await newWechatAccount('iso-bob');

    const foreign = await runWithUser(ALICE, () => findOAuthIdentityByUserId(bobUser.id, 'wechat'));
    assert.equal(foreign, null, 'alice 不该看得见 bob 的第三方身份绑定（RLS 拦成零行）');

    const own = await runWithUser(bobUser.id, () => findOAuthIdentityByUserId(bobUser.id, 'wechat'));
    assert.ok(own, '本人必须查得到自己的绑定');

    const across = await runWithSystem('pg oauth 用例：system 跨租户查身份（登录前路径的前提）', () =>
      findOAuthIdentityByUserId(bobUser.id, 'wechat')
    );
    assert.ok(across, 'system 作用域（BYPASSRLS）必须看得见 —— 登录前按 openid 查身份靠它');
  });

  t('★ 受限角色下：WITH CHECK 拒绝「user 作用域下建号」与「给他人写身份行」，且确未落库', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    // (a) 建号：users 的策略要求 id = app.user_id，而新账号 id 是随机的 → 必被拒。
    //     这条同时钉住「createWechatUserWithIdentity 必须在 system 作用域下调用」
    await assert.rejects(
      () =>
        runWithUser(ALICE, () =>
          createWechatUserWithIdentity({
            provider: 'wechat',
            openid: 'PG-OPENID-misuse',
            unionid: null,
            nickname: '越权建号',
            avatarUrl: null,
            email: 'wx_pg-misuse@wechat.invalid',
            passwordHash: OAUTH_UNSET_PASSWORD_HASH,
          })
        ),
      (e: any) => {
        assert.equal(
          e?.code,
          'RLS_VIOLATION',
          `应为 RLS 拒绝（handlePgError 对策略违规抛错、不降级内存），实际 ${e?.code} ${e?.message}`
        );
        return true;
      }
    );
    const leakedUser = await ownerPool.query('SELECT id FROM users WHERE email = $1', [
      'wx_pg-misuse@wechat.invalid',
    ]);
    assert.equal(leakedUser.rows.length, 0, '被拒的写入不得落库');

    // (b) 给他人写身份行：oauth_identities 的 WITH CHECK 必须拦住
    await assert.rejects(
      () =>
        runWithUser(ALICE, () =>
          linkOAuthIdentity({
            userId: BOB,
            provider: 'wechat',
            openid: 'PG-FORGED',
            unionid: null,
            nickname: '伪造归属',
            avatarUrl: null,
          })
        ),
      (e: any) => {
        assert.equal(e?.code, 'RLS_VIOLATION');
        return true;
      }
    );
    const forged = await ownerPool.query('SELECT id FROM oauth_identities WHERE openid = $1', [
      'PG-FORGED',
    ]);
    assert.equal(forged.rows.length, 0, '伪造归属的身份行不得落库');
  });
});
