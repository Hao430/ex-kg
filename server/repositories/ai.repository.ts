import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { DEFAULT_AI_MODEL_CONFIG } from '../core/records.js';
import type { AiModelConfig, AiRequestLogRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

/**
 * Record AI Request Log for auditing & engineering metrics
 */
export async function recordAiRequestLog(data: {
  userId?: string | null;
  canvasId?: string | null;
  nodeId?: string | null;
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  latencyMs: number;
  status: 'success' | 'error';
  errorMessage?: string | null;
  groundingChunksCount?: number;
  /** Spec I 可观测扩列 */
  provider?: string;
  webSearchCalls?: number;
  rawSourcesCount?: number;
  sourcesTruncated?: boolean;
  ttftMs?: number;
  aborted?: boolean;
  fallbackUsed?: boolean;
  resetCount?: number;
  candidateFailures?: number;
}): Promise<AiRequestLogRecord> {
  const p = getPool();
  const now = new Date().toISOString();
  const log: AiRequestLogRecord = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    user_id: data.userId || null,
    canvas_id: data.canvasId || null,
    node_id: data.nodeId || null,
    model_name: data.modelName,
    prompt_tokens: data.promptTokens || 0,
    completion_tokens: data.completionTokens || 0,
    total_tokens: data.totalTokens,
    latency_ms: data.latencyMs,
    status: data.status,
    error_message: data.errorMessage || null,
    grounding_chunks_count: data.groundingChunksCount || 0,
    provider: data.provider || '',
    web_search_calls: data.webSearchCalls || 0,
    raw_sources_count: data.rawSourcesCount || 0,
    sources_truncated: data.sourcesTruncated || false,
    ttft_ms: data.ttftMs || 0,
    aborted: data.aborted || false,
    fallback_used: data.fallbackUsed || false,
    reset_count: data.resetCount || 0,
    candidate_failures: data.candidateFailures || 0,
    created_at: now,
  };

  if (p) {
    try {
      await p.query(
        `INSERT INTO ai_request_logs (
           user_id, canvas_id, node_id, model_name, prompt_tokens,
           completion_tokens, total_tokens, latency_ms, status, error_message,
           grounding_chunks_count, provider, web_search_calls, raw_sources_count,
           sources_truncated, ttft_ms, aborted, fallback_used, reset_count,
           candidate_failures, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW())`,
        [
          data.userId || null,
          data.canvasId || null,
          data.nodeId || null,
          data.modelName,
          data.promptTokens || 0,
          data.completionTokens || 0,
          data.totalTokens,
          data.latencyMs,
          data.status,
          data.errorMessage || null,
          data.groundingChunksCount || 0,
          data.provider || '',
          data.webSearchCalls || 0,
          data.rawSourcesCount || 0,
          data.sourcesTruncated || false,
          data.ttftMs || 0,
          data.aborted || false,
          data.fallbackUsed || false,
          data.resetCount || 0,
          data.candidateFailures || 0,
        ]
      );
      return log;
    } catch (e) {
      handlePgError(e);
      console.warn('PG recordAiRequestLog failed:', e);
    }
  }

  // 内存兜底（无 pool 或 PG 失败时才写内存，上限 500 条）
  inMemoryStore.aiRequestLogs.unshift(log);
  if (inMemoryStore.aiRequestLogs.length > 500) {
    inMemoryStore.aiRequestLogs.pop();
  }
  return log;
}

/**
 * Spec I：分页查询 AI 推演日志（双模，admin 专用），返回最新在前。
 */
