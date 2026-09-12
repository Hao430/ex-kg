import { getDb } from '../core/db.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { UserRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

export async function listAdminUsers(params: {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
  status?: string;
}): Promise<{ users: (UserRecord & { canvas_count: number; total_tokens_used: number })[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 10));
  const offset = (page - 1) * limit;

  const db = getDb();
  if (db) {
    try {
      let whereClause = 'u.deleted_at IS NULL'; // Spec F4：Admin 列表默认排除已注销
      const values: any[] = [];

      if (params.search?.trim()) {
        values.push(`%${params.search.trim().toLowerCase()}%`);
        whereClause += ` AND (LOWER(u.email) LIKE $${values.length} OR LOWER(u.name) LIKE $${values.length})`;
      }
      if (params.role && params.role !== 'all') {
        values.push(params.role);
        whereClause += ` AND u.role = $${values.length}`;
      }
      if (params.status === 'active') {
        whereClause += ` AND u.is_active = TRUE`;
      } else if (params.status === 'frozen') {
        whereClause += ` AND u.is_active = FALSE`;
      }

      const countRes = await db.query(
        `SELECT COUNT(*) as total FROM users u WHERE ${whereClause}`,
        values
      );
      const total = parseInt(countRes.rows[0].total, 10);

      const listRes = await db.query(
        `SELECT u.*,
                COALESCE((SELECT COUNT(*) FROM canvases c WHERE c.user_id = u.id AND c.deleted_at IS NULL), 0)::int as canvas_count,
                COALESCE((SELECT SUM(total_tokens) FROM ai_request_logs al WHERE al.user_id = u.id AND al.status = 'success'), 0)::int as total_tokens_used
         FROM users u
         WHERE ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      return {
        users: listRes.rows.map((r) => ({ ...r })),
        total,
      };
    } catch (e) {
      handlePgError(e);
      console.warn('PG listAdminUsers fallback to in-memory:', e);
    }
  }

  // In-memory fallback
  let list = Array.from(inMemoryStore.users.values()).filter((u) => !u.deleted_at); // Spec F4：排除已注销
  if (params.search?.trim()) {
    const q = params.search.trim().toLowerCase();
    list = list.filter((u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  }
  if (params.role && params.role !== 'all') {
    list = list.filter((u) => u.role === params.role);
  }
  if (params.status === 'active') {
    list = list.filter((u) => u.is_active);
  } else if (params.status === 'frozen') {
    list = list.filter((u) => !u.is_active);
  }

  const total = list.length;
  const paginated = list.slice(offset, offset + limit).map((u) => {
    // 与 listCanvases / getAdminOverview 同口径：排除软删画布（否则删除后数字只增不减）
    const canvasCount = Array.from(inMemoryStore.canvases.values()).filter((c) => c.user_id === u.id && !c.deleted_at).length;
    const totalTokens = inMemoryStore.aiRequestLogs
      .filter((l) => l.user_id === u.id && l.status === 'success')
      .reduce((sum, l) => sum + l.total_tokens, 0);

    return {
      ...u,
      canvas_count: canvasCount,
      total_tokens_used: totalTokens,
    };
  });

  return { users: paginated, total };
}

export async function getAdminOverview(): Promise<{
  totalUsers: number;
  activeUsers7d: number;
  vipUsers: number;
  totalCanvases: number;
  todayTokens: number;
  monthlyTokens: number;
  modelDistribution: Record<string, number>;
}> {
  const db = getDb();
  if (db) {
    try {
      // 与 listAdminUsers 同口径（2026-09-10）：排除已注销用户及其画板，保证两处数字可对齐
      const uRes = await db.query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL');
      const wauRes = await db.query(
        `SELECT COUNT(DISTINCT s.user_id) as count FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.created_at >= NOW() - INTERVAL '7 days' AND u.deleted_at IS NULL`
      );
      const vipRes = await db.query(`SELECT COUNT(*) as count FROM users WHERE role = 'vip' AND deleted_at IS NULL`);
      const cRes = await db.query(
        `SELECT COUNT(*) as count FROM canvases c
         JOIN users u ON u.id = c.user_id
         WHERE c.deleted_at IS NULL AND u.deleted_at IS NULL`
      );
      const todayTokensRes = await db.query(
        `SELECT COALESCE(SUM(total_tokens), 0) as total FROM ai_request_logs WHERE created_at >= CURRENT_DATE AND status = 'success'`
      );
      const monthTokensRes = await db.query(
        `SELECT COALESCE(SUM(total_tokens), 0) as total FROM ai_request_logs WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) AND status = 'success'`
      );
      const modelDistRes = await db.query(
        `SELECT model_name, COUNT(*) as count FROM ai_request_logs WHERE status = 'success' GROUP BY model_name`
      );

      const modelDistribution: Record<string, number> = {};
      for (const row of modelDistRes.rows) {
        modelDistribution[row.model_name] = parseInt(row.count, 10);
      }

      return {
        totalUsers: parseInt(uRes.rows[0].count, 10),
        activeUsers7d: Math.max(1, parseInt(wauRes.rows[0].count, 10)),
        vipUsers: parseInt(vipRes.rows[0].count, 10),
        totalCanvases: parseInt(cRes.rows[0].count, 10),
        todayTokens: parseInt(todayTokensRes.rows[0].total, 10),
        monthlyTokens: parseInt(monthTokensRes.rows[0].total, 10),
        modelDistribution,
      };
    } catch (e) {
      handlePgError(e);
      console.warn('PG getAdminOverview fallback:', e);
    }
  }

  // In-memory fallback overview
  // TODO(A3): 内存模式 overview 的 modelDistribution/activeUsers7d 为演示伪造数据，二期接入真实统计
  // 与 listAdminUsers 同口径：排除已注销用户及其画板（含注销会让两处数字对不上）
  const totalUsers = Array.from(inMemoryStore.users.values()).filter((u) => !u.deleted_at).length;
  const vipUsers = Array.from(inMemoryStore.users.values()).filter((u) => u.role === 'vip' && !u.deleted_at).length;
  const totalCanvases = Array.from(inMemoryStore.canvases.values()).filter((c) => {
    if (c.deleted_at) return false;
    const owner = inMemoryStore.users.get(c.user_id);
    return Boolean(owner && !owner.deleted_at);
  }).length;
  const successLogs = inMemoryStore.aiRequestLogs.filter((l) => l.status === 'success');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const todayTokens = successLogs
    .filter((l) => new Date(l.created_at).getTime() >= todayStart.getTime())
    .reduce((sum, l) => sum + l.total_tokens, 0);
  const monthlyTokens = successLogs
    .filter((l) => new Date(l.created_at).getTime() >= monthStart.getTime())
    .reduce((sum, l) => sum + l.total_tokens, 0);

  const modelDistribution: Record<string, number> = {};
  for (const l of successLogs) {
    modelDistribution[l.model_name] = (modelDistribution[l.model_name] || 0) + 1;
  }
  if (Object.keys(modelDistribution).length === 0) {
    modelDistribution['gemini-3.8-flash'] = 12;
    modelDistribution['gemini-3.1-flash-lite'] = 5;
  }

  return {
    totalUsers,
    activeUsers7d: Math.max(1, Math.min(totalUsers, 3)),
    vipUsers,
    totalCanvases,
    todayTokens,
    monthlyTokens,
    modelDistribution,
  };
}
