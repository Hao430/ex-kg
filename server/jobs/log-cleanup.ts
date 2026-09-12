/**
 * Spec F6：日志留存清理任务。
 * - AI 推演日志：AI_LOG_RETENTION_DAYS（默认 90 天）
 * - 审计日志：AUDIT_LOG_RETENTION_DAYS（默认 180 天）
 * - 业务事件日志：EVENT_LOG_RETENTION_DAYS（默认 180 天，Spec I）
 * - 已注销用户（软删除）：DELETED_USER_RETENTION_DAYS（默认 30 天，Spec F4）
 * - 画布节点/边墓碑：CANVAS_TOMBSTONE_RETENTION_DAYS（默认 30 天，ADR-0017）
 * 启动时执行一次，此后每 24 小时执行；异常仅告警。
 */
import { cleanupOldAiLogs } from '../repositories/ai.repository.js';
import { cleanupOldAuditLogs } from '../repositories/audit.repository.js';
import { cleanupOldEventLogs } from '../repositories/event-log.repository.js';
import { cleanupDeletedUsers } from '../repositories/user.repository.js';
import { cleanupExpiredSessions } from '../repositories/session.repository.js';
import { cleanupCanvasTombstones } from '../repositories/canvas.repository.js';
import { getDb } from '../core/db.js';
import { runWithSystem } from '../core/db-context.js';

const DAY_MS = 24 * 3600 * 1000;

export function startLogCleanupJob(): void {
  const aiRetention = parseInt(process.env.AI_LOG_RETENTION_DAYS || '90', 10);
  const auditRetention = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '180', 10);
  const eventRetention = parseInt(process.env.EVENT_LOG_RETENTION_DAYS || '180', 10);
  const deletedUserRetention = parseInt(process.env.DELETED_USER_RETENTION_DAYS || '30', 10);
  const tombstoneRetention = parseInt(process.env.CANVAS_TOMBSTONE_RETENTION_DAYS || '30', 10);

  const run = async () => {
    try {
      // 技术债 #0011：首跑前先探活 PG，避免启动竞态下首跑静默落内存分支造成「清理假成功」。
      // 迁移已移出应用进程（ADR-0019，改为部署期 migrate 步骤），此处**只验连通性**，
      // 不再借 initDbSchema 当就绪信号；池自带 3s 连接超时，不会无限阻塞。
      await runWithSystem('log-cleanup: PG 连通性探活', async () => {
        await getDb()?.query('SELECT 1');
      });

      // 六个清理任务全是跨租户批量删除，显式 system 作用域（ADR-0019）
      const { ai, audit, events, deletedUsers, expiredSessions, tombstones } = await runWithSystem(
        'log-cleanup: 每日留存清理（跨租户批量删除）',
        async () => ({
          ai: await cleanupOldAiLogs(aiRetention),
          audit: await cleanupOldAuditLogs(auditRetention),
          events: await cleanupOldEventLogs(eventRetention),
          deletedUsers: await cleanupDeletedUsers(deletedUserRetention),
          expiredSessions: await cleanupExpiredSessions(),
          tombstones: await cleanupCanvasTombstones(tombstoneRetention),
        })
      );
      if (
        ai > 0 ||
        audit > 0 ||
        events > 0 ||
        deletedUsers > 0 ||
        expiredSessions > 0 ||
        tombstones.nodes > 0 ||
        tombstones.edges > 0
      ) {
        console.log(
          `[log-cleanup] 清理完成：ai_request_logs ${ai} 条、user_audit_logs ${audit} 条、event_logs ${events} 条、已注销用户硬删 ${deletedUsers} 个、过期会话 ${expiredSessions} 条、画布墓碑 ${tombstones.nodes} 节点 / ${tombstones.edges} 边`
        );
      }
    } catch (e) {
      console.warn('[log-cleanup] 清理失败（下个周期重试）:', e);
    }
  };

  void run();
  const timer = setInterval(run, DAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
