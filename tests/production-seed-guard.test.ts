/**
 * 安全审查 M2 —— 生产环境不播种演示账号（回归套件）
 *
 * 为什么必须**独立一个进程**：演示账号是在 `memory-store.ts` 的**模块导入期**播种的，
 * 而播种判据是导入期读到的 `process.env.NODE_ENV`。要在测试里观察「生产不播种」，
 * 只能在 import 之前就把 NODE_ENV 设成 production（与 j1-production-failfast 同款手法）。
 *
 * 本套件不 import `server/app.ts`：那条链会拉起 mailer，而 mailer 在 production 下缺 SMTP
 * 配置会于模块加载期抛错。这里只需要 memory-store 与 pool 两个纯模块。
 *
 * 非生产仍播种这件事由现有套件覆盖（`s1-data-isolation` / `p-admin-canvas-count` 等都依赖
 * `/api/db/status` 的 userCount ≥ 3，即三个种子账号），此处不重复。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ⚠️ 必须在动态 import 之前：memory-store 的播种发生在模块求值期
process.env.NODE_ENV = 'production';

const { inMemoryStore, DEFAULT_SEED_USER_IDS, dropDefaultSeedUsers } = await import(
  '../server/core/memory-store.js'
);
const { checkRuntimeDbRoleInvariants } = await import('../server/core/pool.js');

const [SEED_ADMIN_ID] = DEFAULT_SEED_USER_IDS;

describe('M2 生产环境不播种演示账号', () => {
  test('生产环境导入 memory-store 后，三个公开口令账号都不存在', () => {
    assert.equal(inMemoryStore.users.size, 0, '生产环境内存模式不得播种任何账号');
    for (const id of DEFAULT_SEED_USER_IDS) {
      assert.equal(inMemoryStore.users.has(id), false, `不应存在种子账号 ${id}`);
    }
  });

  test('dropDefaultSeedUsers 按种子 id 精确清除，且可重复调用', () => {
    // 模拟「NODE_ENV 只写在 .env 里 → 导入期判定落空、种子已被建」的那个时序坑现场
    inMemoryStore.users.set(SEED_ADMIN_ID, {
      id: SEED_ADMIN_ID,
      email: 'admin@deepdive.ai',
      password_hash: 'x',
      name: 'seed',
      role: 'admin',
      email_verified: true,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    assert.equal(dropDefaultSeedUsers(), 1, '应删掉一个种子账号');
    assert.equal(inMemoryStore.users.has(SEED_ADMIN_ID), false);
    assert.equal(dropDefaultSeedUsers(), 0, '幂等：空库再清一次返回 0');
  });

  test('生产环境缺 DATABASE_URL → 拒绝启动（部署手册「缺则降级内存（生产禁止）」的落地）', () => {
    const prev = {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SYSTEM_URL: process.env.DATABASE_SYSTEM_URL,
      DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    };
    try {
      delete process.env.DATABASE_URL;
      delete process.env.DATABASE_SYSTEM_URL;
      delete process.env.DATABASE_ADMIN_URL;

      const problems = checkRuntimeDbRoleInvariants();
      assert.ok(
        problems.some((p) => p.includes('DATABASE_URL')),
        `应报出「生产缺 DATABASE_URL」：${JSON.stringify(problems)}`
      );
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('生产环境配齐 DATABASE_URL 与 DATABASE_SYSTEM_URL → 不再报该条', () => {
    const prev = {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SYSTEM_URL: process.env.DATABASE_SYSTEM_URL,
      DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    };
    try {
      process.env.DATABASE_URL = 'postgres://app:pw@127.0.0.1:5432/arborize';
      process.env.DATABASE_SYSTEM_URL = 'postgres://system:pw@127.0.0.1:5432/arborize';
      delete process.env.DATABASE_ADMIN_URL;

      const problems = checkRuntimeDbRoleInvariants();
      assert.equal(problems.length, 0, `配齐后不应有问题：${JSON.stringify(problems)}`);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('非生产不做这些断言（判据边界：只有 production 才拦）', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;
      assert.deepEqual(checkRuntimeDbRoleInvariants(), [], '开发环境不该被启动断言拦住');
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
