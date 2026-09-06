import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Lazy get or initialize PostgreSQL Pool。
 * 未配置 DATABASE_URL 时返回 null，调用方据此走内存兜底分支。
 */
export function getPool(): pg.Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl:
        connectionString.includes('sslmode=require') ||
        connectionString.includes('neon.tech') ||
        connectionString.includes('supabase')
          ? { rejectUnauthorized: false }
          : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL client error on idle connection:', err);
    });
  }

  return pool;
}
