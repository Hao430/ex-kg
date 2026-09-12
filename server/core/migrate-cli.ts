/**
 * 部署期数据库迁移入口（ADR-0019）。
 *
 * 为什么独立成进程，而不是让应用启动时顺手迁移：
 * - **owner 凭据不进运行期进程**：`DATABASE_ADMIN_URL` 只在 CD 的 migrate 步骤注入，
 *   运行期 `.env` 里不允许出现（`checkRuntimeDbRoleInvariants()` 会拒绝启动）；
 * - **迁移失败必须中止发布且不重启**：旧进程继续服务，而不是起一个半 schema 的新进程；
 * - 应用的**每个请求路径**都不再承担 DDL。
 *
 * `initDbSchema()` 仍是 schema 的唯一事实源（不引入迁移框架），只是换了执行时机与角色。
 *
 * 退出码：`0` = 迁移成功；`1` = 失败（CD 据此中止发布）。
 * ⚠️ 两条日志原文是 CD 的 grep 判据，**不得改写**（见 `server/core/schema.ts`）：
 *   - `✅ PostgreSQL schema & users verified and initialized.`
 *   - `Failed to initialize PostgreSQL schema:`
 *
 * 非生产环境（`npm run migrate:dev`）允许回落 system/app 连接串，方便本地开发；
 * 受限角色跑 DDL 会失败，而**失败正是期望行为**：宁可迁移报错，也不要半个 schema。
 */
import dotenv from 'dotenv';
import { closePools, getAdminPool, getMigrationPool } from './pool.js';
import { initDbSchema } from './schema.js';

async function main(): Promise<number> {
  dotenv.config();

  const isProduction = process.env.NODE_ENV === 'production';
  const hasAdminCredential = Boolean(getAdminPool());

  // 生产必须显式提供 owner 凭据：不以 DATABASE_URL 回落。
  // 回落会让迁移以受限角色执行，在第一条 DDL 上就失败——但错误信息指向具体 SQL，
  // 排障时会误以为是 schema 问题而非「凭据没注入」。这里提前说清楚。
  if (isProduction && !hasAdminCredential) {
    console.error(
      '❌ 生产环境 migrate 必须显式提供 DATABASE_ADMIN_URL（owner 凭据）：' +
        '迁移不对 DATABASE_URL 回落，否则会以受限角色执行并在 DDL 上失败（ADR-0019）。'
    );
    return 1;
  }

  if (!getMigrationPool()) {
    console.error('❌ migrate 未配置任何数据库连接串（需要 DATABASE_ADMIN_URL）。');
    return 1;
  }

  if (!hasAdminCredential) {
    console.warn(
      '[migrate] 未配置 DATABASE_ADMIN_URL，回落到受限角色连接串执行迁移——仅限本地开发；' +
        '若在这里看到 DDL 权限错误（42501），那是预期行为。'
    );
  }

  const ok = await initDbSchema();
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    // 与 schema.ts 的同名日志保持一致，保证 CD 的 grep 对「抛错」与「返回 false」两条路径都命中
    console.error('Failed to initialize PostgreSQL schema:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 关闭全部池后事件循环自然排空，进程以 process.exitCode 退出。
    // 刻意不调用 process.exit()：那会截断异步 stdout 写入，日志可能丢行。
    await closePools();
  });
