import pg from 'pg';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { ConflictError, ForbiddenError } from '../lib/errors.js';
import type { CanvasRecord } from '../core/records.js';

/**
 * 「可认领画板」判定（原 getCanvas/saveCanvas/deleteCanvas 中重复 3-4 份的规则）。
 * 通过显式开关保留各调用点的原有判定集，不做权限放宽：
 * - getCanvas：默认集（default-board/default-canvas/seed_ 前缀/demo 属主/guest 属主）
 * - saveCanvas：默认集 + board- 前缀 + 无属主 + 请求者为 guest
 * - deleteCanvas：默认集 + board- 前缀
 */
interface ClaimableOptions {
  includeBoardPrefix?: boolean;
  includeNoOwner?: boolean;
  includeRequesterGuest?: boolean;
}

/** 将行数组按 size 分块，供批量多值 INSERT 控制单条 SQL 参数数量 */
function chunkRows<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

function isClaimableCanvas(
  canvasId: string,
  ownerId: string | null | undefined,
  requesterId: string | undefined,
  opts: ClaimableOptions = {}
): boolean {
  if (canvasId === 'default-board' || canvasId === 'default-canvas') return true;
  if (canvasId.startsWith('seed_')) return true;
  if (opts.includeBoardPrefix && canvasId.startsWith('board-')) return true;
  if (ownerId === 'demo-user-1') return true;
  if (typeof ownerId === 'string' && ownerId.startsWith('guest_')) return true;
  if (opts.includeNoOwner && !ownerId) return true;
  if (opts.includeRequesterGuest && typeof requesterId === 'string' && requesterId.startsWith('guest_')) return true;
  return false;
}