export async function listAiRequestLogs(params: {
  page?: number;
  limit?: number;
  status?: string;
  userId?: string;
}): Promise<{ logs: AiRequestLogRecord[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(200, Math.max(1, params.limit || 10));
  const offset = (page - 1) * limit;

  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      let whereClause = '1=1';
      const values: any[] = [];

      if (params.status?.trim()) {
        values.push(params.status.trim());
        whereClause += ` AND status = $${values.length}`;
      }
      if (params.userId?.trim()) {
        values.push(params.userId.trim());
        whereClause += ` AND user_id = $${values.length}::uuid`;
      }

      const countRes = await p.query(
        `SELECT COUNT(*) as total FROM ai_request_logs WHERE ${whereClause}`,
        values
      );
      const total = parseInt(countRes.rows[0].total, 10);

      const listRes = await p.query(
        `SELECT * FROM ai_request_logs
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      return {
        logs: listRes.rows.map((r) => ({
          ...r,
          created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        })),
        total,
      };
    } catch (e) {
      handlePgError(e);
      console.warn('PG listAiRequestLogs fallback to in-memory:', e);
    }
  }

  // In-memory fallback
  let list = inMemoryStore.aiRequestLogs;
  if (params.status?.trim()) {
    list = list.filter((l) => l.status === params.status!.trim());
  }
  if (params.userId?.trim()) {
    list = list.filter((l) => l.user_id === params.userId!.trim());
  }
  list = [...list].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return {
    logs: list.slice(offset, offset + limit),
    total: list.length,
  };
}

/**
 * Get current system AI Model & API Provider configuration
 */
export async function getAiModelConfig(): Promise<AiModelConfig> {
  const pool = getPool();
  if (!pool) {
    const cached = inMemoryStore.systemSettings.get('ai_model_config');
    return cached ? { ...DEFAULT_AI_MODEL_CONFIG, ...cached } : { ...DEFAULT_AI_MODEL_CONFIG };
  }

  try {
    await initDbSchema();
    const res = await pool.query('SELECT value FROM system_settings WHERE key = $1', ['ai_model_config']);
    if (res.rows.length > 0) {
      return { ...DEFAULT_AI_MODEL_CONFIG, ...res.rows[0].value };
    }
  } catch (err) {
    handlePgError(err);
    console.error('Failed to get ai_model_config from DB:', err);
  }

  const cached = inMemoryStore.systemSettings.get('ai_model_config');
  return cached ? { ...DEFAULT_AI_MODEL_CONFIG, ...cached } : { ...DEFAULT_AI_MODEL_CONFIG };
}

/**
 * 读取管理员保存的原始模型配置（不与 DEFAULT_AI_MODEL_CONFIG 合并）。
 * 返回 null 表示管理员从未保存过配置——用于「模型未配置则拒绝推理」校验，
 * 保证默认模型的唯一来源是管理后台，而非代码内硬编码兜底。
 */
export async function getSavedAiModelConfig(): Promise<Partial<AiModelConfig> | null> {
  const pool = getPool();
  if (pool) {
    try {
      await initDbSchema();
      const res = await pool.query('SELECT value FROM system_settings WHERE key = $1', ['ai_model_config']);
      if (res.rows.length > 0) {
        return res.rows[0].value as Partial<AiModelConfig>;
      }
    } catch (err) {
      handlePgError(err);
      console.error('Failed to get raw ai_model_config from DB:', err);
    }
  }
  const cached = inMemoryStore.systemSettings.get('ai_model_config');
  return cached ? { ...cached } as Partial<AiModelConfig> : null;
}

/**
 * Save or update system AI Model & API Provider configuration
 */
export async function saveAiModelConfig(config: Partial<AiModelConfig>, operatorEmail?: string): Promise<AiModelConfig> {
  const current = await getAiModelConfig();
  const updated: AiModelConfig = {
    ...current,
    ...config,
    updated_at: new Date().toISOString(),
    updated_by: operatorEmail || current.updated_by || 'admin',
  };

  const pool = getPool();
  if (pool) {
    try {
      await initDbSchema();
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        ['ai_model_config', JSON.stringify(updated)]
      );
      return updated;
    } catch (err) {
      handlePgError(err);
      console.error('Failed to save ai_model_config to DB:', err);
    }
  }

  // 内存兜底（无 pool 或 PG 失败时才写内存，PG 成功不双写）
  inMemoryStore.systemSettings.set('ai_model_config', updated);
  return updated;
}

/**
 * Spec F6：清理超过留存期的 AI 推演日志。retentionDays=0 表示全清（测试用）。
 */
export async function cleanupOldAiLogs(retentionDays: number): Promise<number> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = retentionDays <= 0
        ? await p.query(`DELETE FROM ai_request_logs RETURNING id`)
        : await p.query(
            `DELETE FROM ai_request_logs WHERE created_at < NOW() - make_interval(days => $1) RETURNING id`,
            [retentionDays]
          );
      return res.rowCount || 0;
    } catch (e) {
      handlePgError(e);
      console.warn('PG cleanupOldAiLogs failed, falling back to memory only:', e);
    }
  }

  if (retentionDays <= 0) {
    const removed = inMemoryStore.aiRequestLogs.length;
    inMemoryStore.aiRequestLogs = [];
    return removed;
  }
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const before = inMemoryStore.aiRequestLogs.length;
  inMemoryStore.aiRequestLogs = inMemoryStore.aiRequestLogs.filter(
    (l) => new Date(l.created_at).getTime() > cutoff
  );
  return before - inMemoryStore.aiRequestLogs.length;
}

/** 测试辅助：读取内存日志 */
export function getAiRequestLogsForTest(): AiRequestLogRecord[] {
  return inMemoryStore.aiRequestLogs;
}
