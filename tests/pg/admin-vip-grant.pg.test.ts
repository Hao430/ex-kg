/**
 * #0103 PG 真库回归 — grantUserVipDays 并发增授防丢天数（PG SQL 单条 UPDATE 叠期）。
 *
 * 运行方式：
 *   docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *   PG_SMOKE=1 npx tsx --test tests/pg/admin-vip-grant.pg.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';

const { initDbSchema } = await import('../../server/core/schema.js');
const { getSystemPool } = await import('../../server/core/pool.js');
const { runWithSystem } = await import('../../server/core/db-context.js');
const { grantUserVipDays } = await import('../../server/repositories/user.repository.js');

let targetUserId = '';
let adminUserId = '';

/** 绕过仓储直查（system 池） */
async function pgQuery(sql: string, params: unknown[] = []): Promise<any[]> {
  const p = getSystemPool();
  if (!p) throw new Error('PG 未就绪：请检查 DATABASE_URL / PG_TEST_URL');
  return (await p.query(sql, params)).rows;
}

async function getVipExpiryMs(userId: string): Promise<number | null> {
  const rows = await pgQuery('SELECT vip_expires_at FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !rows[0].vip_expires_at) return null;
  return new Date(rows[0].vip_expires_at).getTime();
}

describe('PG #0103: grantUserVipDays 原子单条 UPDATE 并发回归', () => {
  before(async () => {
    if (!RUN) return;
    await initDbSchema();
    const p = getSystemPool();
    if (!p) throw new Error('PG 未就绪');

    const resUser = await p.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, 'pg-hash', 'pg-user', 'user') RETURNING id`,
      [`pg-vip-grant-user-${Date.now()}@example.com`]
    );
    targetUserId = resUser.rows[0].id as string;

    const resAdmin = await p.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, 'pg-hash', 'pg-admin', 'admin') RETURNING id`,
      [`pg-vip-grant-admin-${Date.now()}@example.com`]
    );
    adminUserId = resAdmin.rows[0].id as string;
  });

  after(async () => {
    if (!RUN) return;
    const p = getSystemPool();
    if (!p) return;
    if (targetUserId) {
      await p.query('DELETE FROM users WHERE id = $1', [targetUserId]);
    }
    if (adminUserId) {
      await p.query('DELETE FROM users WHERE id = $1', [adminUserId]);
    }
    await p.end();
  });

  t('PG: 首次增授 10 天，到期时间约为 NOW() + 10 天', async () => {
    const baseNow = Date.now();
    await runWithSystem('#0103-test-first-grant', () => grantUserVipDays(targetUserId, 10));

    const expiry = await getVipExpiryMs(targetUserId);
    assert.ok(expiry, 'vip_expires_at 应存在');

    const added = (expiry - baseNow) / 86400000;
    assert.ok(added > 9.9 && added < 10.1, `应约为 10 天后，实际 ${added}`);

    const roleRows = await pgQuery('SELECT role FROM users WHERE id = $1', [targetUserId]);
    assert.equal(roleRows[0].role, 'vip');
  });

  t('PG: 并发两次增授（7 天 + 30 天）两单天数都不丢，原子叠满 37 天', async () => {
    const beforeExpiry = (await getVipExpiryMs(targetUserId))!;

    // 两个管理员同时增授：单条 UPDATE 在 READ COMMITTED 下后到者按前者的已提交值重新求值
    await Promise.all([
      runWithSystem('#0103-concurrent-grant-7', () => grantUserVipDays(targetUserId, 7)),
      runWithSystem('#0103-concurrent-grant-30', () => grantUserVipDays(targetUserId, 30)),
    ]);

    const afterExpiry = (await getVipExpiryMs(targetUserId))!;
    const addedDays = (afterExpiry - beforeExpiry) / 86400000;

    assert.ok(
      addedDays > 36.9 && addedDays < 37.1,
      `并发 7+30 天共 37 天必须全部叠上，实际增加了 ${addedDays} 天`
    );
  });

  t('PG: days=0 撤销 VIP，vip_expires_at 置 NULL，role 降为 user', async () => {
    await runWithSystem('#0103-revoke-vip', () => grantUserVipDays(targetUserId, 0));

    const rows = await pgQuery('SELECT role, vip_expires_at FROM users WHERE id = $1', [targetUserId]);
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].vip_expires_at, null);
  });

  t('PG: 给 admin 增授与撤销 VIP，其 role 恒为 admin 不被降级', async () => {
    await runWithSystem('#0103-admin-grant', () => grantUserVipDays(adminUserId, 10));
    let rows = await pgQuery('SELECT role, vip_expires_at FROM users WHERE id = $1', [adminUserId]);
    assert.equal(rows[0].role, 'admin', 'admin 角色增授 VIP 不得变更为 vip');
    assert.ok(rows[0].vip_expires_at);

    await runWithSystem('#0103-admin-revoke', () => grantUserVipDays(adminUserId, 0));
    rows = await pgQuery('SELECT role, vip_expires_at FROM users WHERE id = $1', [adminUserId]);
    assert.equal(rows[0].role, 'admin', 'admin 角色撤销 VIP 不得降级为 user');
    assert.equal(rows[0].vip_expires_at, null);
  });
});
