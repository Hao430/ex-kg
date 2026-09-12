import type pg from 'pg';
import { AppError } from '../lib/errors.js';
import { getAppPool, getSystemPool } from './pool.js';
import { currentScope } from './db-context.js';

/**
 * 仓储层唯一数据库句柄（ADR-0019）。
 *
 * 取代此前直接 `getPool()` 的写法：那时的 126 处 `.query(` 全是**无作用域**的直连，
 * RLS 策略里的 `app.user_id` 恒为空——策略加上去也只会把所有人拦成零行。
 * `getDb()` 把「这条查询代表谁」变成每一条查询都必须回答的问题：
 *
 * - 无作用域 → `DB_SCOPE_MISSING`（500，响亮）；**不静默降级**，理由见 db-context.ts。
 * - `system` 作用域 → system 池直连（`BYPASSRLS`），无事务包装。
 * - `user` 作用域 → app 池取连接 → `BEGIN` → `set_config('app.user_id', $1, true)` → 查询 → `COMMIT`。
 *
 * ⚠️ **`set_config(..., is_local => true)` 必须在显式事务里**：事务外 PostgreSQL 只发一条
 * warning 就忽略它，查询会以「无 app.user_id」执行 → RLS 返回零行。这是本设计里最容易
 * 静默出错的一点，故每条 query 都自带 BEGIN/COMMIT，绝不在事务外注入 GUC。
 *
 * 单条查询包一层事务在语义上等价于 autocommit（单语句本就原子），代价是每查询多几次
 * 本地往返；写路径（多条语句必须原子）一律走 `withTransaction`，只 BEGIN 一次。
 */

export interface DbHandle {
  /** 执行单条语句（自动 BEGIN + 注入作用域 + COMMIT） */
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
  /** 在同一连接/同一作用域内执行多条语句（BEGIN → fn → COMMIT/ROLLBACK → release） */
  withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}

const SCOPE_MISSING_MESSAGE =
  '数据库访问缺少请求作用域：请用 runWithUser() 或 runWithSystem(reason) 包裹调用（ADR-0019）';

function missingScope(): AppError {
  return new AppError(500, 'DB_SCOPE_MISSING', SCOPE_MISSING_MESSAGE);
}

/** 在给定连接上注入当前用户作用域（必须在事务内调用） */
async function applyUserScope(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
}

/**
 * 取池。正常路径不可达：`getDb()` 已保证 `DATABASE_URL` 存在，而 system 池缺省回落
 * `DATABASE_URL`（见 pool.ts），故两个池必有一个可用。这里只做防御性兜底——但**错误码必须
 * 与 DB_SCOPE_MISSING 区分开**：那是「调用方忘了包作用域」的应用 bug，这是配置故障，
 * 混用会把排障方向指反。
 */
function requirePool(kind: 'app' | 'system'): pg.Pool {
  const pool = kind === 'system' ? getSystemPool() : getAppPool();
  if (!pool) {
    throw new AppError(
      500,
      'DB_POOL_UNAVAILABLE',
      `数据库连接池不可用（${kind}）：请检查 DATABASE_URL / DATABASE_SYSTEM_URL 配置（ADR-0019）`
    );
  }
  return pool;
}

const handle: DbHandle = {
  async query<R extends pg.QueryResultRow = any>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<R>> {
    const scope = currentScope();
    if (!scope) throw missingScope();

    if (scope.kind === 'system') {
      return requirePool('system').query<R>(text, params as any[]);
    }

    const pool = requirePool('app');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyUserScope(client, scope.userId);
      const result = await client.query<R>(text, params as any[]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const scope = currentScope();
    if (!scope) throw missingScope();

    if (scope.kind === 'system') {
      const pool = requirePool('system');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const pool = requirePool('app');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyUserScope(client, scope.userId);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
};

/**
 * 取数据库句柄；`null` ⇔ `DATABASE_URL` 未配置（与既有双模判据同口径）。
 * 返回 null 时调用方照旧落内存分支——内存模式不经过本模块，故作用域要求
 * 不会泄漏进内存测试套件。
 */
export function getDb(): DbHandle | null {
  if (!getAppPool()) return null;
  return handle;
}
