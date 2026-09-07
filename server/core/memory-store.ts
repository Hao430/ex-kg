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
  /** 注册邮箱验证码（email 为 key，一邮箱一码） */
  emailVerificationCodes: new Map<string, import('./records.js').EmailCodeRecord>(),
};

/** 审计日志内存上限：最新在前，超出裁剪最旧记录 */
const AUDIT_LOGS_MAX = 1000;

export function trimAuditLogs(): void {
  if (inMemoryStore.auditLogs.length > AUDIT_LOGS_MAX) {
    inMemoryStore.auditLogs.length = AUDIT_LOGS_MAX;
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
