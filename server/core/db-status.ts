import { getDb } from './db.js';
import { runWithSystem } from './db-context.js';
import { inMemoryStore } from './memory-store.js';
import { isProductionDbRequired, notePgError, pgDegraded } from './db-guard.js';
import type { DbStatus } from './records.js';

/**
 * 内存模式统一口径（2026-09-10 计数对齐）：排除已注销用户及其画板/节点，
 * 与 admin 用户列表 / getAdminOverview 一致。
 */
function memoryCounts(): { userCount: number; canvasCount: number; nodeCount: number } {
  const userCount = Array.from(inMemoryStore.users.values()).filter((u) => !u.deleted_at).length;
  const liveCanvases = Array.from(inMemoryStore.canvases.values()).filter((c) => {
    if (c.deleted_at) return false;
    const owner = inMemoryStore.users.get(c.user_id);
    return Boolean(owner && !owner.deleted_at);
  });
  return {
    userCount,
    canvasCount: liveCanvases.length,
    nodeCount: liveCanvases.reduce((acc, c) => acc + (c.nodes?.length || 0), 0),
  };
}

/**
 * Check DB Status
 * Spec J1：新增 degraded 健康信号——生产环境配置了 DATABASE_URL 而 PG 故障时为 true，
 * 供部署层（探活/编排）持续 degraded >60s 告警或重启；本端点自身保持 200 不参与 fail-fast。
 */
export async function checkDbStatus(): Promise<DbStatus> {
  const db = getDb();
  if (!db) {
    return {
      connected: false,
      type: 'in-memory-fallback',
      message: 'DATABASE_URL 未配置。当前运行于高性能内存回退模式，数据与会话全量就绪。',
      ...memoryCounts(),
      databaseUrlConfigured: false,
      degraded: false,
    };
  }

  try {
    // 平台级计数天然跨租户（公开探活端点，生产剥离具体数值），显式走 system 作用域
    const counts = await runWithSystem('db-status: 平台级探活计数（跨租户聚合）', async () => {
      // 与 admin 用户列表 / overview 同口径：排除已注销用户及其画板/节点
      const uRes = await db.query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL');
      const cRes = await db.query(
        `SELECT COUNT(*) as count FROM canvases c
         JOIN users u ON u.id = c.user_id
         WHERE c.deleted_at IS NULL AND u.deleted_at IS NULL`
      );
      const nRes = await db.query(
        `SELECT COUNT(*) as count FROM nodes n
         JOIN canvases c ON c.id = n.canvas_id
         JOIN users u ON u.id = c.user_id
         WHERE c.deleted_at IS NULL AND u.deleted_at IS NULL AND n.deleted_at IS NULL`
      );
      return {
        userCount: parseInt(uRes.rows[0].count, 10),
        canvasCount: parseInt(cRes.rows[0].count, 10),
        nodeCount: parseInt(nRes.rows[0].count, 10),
      };
    });
    return {
      connected: true,
      type: 'postgresql',
      message: 'PostgreSQL 数据库连接正常，数据存储就绪。',
      ...counts,
      databaseUrlConfigured: true,
      degraded: pgDegraded(),
    };
  } catch (err: any) {
    notePgError();
    const degraded = isProductionDbRequired() || pgDegraded();
    return {
      connected: false,
      type: 'in-memory-fallback',
      message: isProductionDbRequired()
        ? `PostgreSQL 连接异常: ${err?.message || err}。生产模式下写请求将返回 503，请立即检查数据库。`
        : `PostgreSQL 连接异常: ${err?.message || err}。当前自动切换至内存模式保障服务。`,
      ...memoryCounts(),
      databaseUrlConfigured: true,
      degraded,
    };
  }
}
