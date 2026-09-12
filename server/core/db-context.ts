import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级数据库作用域（ADR-0019）。
 *
 * RLS 策略靠 `current_setting('app.user_id')` 判定「这行属于谁」。这个 GUC 由
 * `server/core/db.ts` 在每条查询前用 `set_config(..., true)` 注入，而**值是哪个用户**
 * 由本模块的 AsyncLocalStorage 承载——它随调用链传播，不需要把 userId 一路透传到
 * 71 个仓储函数签名里。
 *
 * 两种作用域：
 * - `user`：租户内请求。查询在 app 角色 + `app.user_id` 下执行，RLS 生效。
 * - `system`：**显式**的跨租户路径（会话按 token 查、登录按邮箱查、匿名分享、
 *   日清任务、admin 运营台聚合、可观测写入）。`reason` 必填——所有 `runWithSystem`
 *   调用点合起来就是「本系统全部 RLS 豁免」的可审计清单。
 *
 * 没有作用域 → `getDb()` 抛 `DB_SCOPE_MISSING` 500（响亮失败）。**刻意不降级**：
 * 静默返回零行会让「漏了作用域」表现为「用户数据凭空消失」，比 500 难查得多。
 */

export type DbScope = { kind: 'user'; userId: string } | { kind: 'system'; reason: string };

const storage = new AsyncLocalStorage<DbScope>();

/** 在「某用户」作用域内执行（RLS 生效） */
export function runWithUser<T>(userId: string, fn: () => T): T {
  return storage.run({ kind: 'user', userId }, fn);
}

/** 在「系统」作用域内执行（跨租户，`BYPASSRLS`）——reason 必填，进审计清单 */
export function runWithSystem<T>(reason: string, fn: () => T): T {
  return storage.run({ kind: 'system', reason }, fn);
}

/** 当前作用域；undefined = 尚未建立（仓储此时调用会抛 DB_SCOPE_MISSING） */
export function currentScope(): DbScope | undefined {
  return storage.getStore();
}
