import { AppError } from '../lib/errors.js';

/**
 * Spec J1（跟踪清单 E2）：PG 故障的统一处理闸门。
 *
 * - 生产环境（NODE_ENV=production）配置了 DATABASE_URL 时，任何 PG 查询失败
 *   一律抛 503 DB_UNAVAILABLE——「配了库就必须用库」，禁止静默降级内存造成 200 假成功。
 * - 开发/测试环境保持原有内存降级行为不变（本函数仅记录故障时间戳）。
 * - 故障时间戳暴露给 /api/db/status 的 degraded 字段，供部署层探活告警
 *   （degraded 持续 >60s 告警或重启）。
 */
const PG_ERROR_WINDOW_MS = 60_000;

let lastPgErrorAt: number | null = null;

/** 生产环境且明确配置了数据库：PG 是硬依赖，不可降级 */
export function isProductionDbRequired(): boolean {
  return process.env.NODE_ENV === 'production' && Boolean(process.env.DATABASE_URL);
}

/** 记录一次 PG 故障（供 degraded 健康信号） */
export function notePgError(): void {
  lastPgErrorAt = Date.now();
}

/** 最近 PG_ERROR_WINDOW_MS 内是否出现过 PG 故障 */
export function pgDegraded(): boolean {
  return lastPgErrorAt !== null && Date.now() - lastPgErrorAt < PG_ERROR_WINDOW_MS;
}

/**
 * 仓储层 catch 块的统一入口：先记录故障，再按环境决定放行降级或 fail-fast。
 * 用法：
 *   } catch (e) {
 *     handlePgError(e);
 *     console.warn('PG xxx fallback to in-memory:', e);
 *   }
 * 注意：业务错误（AppError 子类）必须在 catch 之前 rethrow 的既有约定不变，
 * handlePgError 只应看到真正的 PG/意外错误。
 */
export function handlePgError(e: unknown): void {
  notePgError();
  const err = e as { code?: string; message?: string } | undefined;
  const detail = `code=${err?.code ?? '-'} message=${err?.message ?? String(e)}`;
  if (isProductionDbRequired()) {
    // 生产 fail-fast 会直接抛错，调用方 catch 里的 console.warn 永远执行不到 →
    // 真实 PG 错误必须在这里落日志，否则线上只剩 503 无从排查。
    // 2026-09-10 踩坑：billing 下单报 42P08 时日志里干干净净，只能手写脚本复现。
    console.error(`[db-guard] PG 查询失败，生产 fail-fast → 503 DB_UNAVAILABLE | ${detail}`);
    throw new AppError(503, 'DB_UNAVAILABLE', '数据库暂时不可用，请稍后重试');
  }
  console.warn(`[db-guard] PG 查询失败，降级内存 | ${detail}`);
}
