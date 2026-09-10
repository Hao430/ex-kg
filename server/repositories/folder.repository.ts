import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { handlePgError } from '../core/db-guard.js';
import type { FolderRecord } from '../core/records.js';

/**
 * Spec L1 / ADR-0015：单层画板分组仓储（双模，照 ADR-0002 模板）。
 * 分组是个人偏好：只允许分组属主本人管理，admin 不代为操作（故无 isAdmin 放行）。
 * 删除分组只解除画板归属（folder_id 置 NULL），绝不级联删画板。
 */

function toFolderRecord(row: any): FolderRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    sort_order: Number(row.sort_order) || 0,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listFolders(userId: string): Promise<FolderRecord[]> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `SELECT id, user_id, name, sort_order, created_at, updated_at
         FROM folders WHERE user_id = $1
         ORDER BY sort_order ASC, created_at ASC`,
        [userId]
      );
      return res.rows.map(toFolderRecord);
    } catch (e) {
      handlePgError(e);
      console.warn('PG listFolders fallback to in-memory:', e);
    }
  }

  return Array.from(inMemoryStore.folders.values())
    .filter((f) => f.user_id === userId)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map((f) => ({ ...f }));
}

export async function createFolder(id: string, name: string, userId: string): Promise<FolderRecord> {
  const p = getPool();
  if (p) {
    const client = await p.connect();
    try {
      await initDbSchema();
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO folders (id, user_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, user_id, name, sort_order, created_at, updated_at`,
        [id, userId, name]
      );
      if (res.rowCount === 0) {
        throw new ValidationError('分组已存在', 'FOLDER_EXISTS');
      }
      await client.query('COMMIT');
      return toFolderRecord(res.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG createFolder(${id}) fallback to in-memory:`, e);
    } finally {
      client.release();
    }
  }

  if (inMemoryStore.folders.has(id)) {
    throw new ValidationError('分组已存在', 'FOLDER_EXISTS');
  }
  const now = new Date().toISOString();
  const record: FolderRecord = {
    id,
    user_id: userId,
    name,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  inMemoryStore.folders.set(id, record);
  return { ...record };
}

export async function renameFolder(id: string, name: string, userId: string): Promise<FolderRecord> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const owner = await p.query('SELECT user_id FROM folders WHERE id = $1', [id]);
      if (owner.rows.length === 0) throw new NotFoundError('分组不存在');
      if (owner.rows[0].user_id !== userId) throw new ForbiddenError('无权修改其他用户的分组', 'FOLDER_FORBIDDEN');

      const res = await p.query(
        `UPDATE folders SET name = $2, updated_at = NOW() WHERE id = $1
         RETURNING id, user_id, name, sort_order, created_at, updated_at`,
        [id, name]
      );
      return toFolderRecord(res.rows[0]);
    } catch (e) {
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG renameFolder(${id}) fallback to in-memory:`, e);
    }
  }

  const folder = inMemoryStore.folders.get(id);
  if (!folder) throw new NotFoundError('分组不存在');
  if (folder.user_id !== userId) throw new ForbiddenError('无权修改其他用户的分组', 'FOLDER_FORBIDDEN');
  folder.name = name;
  folder.updated_at = new Date().toISOString();
  return { ...folder };
}

/** 删除分组：解除组内画板归属后删除；不级联删画板。 */
export async function deleteFolder(id: string, userId: string): Promise<boolean> {
  const p = getPool();
  if (p) {
    const client = await p.connect();
    try {
      await initDbSchema();
      await client.query('BEGIN');
      const owner = await client.query('SELECT user_id FROM folders WHERE id = $1', [id]);
      if (owner.rows.length === 0) throw new NotFoundError('分组不存在');
      if (owner.rows[0].user_id !== userId) throw new ForbiddenError('无权删除其他用户的分组', 'FOLDER_FORBIDDEN');

      await client.query('UPDATE canvases SET folder_id = NULL WHERE folder_id = $1', [id]);
      await client.query('DELETE FROM folders WHERE id = $1', [id]);
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG deleteFolder(${id}) fallback to in-memory:`, e);
    } finally {
      client.release();
    }
  }

  const folder = inMemoryStore.folders.get(id);
  if (!folder) throw new NotFoundError('分组不存在');
  if (folder.user_id !== userId) throw new ForbiddenError('无权删除其他用户的分组', 'FOLDER_FORBIDDEN');
  inMemoryStore.folders.delete(id);
  for (const canvas of inMemoryStore.canvases.values()) {
    if (canvas.folderId === id) canvas.folderId = null;
  }
  return true;
}

/** 校验分组归属：供画板 meta 更新时防跨租户挂载 */
export async function getFolderOwnerInfo(id: string): Promise<{ exists: boolean; ownerId: string | null }> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT user_id FROM folders WHERE id = $1', [id]);
      return { exists: res.rows.length > 0, ownerId: res.rows[0]?.user_id ?? null };
    } catch (e) {
      handlePgError(e);
      console.warn('PG getFolderOwnerInfo fallback to in-memory:', e);
    }
  }
  const folder = inMemoryStore.folders.get(id);
  return { exists: Boolean(folder), ownerId: folder?.user_id ?? null };
}
