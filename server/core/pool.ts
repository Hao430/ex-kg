import pg from 'pg';

const { Pool } = pg;

/**
 * 三个数据库角色 → 三个连接池（ADR-0019）。
 *
 * | 池 | 环境变量 | 角色 | 权限 |
 * | :--- | :--- | :--- | :--- |
 * | app | `DATABASE_URL` | `arborize_app` | DML-only，**受 RLS 约束** |
 * | system | `DATABASE_SYSTEM_URL` | `arborize_system` | DML-only + `BYPASSRLS` |
 * | admin | `DATABASE_ADMIN_URL` | `syf_minapp`（表属主） | 全部 + DDL，**仅迁移** |
 *
 * **owner 凭据不进运行期进程**：`DATABASE_ADMIN_URL` 只由部署期的迁移步骤注入
 * （`server/core/migrate-cli.ts`），不得写进运行期 `.env`。
 * `checkRuntimeDbRoleInvariants()` 在启动时对生产环境断言这一点。
 *
 * 本模块**不再导出无差别的 `getPool()`**——那等于给出一条绕过作用域的通道。
 * 业务代码一律走 `server/core/db.ts` 的 `getDb()`（自带作用域校验）。
 */

type PoolKind = 'app' | 'system' | 'admin';

const pools: Partial<Record<PoolKind, pg.Pool>> = {};

/** 各池的连接串读取（运行期读 process.env，规避 dotenv 时序坑） */
function connectionStringFor(kind: PoolKind): string | undefined {
  switch (kind) {
    case 'app':
      return process.env.DATABASE_URL;
    case 'system':
      // 未单独配置时回落 DATABASE_URL：让「加 DATABASE_SYSTEM_URL」这一步本身
      // 对行为零影响（发布顺序第 3 步），也让本地开发/内存测试无需多配一个变量。
      // 生产的环境不变量由 checkRuntimeDbRoleInvariants() 保证不静默用错角色。
      return process.env.DATABASE_SYSTEM_URL || process.env.DATABASE_URL;
    case 'admin':
      return process.env.DATABASE_ADMIN_URL;
  }
}

function createPool(connectionString: string, kind: PoolKind): pg.Pool {
  const isSystemish = kind !== 'app';
  const pool = new Pool({
    connectionString,
    ssl:
      connectionString.includes('sslmode=require') ||
      connectionString.includes('neon.tech') ||
      connectionString.includes('supabase')
        ? { rejectUnauthorized: false }
        : false,
    // app 池承担全部用户请求；system 路径（会话查 token、登录查邮箱、匿名分享、
    // 日清、admin 聚合）并发低得多，给 10 足够且不与 app 争抢 PG 的 max_connections。
    max: kind === 'admin' ? 2 : isSystemish ? 10 : 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
    // 迁移的 DDL 不受 5s 语句超时约束（大表加列/建索引可能很久）
    ...(kind === 'admin' ? {} : { statement_timeout: 5000 }),
  });

  pool.on('error', (err) => {
    console.error(`Unexpected PostgreSQL client error on idle ${kind} connection:`, err);
  });

  return pool;
}

function getPoolOf(kind: PoolKind): pg.Pool | null {
  const connectionString = connectionStringFor(kind);
  if (!connectionString) return null;
  if (!pools[kind]) {
    pools[kind] = createPool(connectionString, kind);
  }
  return pools[kind]!;
}

/** 运行期主体池（受 RLS 约束）——未配置 `DATABASE_URL` 即内存模式，返回 null */
export function getAppPool(): pg.Pool | null {
  return getPoolOf('app');
}

/** 跨租户路径池（`BYPASSRLS`）——未配置时回落 app 连接串 */
export function getSystemPool(): pg.Pool | null {
  return getPoolOf('system');
}

/** 迁移专用池（owner）——**只允许 `server/core/migrate-cli.ts` 调用** */
export function getAdminPool(): pg.Pool | null {
  return getPoolOf('admin');
}

/**
 * 迁移执行池：优先 owner（`DATABASE_ADMIN_URL`），缺省回落 system/app。
 * 回落是给本地开发与内存测试用的便利——**受限角色跑 DDL 会失败**，而失败正是
 * 期望行为：生产迁移必须显式提供 owner 连接串，否则宁可迁移报错，也不要半个 schema。
 */
export function getMigrationPool(): pg.Pool | null {
  return getPoolOf('admin') ?? getSystemPool();
}

/** 关闭全部池（测试收尾 / 优雅退出） */
export async function closePools(): Promise<void> {
  await Promise.all(Object.values(pools).map((p) => p?.end().catch(() => {})));
  for (const kind of Object.keys(pools) as PoolKind[]) delete pools[kind];
}

/**
 * 生产环境启动断言（ADR-0019）：
 * 1. **owner 凭据不得出现在运行期进程**——`DATABASE_ADMIN_URL` 一旦出现，说明迁移凭据
 *    被写进了运行期 `.env`（最坏情况：应用进程持 DDL 权限，RLS 的意义被完全抵消）。
 * 2. 配了 `DATABASE_URL` 就必须显式配 `DATABASE_SYSTEM_URL`——否则 system 池会**回落**
 *    到 app 角色，会话查询等跨租户路径会被 RLS 静默拦成零行，表现为「所有人登录失效」。
 *    响亮拒绝启动，好过带着静默错误对外服务。
 *
 * 返回错误信息数组（空 = 通过）；由 `server.ts` 决定打印并退出，
 * 便于本函数被测试直接调用而不牵连进程退出。
 */
export function checkRuntimeDbRoleInvariants(): string[] {
  if (process.env.NODE_ENV !== 'production') return [];

  const problems: string[] = [];
  if (process.env.DATABASE_ADMIN_URL) {
    problems.push(
      '检测到运行期进程持有 DATABASE_ADMIN_URL（owner/DDL 凭据）。迁移必须在部署期独立步骤执行，' +
        'owner 连接串不得写入 .env（ADR-0019）。'
    );
  }
  if (process.env.DATABASE_URL && !process.env.DATABASE_SYSTEM_URL) {
    problems.push(
      '生产环境配置了 DATABASE_URL 但缺少 DATABASE_SYSTEM_URL：system 池会回落到 app 角色，' +
        '跨租户路径（会话查询、匿名分享、日清、admin 聚合）将被 RLS 拦成零行（ADR-0019）。'
    );
  }
  return problems;
}
