/**
 * Spec F6：日志留存清理任务。
 * - AI 推演日志：AI_LOG_RETENTION_DAYS（默认 90 天）
 * - 审计日志：AUDIT_LOG_RETENTION_DAYS（默认 180 天）
 * - 已注销用户（软删除）：DELETED_USER_RETENTION_DAYS（默认 30 天，Spec F4）
 * 启动时执行一次，此后每 24 小时执行；异常仅告警。
 */
import { cleanupOldAiLogs } from '../repositories/ai.repository.js';
import { cleanupOldAuditLogs } from '../repositories/audit.repository.js';
import { cleanupDeletedUsers } from '../repositories/user.repository.js';

const DAY_MS = 24 * 3600 * 1000;

export function startLogCleanupJob(): void {
  const aiRetention = parseInt(process.env.AI_LOG_RETENTION_DAYS || '90', 10);
  const auditRetention = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '180', 10);
  const deletedUserRetention = parseInt(process.env.DELETED_USER_RETENTION_DAYS || '30', 10);

  const run = async () => {
    try {
      const ai = await cleanupOldAiLogs(aiRetention);
      const audit = await cleanupOldAuditLogs(auditRetention);
      const deletedUsers = await cleanupDeletedUsers(deletedUserRetention);
      if (ai > 0 || audit > 0 || deletedUsers > 0) {
        console.log(`[log-cleanup] 清理完成：ai_request_logs ${ai} 条、user_audit_logs ${audit} 条、已注销用户硬删 ${deletedUsers} 个`);
      }
    } catch (e) {
      console.warn('[log-cleanup] 清理失败（下个周期重试）:', e);
    }
  };

  void run();
  const timer = setInterval(run, DAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