export async function listCanvases(userId?: string, isAdmin = false): Promise<CanvasRecord[]> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const whereClause = isAdmin || !userId ? '' : 'WHERE c.user_id = $1';
      const values = isAdmin || !userId ? [] : [userId];

      const res = await p.query(
        `SELECT
          c.id, c.user_id, c.title, c.description, c.viewport_x, c.viewport_y, c.viewport_zoom,
          c.default_model, c.created_at, c.updated_at,
          COUNT(DISTINCT n.id)::int as node_count,
          COUNT(DISTINCT e.id)::int as edge_count
        FROM canvases c
        LEFT JOIN nodes n ON n.canvas_id = c.id
        LEFT JOIN edges e ON e.canvas_id = c.id
        ${whereClause}
        GROUP BY c.id
        ORDER BY c.updated_at DESC`,
        values
      );

      return res.rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        title: r.title,
        description: r.description,
        viewport: { x: r.viewport_x, y: r.viewport_y, zoom: r.viewport_zoom },
        defaultModel: r.default_model,
        enableWebSearch: true,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        nodeCount: r.node_count,
        edgeCount: r.edge_count,
      }));
    } catch (e) {
      console.warn('PG listCanvases fallback to in-memory:', e);
    }
  }

  // In-memory
  return Array.from(inMemoryStore.canvases.values())
    .filter((c) => isAdmin || !userId || c.user_id === userId)
    .map((c) => ({
      ...c,
      nodeCount: c.nodes?.length || 0,
      edgeCount: c.edges?.length || 0,
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getCanvas(canvasId: string, userId?: string, isAdmin = false): Promise<CanvasRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const cRes = await p.query('SELECT * FROM canvases WHERE id = $1', [canvasId]);
      if (cRes.rows.length === 0) return null;

      const c = cRes.rows[0];
      // Multi-tenant check: if not admin and canvas belongs to someone else, check if adoptable/public
      const isPublicOrAdoptable = isClaimableCanvas(canvasId, c.user_id, userId);

      if (userId && !isAdmin && c.user_id !== userId && !isPublicOrAdoptable) {
        return null;
      }

      const nRes = await p.query('SELECT * FROM nodes WHERE canvas_id = $1 ORDER BY created_at ASC', [canvasId]);
      const eRes = await p.query('SELECT * FROM edges WHERE canvas_id = $1', [canvasId]);

      const nodes = nRes.rows.map((nr) => ({
        id: nr.id,
        type: nr.type || 'chat',
        position: { x: nr.pos_x, y: nr.pos_y },
        data: {
          title: nr.title || nr.question || (nr.type === 'note' ? '便签' : '思考节点'),
          depth: nr.depth,
          question: nr.question || '',
          answer: nr.answer || '',
          content: nr.content || nr.note || '',
          noteContent: nr.content || nr.note || '',
          messages: nr.messages || [],
          status: nr.status || (nr.answer ? 'idle' : 'suggested'),
          model: nr.model_used || c.default_model,
          parentId: nr.parent_id,
          grounding: nr.grounding,
          isCollapsed: nr.is_collapsed ?? false,
          branchTriggerPhrase: nr.branch_trigger_phrase || '',
          enableWebSearch: nr.enable_web_search ?? true,
          color: nr.color || '',
          ...(nr.custom_data || {}),
        },
      }));

      const edges = eRes.rows.map((er) => ({
        id: er.id,
        source: er.source_id,
        target: er.target_id,
        sourceHandle: er.source_handle || undefined,
        targetHandle: er.target_handle || undefined,
        label: er.label || undefined,
        animated: er.animated ?? false,
        type: er.type || 'smoothstep',
      }));

      return {
        id: c.id,
        user_id: c.user_id,
        title: c.title,
        description: c.description,
        viewport: { x: c.viewport_x, y: c.viewport_y, zoom: c.viewport_zoom },
        defaultModel: c.default_model,
        enableWebSearch: true,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      };
    } catch (e) {
      console.warn(`PG getCanvas(${canvasId}) fallback to memory:`, e);
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas) return null;
  if (userId && !isAdmin && canvas.user_id && canvas.user_id !== userId) {
    const isPublicOrAdoptable = isClaimableCanvas(canvasId, canvas.user_id, userId);
    if (!isPublicOrAdoptable) {
      return null;
    }
  }
  return canvas;
}

export async function saveCanvas(
  data: {
    id: string;
    title: string;
    description?: string;
    viewport?: { x: number; y: number; zoom: number };
    defaultModel?: string;
    enableWebSearch?: boolean;
    nodes: any[];
    edges: any[];
    expectedUpdatedAt?: string;
  },
  userId: string,
  isAdmin = false
): Promise<CanvasRecord> {
  const p = getPool();
  const now = new Date().toISOString();
  const vp = data.viewport || { x: 0, y: 0, zoom: 1 };

  /** 乐观锁：画布已存在且调用方声明了其已知版本时校验，防止并发静默覆盖 */
  const assertNoConflict = (serverUpdatedAt: string | null | undefined): void => {
    if (!data.expectedUpdatedAt || !serverUpdatedAt) return;
    const known = new Date(data.expectedUpdatedAt).getTime();
    if (Number.isNaN(known)) return; // 非法时间串视为未携带，避免恒等比较误报
    const current = new Date(serverUpdatedAt).getTime();
    if (known !== current) {
      throw new ConflictError('画板已被其他窗口修改，请刷新获取最新内容后再保存', 'CANVAS_SAVE_CONFLICT', {
        latest_updated_at: new Date(serverUpdatedAt).toISOString(),
      });
    }
  };

  if (p) {
    const client = await p.connect();
    let upsertRes: pg.QueryResult;
    try {
      await initDbSchema();
      await client.query('BEGIN');

      // Check ownership if canvas exists
      const existing = await client.query('SELECT user_id, updated_at FROM canvases WHERE id = $1', [data.id]);
      const existingUserId = existing.rows.length > 0 ? existing.rows[0].user_id : null;
      const isAdoptable = isClaimableCanvas(data.id, existingUserId, userId, {
        includeBoardPrefix: true,
        includeNoOwner: true,
        includeRequesterGuest: true,
      });

      if (existing.rows.length > 0 && !isAdmin && existingUserId !== userId && !isAdoptable) {
        throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
      }

      if (existing.rows.length > 0) {
        assertNoConflict(existing.rows[0].updated_at);
      }

      const assignedUserId = (isAdoptable || existing.rows.length === 0) ? userId : (existingUserId || userId);

      upsertRes = await client.query(
        `INSERT INTO canvases (id, user_id, title, description, viewport_x, viewport_y, viewport_zoom, default_model, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           description = COALESCE(EXCLUDED.description, canvases.description),
           viewport_x = EXCLUDED.viewport_x,
           viewport_y = EXCLUDED.viewport_y,
           viewport_zoom = EXCLUDED.viewport_zoom,
           default_model = EXCLUDED.default_model,
           updated_at = NOW()
         RETURNING created_at, updated_at`,
        [
          data.id,
          assignedUserId,
          data.title || '未命名思维探索',
          data.description || null,
          vp.x,
          vp.y,
          vp.zoom,
          data.defaultModel || 'gemini-3.8-flash',
        ]
      );

      // Clean & Re-insert Nodes（批量多值 INSERT，分块控制参数数量）
      await client.query('DELETE FROM nodes WHERE canvas_id = $1', [data.id]);
      const nodeRows: any[][] = [];
      for (const node of data.nodes || []) {
        const d = node.data || {};
        const pos = node.position || { x: 0, y: 0 };
        const nodeType = node.type || 'chat';
        const title = d.title || d.question || (nodeType === 'note' ? '便签' : '思考节点');
        const question = d.question || '';
        const answer = d.answer || '';
        const noteText = d.content || d.noteContent || d.note || '';
        const contentText = d.content || d.noteContent || '';
        const messages = Array.isArray(d.messages) ? JSON.stringify(d.messages) : '[]';
        const status = d.status || (answer ? 'idle' : 'suggested');
        const isCollapsed = Boolean(d.isCollapsed);
        const branchTriggerPhrase = d.branchTriggerPhrase || '';
        const enableWebSearch = d.enableWebSearch !== false;
        const color = d.color || '';
        const depth = typeof d.depth === 'number' ? d.depth : 0;
        const modelUsed = d.model || data.defaultModel || 'gemini-3.8-flash';
        const grounding = d.grounding ? JSON.stringify(d.grounding) : '[]';

        // Extract extra custom data
        const {
          title: _t, question: _q, answer: _a, content: _c, noteContent: _nc, note: _n,
          messages: _m, status: _st, isCollapsed: _ic, branchTriggerPhrase: _btp,
          enableWebSearch: _ews, color: _col, depth: _dep, model: _mod,
          grounding: _gr, parentId: _pid,
          ...customFields
        } = d;

        nodeRows.push([
          node.id,
          data.id,
          d.parentId || null,
          nodeType,
          title,
          question,
          answer,
          noteText,
          contentText,
          messages,
          status,
          pos.x,
          pos.y,
          depth,
          modelUsed,
          grounding,
          isCollapsed,
          branchTriggerPhrase,
          enableWebSearch,
          color,
          JSON.stringify(customFields || {}),
        ]);
      }

      const NODE_BATCH_SIZE = 200; // 200 × 21 参数 = 4200，远低于 PG 65535 上限
      for (const batch of chunkRows(nodeRows, NODE_BATCH_SIZE)) {
        const values: any[] = [];
        const tuples = batch.map(
          (row) => `(${row.map((v) => `$${values.push(v)}`).join(', ')})`
        );
        await client.query(
          `INSERT INTO nodes (
            id, canvas_id, parent_id, type, title, question, answer, note, content,
            messages, status, pos_x, pos_y, depth, model_used, grounding,
            is_collapsed, branch_trigger_phrase, enable_web_search, color,
            custom_data
          )
          VALUES ${tuples.join(', ')}`,
          values
        );
      }

      // Clean & Re-insert Edges（批量多值 INSERT）
      await client.query('DELETE FROM edges WHERE canvas_id = $1', [data.id]);
      const edgeRows: any[][] = (data.edges || []).map((edge: any) => [
        edge.id,
        data.id,
        edge.source,
        edge.target,
        edge.sourceHandle || null,
        edge.targetHandle || null,
        edge.label || null,
        Boolean(edge.animated),
        edge.type || 'smoothstep',
      ]);

      const EDGE_BATCH_SIZE = 500;
      for (const batch of chunkRows(edgeRows, EDGE_BATCH_SIZE)) {
        const values: any[] = [];
        const tuples = batch.map(
          (row) => `(${row.map((v) => `$${values.push(v)}`).join(', ')})`
        );
        await client.query(
          `INSERT INTO edges (
            id, canvas_id, source_id, target_id, source_handle, target_handle,
            label, animated, type
          )
          VALUES ${tuples.join(', ')}
          ON CONFLICT (id) DO NOTHING`,
          values
        );
      }

      await client.query('COMMIT');

      // 以 DB 时间戳为准返回（乐观锁版本必须与下次 GET 一致），不再落穿到内存分支
      return {
        id: data.id,
        user_id: assignedUserId,
        title: data.title,
        description: data.description,
        viewport: vp,
        defaultModel: data.defaultModel || 'gemini-3.8-flash',
        enableWebSearch: data.enableWebSearch ?? true,
        createdAt: new Date(upsertRes.rows[0].created_at).toISOString(),
        updatedAt: new Date(upsertRes.rows[0].updated_at).toISOString(),
        nodes: data.nodes,
        edges: data.edges,
        nodeCount: (data.nodes || []).length,
        edgeCount: (data.edges || []).length,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('PG saveCanvas transaction failed:', e);
      throw e;
    } finally {
      client.release();
    }
  }

  // In-memory store
  const existing = inMemoryStore.canvases.get(data.id);
  const existingUserId = existing?.user_id || null;
  const isAdoptable = isClaimableCanvas(data.id, existingUserId, userId, {
    includeBoardPrefix: true,
    includeNoOwner: true,
    includeRequesterGuest: true,
  });

  if (existing && !isAdmin && existingUserId !== userId && !isAdoptable) {
    throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
  }
  if (existing) {
    assertNoConflict(existing.updatedAt);
  }

  const record: CanvasRecord = {
    id: data.id,
    user_id: isAdoptable ? userId : (existing?.user_id || userId),
    title: data.title,
    description: data.description,
    viewport: vp,
    defaultModel: data.defaultModel || 'gemini-3.8-flash',
    enableWebSearch: data.enableWebSearch ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    nodes: data.nodes,
    edges: data.edges,
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
  };
  inMemoryStore.canvases.set(data.id, record);
  return record;
}

export async function deleteCanvas(canvasId: string, userId: string, isAdmin = false): Promise<boolean> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const check = await p.query('SELECT user_id FROM canvases WHERE id = $1', [canvasId]);
      if (check.rows.length === 0) return false;
      const existingUserId = check.rows[0].user_id;
      const isAdoptableOrGuest = isClaimableCanvas(canvasId, existingUserId, userId, {
        includeBoardPrefix: true,
      });

      if (!isAdmin && existingUserId !== userId && !isAdoptableOrGuest) {
        throw new ForbiddenError('无权删除此画板', 'CANVAS_FORBIDDEN');
      }
      await p.query('DELETE FROM canvases WHERE id = $1', [canvasId]);
      return true;
    } catch (e) {
      console.warn(`PG deleteCanvas(${canvasId}) failed:`, e);
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas) return false;
  const existingUserId = canvas.user_id;
  const isAdoptableOrGuest = isClaimableCanvas(canvasId, existingUserId, userId, {
    includeBoardPrefix: true,
  });

  if (!isAdmin && existingUserId !== userId && !isAdoptableOrGuest) {
    throw new ForbiddenError('无权删除此画板', 'CANVAS_FORBIDDEN');
  }
  return inMemoryStore.canvases.delete(canvasId);
}

