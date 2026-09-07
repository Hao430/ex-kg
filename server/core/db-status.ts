import { getPool } from './pool.js';
import { initDbSchema } from './schema.js';
import { inMemoryStore } from './memory-store.js';
import type { DbStatus } from './records.js';

/**
 * Check DB Status
 */
export async function checkDbStatus(): Promise<DbStatus> {
  const p = getPool();
  if (!p) {
    return {
      connected: false,
      type: 'in-memory-fallback',
      message: 'DATABASE_URL 未配置。当前运行于高性能内存回退模式，数据与会话全量就绪。',
      userCount: inMemoryStore.users.size,
      canvasCount: inMemoryStore.canvases.size,
      nodeCount: Array.from(inMemoryStore.canvases.values()).reduce((acc, c) => acc + (c.nodes?.length || 0), 0),
      databaseUrlConfigured: false,
    };
  }

  try {
    await initDbSchema();
    const client = await p.connect();
    try {
      const uRes = await client.query('SELECT COUNT(*) as count FROM users');
      const cRes = await client.query('SELECT COUNT(*) as count FROM canvases');
      const nRes = await client.query('SELECT COUNT(*) as count FROM nodes');
      return {
        connected: true,
        type: 'postgresql',
        message: 'PostgreSQL 数据库连接正常，数据存储就绪。',
        userCount: parseInt(uRes.rows[0].count, 10),
        canvasCount: parseInt(cRes.rows[0].count, 10),
        nodeCount: parseInt(nRes.rows[0].count, 10),
        databaseUrlConfigured: true,
      };
    } finally {
      client.release();
    }
  } catch (err: any) {
    return {
      connected: false,
      type: 'in-memory-fallback',
      message: `PostgreSQL 连接异常: ${err?.message || err}。当前自动切换至内存模式保障服务。`,
      userCount: inMemoryStore.users.size,
      canvasCount: inMemoryStore.canvases.size,
      nodeCount: Array.from(inMemoryStore.canvases.values()).reduce((acc, c) => acc + (c.nodes?.length || 0), 0),
      databaseUrlConfigured: true,
    };
  }
}
