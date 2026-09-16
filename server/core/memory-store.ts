import { hashPassword } from '../lib/crypto.js';
import type { UserRecord } from './records.js';

/**
 * 内存兜底存储：仅在未配置 DATABASE_URL 或 PG 访问失败时使用。
 * 数据结构：users/sessions/canvases 为 Map，其余为最新在前（unshift）的数组。
 */
export const inMemoryStore = {
  users: new Map<string, UserRecord>(),
  sessions: new Map<string, import('./records.js').SessionRecord>(),
  canvases: new Map<string, import('./records.js').CanvasRecord>(),
  orders: [] as import('./records.js').OrderRecord[],
  aiRequestLogs: [] as import('./records.js').AiRequestLogRecord[],
  systemSettings: new Map<string, any>(),
  feedbacks: [] as import('./records.js').FeedbackRecord[],
  auditLogs: [] as import('./records.js').AuditLogRecord[],
  /** Spec I：业务事件埋点（最新在前） */
  eventLogs: [] as import('./records.js').EventLogRecord[],
  /** 注册邮箱验证码（email 为 key，一邮箱一码） */
  emailVerificationCodes: new Map<string, import('./records.js').EmailCodeRecord>(),
  /** Spec K1：分享记录（canvas_id 为 key，一画板至多一个分享行，与 PG 唯一索引对齐） */
  shares: new Map<string, import('./records.js').ShareRecord>(),
  /** Spec L1：单层画板分组（id 为 key） */
  folders: new Map<string, import('./records.js').FolderRecord>(),
  /**
   * ADR-0022：第三方登录身份绑定（`${provider}:${openid}` 为 key，与 PG 的
   * `(provider, openid)` 唯一索引对齐）。`user_id` 上的清理靠
   * `deleteOAuthIdentitiesForUser`——PG 是 FK `ON DELETE CASCADE`，内存需显式清，
   * 两路必须对齐（先例见 cleanupDeletedUsers 的 purgeUserDataMemory）。
   */
  oauthIdentities: new Map<string, import('./records.js').OAuthIdentityRecord>(),
};

/** 审计日志内存上限：最新在前，超出裁剪最旧记录 */
const AUDIT_LOGS_MAX = 1000;

export function trimAuditLogs(): void {
  if (inMemoryStore.auditLogs.length > AUDIT_LOGS_MAX) {
    inMemoryStore.auditLogs.length = AUDIT_LOGS_MAX;
  }
}

/**
 * 业务事件日志内存上限：最新在前，超出裁剪最旧记录（Spec I）。
 * 技术债 #0047：原 1000 条在 AI 推理密集场景约 200-500 次推理（chat_stream_reset /
 * chat_client_abort / chat_model_candidate_failed 等每帧可能落多条）即滚没，排障窗口
 * 过短；调至 10000（单条约 0.5KB，约 5MB 内存），可经 EVENT_LOGS_MEM_MAX 覆盖
 * （下限 1000，防误配把上限锁死过小）。PG 分支不受此限制——全量落库，按
 * EVENT_LOG_RETENTION_DAYS 留存期清理（BRIN 索引服务范围扫描）。
 */
/**
 * 运行时惰性读取：模块级常量会在 `dotenv.config()` 之前求值（server.ts 的 import 先执行），
 * 那样 EVENT_LOGS_MEM_MAX 恒为 undefined、配置永远不生效——与 alipay-provider 的 APP_URL、
 * mailer 的 dry-run 是同一类坑。2026-09-10 修正。
 */
function eventLogsMax(): number {
  return Math.max(1000, parseInt(process.env.EVENT_LOGS_MEM_MAX || '10000', 10) || 10000);
}

export function trimEventLogs(): void {
  const max = eventLogsMax();
  if (inMemoryStore.eventLogs.length > max) {
    inMemoryStore.eventLogs.length = max;
  }
}

/**
 * Seed default users in inMemoryStore
 */
async function seedDefaultUsers() {
  if (inMemoryStore.users.size === 0) {
    const adminHash = await hashPassword('Admin123456!');
    const userHash = await hashPassword('User123456!');
    const vipHash = await hashPassword('Vip123456!');

    const adminUser: UserRecord = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@deepdive.ai',
      password_hash: adminHash,
      name: '系统管理员',
      role: 'admin',
      email_verified: true,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const normalUser: UserRecord = {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'user@deepdive.ai',
      password_hash: userHash,
      name: '探索先锋',
      role: 'user',
      email_verified: true,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const vipUser: UserRecord = {
      id: '00000000-0000-0000-0000-000000000003',
      email: 'vip@deepdive.ai',
      password_hash: vipHash,
      name: '高级智囊',
      role: 'vip',
      email_verified: true,
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    inMemoryStore.users.set(adminUser.id, adminUser);
    inMemoryStore.users.set(normalUser.id, normalUser);
    inMemoryStore.users.set(vipUser.id, vipUser);
  }
}

// Initial seed trigger
seedDefaultUsers().catch(console.error);