export async function searchNodes(queryText: string, canvasId?: string, userId?: string): Promise<any[]> {
  const p = getPool();
  if (p && queryText.trim()) {
    try {
      await initDbSchema();
      const sql = canvasId
        ? `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE n.canvas_id = $1 AND ($2::uuid IS NULL OR c.user_id = $2)
             AND (n.question ILIKE $3 OR n.answer ILIKE $3 OR n.note ILIKE $3)
           LIMIT 30`
        : `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE ($1::uuid IS NULL OR c.user_id = $1)
             AND (n.question ILIKE $2 OR n.answer ILIKE $2 OR n.note ILIKE $2)
           LIMIT 30`;
      const params = canvasId
        ? [canvasId, userId || null, `%${queryText.trim()}%`]
        : [userId || null, `%${queryText.trim()}%`];
      const res = await p.query(sql, params);
      return res.rows;
    } catch (e) {
      console.warn('PG searchNodes failed:', e);
    }
  }

  const q = queryText.toLowerCase();
  const results: any[] = [];
  for (const canvas of inMemoryStore.canvases.values()) {
    if (canvasId && canvas.id !== canvasId) continue;
    if (userId && canvas.user_id !== userId) continue;
    for (const node of canvas.nodes || []) {
      const d = node.data || {};
      // 与 PG 分支的 note 字段对齐：兼容 note 与 noteContent 两种来源
      const note = d.note ?? d.noteContent ?? '';
      if (
        (d.title && d.title.toLowerCase().includes(q)) ||
        (d.question && d.question.toLowerCase().includes(q)) ||
        (d.answer && d.answer.toLowerCase().includes(q)) ||
        (note && note.toLowerCase().includes(q))
      ) {
        results.push({
          id: node.id,
          canvasId: canvas.id,
          title: d.title || d.question,
          question: d.question,
          answer: d.answer,
          noteContent: note,
          depth: d.depth,
          model: d.model,
        });
      }
    }
  }
  return results.slice(0, 30);
}
