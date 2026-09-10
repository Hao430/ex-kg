import pg from 'pg';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import type { CanvasRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

/**
 * 画布访问权限（H1 安全加固，2026-09-07）：严格属主制——读/写/删一律属主本人或 admin。
 * 唯一放行是全局共享默认画板：所有用户首屏共用同一行（default-board/default-canvas），
 * 因此不可删除（软删会导致所有用户对该 id 永久 404，全局默认板锁死）。
 * 已废弃的历史放行：board- 前缀、seed_ 前缀、demo-user-1 属主、guest_* 属主（游客模式已删除）。
 */
export function isSharedDefaultCanvas(canvasId: string): boolean {
  return canvasId === 'default-board' || canvasId === 'default-canvas';
}

/** 将行数组按 size 分块，供批量多值 INSERT 控制单条 SQL 参数数量 */
function chunkRows<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

export async function listCanvases(userId?: string, isAdmin = false): Promise<CanvasRecord[]> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const whereClause = isAdmin || !userId ? 'WHERE c.deleted_at IS NULL' : 'WHERE c.deleted_at IS NULL AND c.user_id = $1';
      const values = isAdmin || !userId ? [] : [userId];

      const res = await p.query(
        `SELECT
          c.id, c.user_id, c.title, c.description, c.viewport_x, c.viewport_y, c.viewport_zoom,
          c.default_model, c.created_at, c.updated_at,
          COUNT(DISTINCT n.id)::int as node_count,
          COUNT(DISTINCT e.id)::int as edge_count
        FROM canvases c
        LEFT JOIN nodes n ON n.canvas_id = c.id AND n.deleted_at IS NULL
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
      handlePgError(e);
      console.warn('PG listCanvases fallback to in-memory:', e);
    }
  }

  // In-memory
  return Array.from(inMemoryStore.canvases.values())
    .filter((c) => !c.deleted_at && (isAdmin || !userId || c.user_id === userId))
    .map((c) => ({
      ...c,
      nodeCount: c.nodes?.length || 0,
      edgeCount: c.edges?.length || 0,
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * 内存画布节点归一化（#9，对齐 PG getCanvas 分支的 data 重建规则）：
 * 内存 CanvasRecord.nodes 保存的是前端传入的原始 Node，缺省字段与 PG 重建输出不一致；
 * grounding 直通不补默认 []，custom 字段解构展开保留（与 PG custom_data 展开一致）。
 */
export function normalizeMemoryNode(node: any, defaultModel: string): any {
  const d = node?.data || {};
  const {
    title: _t, question: _q, answer: _a, content: _c, noteContent: _nc, note: _n,
    messages: _m, status: _st, isCollapsed: _ic, branchTriggerPhrase: _btp,
    enableWebSearch: _ews, color: _col, depth: _dep, model: _mod,
    grounding: _gr, parentId: _pid,
    ...customFields
  } = d;
  const answer = d.answer || '';
  const noteText = d.content || d.noteContent || d.note || '';
  return {
    ...node,
    type: node?.type || 'chat',
    data: {
      title: d.title || d.question || (node?.type === 'note' ? '便签' : '思考节点'),
      depth: typeof d.depth === 'number' ? d.depth : 0,
      question: d.question || '',
      answer,
      content: noteText,
      noteContent: noteText,
      messages: Array.isArray(d.messages) ? d.messages : [],
      status: d.status || (answer ? 'idle' : 'suggested'),
      model: d.model || defaultModel,
      parentId: d.parentId ?? null,
      grounding: d.grounding,
      isCollapsed: d.isCollapsed ?? false,
      branchTriggerPhrase: d.branchTriggerPhrase || '',
      enableWebSearch: d.enableWebSearch !== false,
      color: d.color || '',
      ...customFields,
    },
  };
}

export async function getCanvas(canvasId: string, userId?: string, isAdmin = false): Promise<CanvasRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const cRes = await p.query('SELECT * FROM canvases WHERE id = $1 AND deleted_at IS NULL', [canvasId]);
      if (cRes.rows.length === 0) return null;

      const c = cRes.rows[0];
      // Multi-tenant check: strict ownership — only owner or admin (shared default canvas is the sole exception)
      if (userId && !isAdmin && c.user_id !== userId && !isSharedDefaultCanvas(canvasId)) {
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
        // 边样式与箭头随画布持久化（K2 分享快照与属主画布渲染一致的前提）
        style: er.style || undefined,
        markerEnd: er.marker_end || undefined,
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
      handlePgError(e);
      console.warn(`PG getCanvas(${canvasId}) fallback to memory:`, e);
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas || canvas.deleted_at) return null;
  if (userId && !isAdmin && canvas.user_id !== userId && !isSharedDefaultCanvas(canvasId)) {
    return null;
  }
  return { ...canvas, nodes: (canvas.nodes || []).map((n) => normalizeMemoryNode(n, canvas.defaultModel)) };
}

/**
 * parent 链环检测（技术债 #0006）：saveCanvas 的 parentId 来自前端请求体，理论可构造
 * a→b→a 多节点环（PG 的 CHECK 约束只能防单节点自指）。环链会使后续任何层级遍历
 * （子树剥离 extractSubtree、级联操作、上下文回溯）死循环。沿 parent 链以 visited set
 * 探测，发现环抛 ValidationError 拒绝整次保存。saveCanvas 双分支共用此入口校验。
 */
function assertAcyclicParentChain(nodes: any[]): void {
  const parentOf = new Map<string, string | null>();
  for (const node of nodes || []) {
    if (node?.id) parentOf.set(String(node.id), node?.data?.parentId ? String(node.data.parentId) : null);
  }
  for (const startId of parentOf.keys()) {
    const visited = new Set<string>();
    let cur: string | null = startId;
    while (cur) {
      if (visited.has(cur)) {
        throw new ValidationError('节点层级关系存在循环引用，已拒绝保存', 'NODE_PARENT_CYCLE');
      }
      visited.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
}

/**
 * 归一化保存负载（PG/内存双分支共用，非导出以免触发双模判据）：
 * - 按 id 去重节点：同一 payload 内重复 id 会让多值 INSERT 撞 nodes_pkey（前端合并/冲突自愈后偶发）
 * - 按 id 去重边 + 丢弃端点不在本次节点集合内的边：nodes 每次整体重建，edges 的 FK 指向 nodes.id，
 *   悬挂边会让整个事务 FK 失败 → 500，用户画布从此存不进去
 * 内存分支同样走此归一化，保证与 PG 分支的 nodeCount/edgeCount 一致。
 */
function normalizeCanvasPayload(data: { id: string; nodes: any[]; edges: any[] }): { nodes: any[]; edges: any[] } {
  const seenNodeIds = new Set<string>();
  const nodes = (data.nodes || []).filter((node: any) => {
    if (!node || !node.id || seenNodeIds.has(node.id)) {
      if (node?.id) console.warn(`[saveCanvas] 丢弃重复节点 id=${node.id} canvas=${data.id}`);
      return false;
    }
    seenNodeIds.add(node.id);
    return true;
  });

  const nodeIdSet = new Set(nodes.map((n: any) => n.id));
  const seenEdgeIds = new Set<string>();
  const danglingEdges: any[] = [];
  const edges = (data.edges || []).filter((e: any) => {
    if (!e || !e.id || seenEdgeIds.has(e.id)) return false;
    if (!nodeIdSet.has(e.source) || !nodeIdSet.has(e.target)) {
      danglingEdges.push(e);
      return false;
    }
    seenEdgeIds.add(e.id);
    return true;
  });
  if (danglingEdges.length > 0) {
    console.warn(
      `[saveCanvas] 丢弃 ${danglingEdges.length} 条端点缺失的边 canvas=${data.id}：` +
        danglingEdges
          .slice(0, 5)
          .map((e) => `${e.id}(${e.source}→${e.target})`)
          .join(', ')
    );
  }

  return { nodes, edges };
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
  isAdmin = false,
  /** 新建画布（exists=false）前的配额闸门；复用事务内已查的 exists，省一次独立预查 */
  quotaGate?: (exists: boolean) => Promise<void>
): Promise<CanvasRecord> {
  const p = getPool();
  const now = new Date().toISOString();
  const vp = data.viewport || { x: 0, y: 0, zoom: 1 };

  // 环链校验在权限/事务之前统一执行，PG 与内存双分支共用（技术债 #0006）
  assertAcyclicParentChain(data.nodes);
  // 去重节点/边、丢悬挂边；两分支共用同一份归一化结果，保证计数与落库一致
  const normalized = normalizeCanvasPayload(data);

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

      // Check ownership if canvas exists（含软删行：占主键，禁止 upsert 复活）
      const existing = await client.query('SELECT user_id, updated_at, deleted_at FROM canvases WHERE id = $1', [data.id]);
      const existingUserId = existing.rows.length > 0 ? existing.rows[0].user_id : null;

      if (existing.rows.length > 0 && existing.rows[0].deleted_at) {
        throw new NotFoundError('画板不存在或已删除');
      }

      // 严格属主：仅属主本人或 admin 可写（共享默认画板除外）
      if (existing.rows.length > 0 && !isAdmin && existingUserId !== userId && !isSharedDefaultCanvas(data.id)) {
        throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
      }

      if (existing.rows.length > 0) {
        assertNoConflict(existing.rows[0].updated_at);
      }

      // 新建画布前配额校验（事务内复用 exists，避免服务层独立预查同一行）
      if (existing.rows.length === 0 && quotaGate) {
        await quotaGate(false);
      }

      const assignedUserId = existingUserId || userId;

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
         WHERE canvases.deleted_at IS NULL
         RETURNING created_at, updated_at`,
        [
          data.id,
          assignedUserId,
          data.title || '未命名思维探索',
          data.description || null,
          vp.x,
          vp.y,
          vp.zoom,
          data.defaultModel || '',
        ]
      );

      if (upsertRes.rowCount === 0) {
        // 并发窄窗口：SELECT 之后该行被其他连接软删，ON CONFLICT 的 WHERE 未命中
        throw new NotFoundError('画板不存在或已删除');
      }

      // Clean & Re-insert Nodes（批量多值 INSERT，分块控制参数数量）
      await client.query('DELETE FROM nodes WHERE canvas_id = $1', [data.id]);
      const nodeRows: any[][] = [];
      for (const node of normalized.nodes) {
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
        const modelUsed = d.model || data.defaultModel || '';
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

      // Clean & Re-insert Edges（归一化已按 id 去重 + 丢弃悬挂边）
      await client.query('DELETE FROM edges WHERE canvas_id = $1', [data.id]);
      const edgeRows: any[][] = normalized.edges.map((edge: any) => [
        edge.id,
        data.id,
        edge.source,
        edge.target,
        edge.sourceHandle || null,
        edge.targetHandle || null,
        edge.label || null,
        Boolean(edge.animated),
        edge.type || 'smoothstep',
        edge.style || null,
        edge.markerEnd || null,
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
            label, animated, type, style, marker_end
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
        defaultModel: data.defaultModel || '',
        enableWebSearch: data.enableWebSearch ?? true,
        createdAt: new Date(upsertRes.rows[0].created_at).toISOString(),
        updatedAt: new Date(upsertRes.rows[0].updated_at).toISOString(),
        nodes: normalized.nodes,
        edges: normalized.edges,
        nodeCount: normalized.nodes.length,
        edgeCount: normalized.edges.length,
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

  if (existing?.deleted_at) {
    throw new NotFoundError('画板不存在或已删除');
  }
  if (existing && !isAdmin && existingUserId !== userId && !isSharedDefaultCanvas(data.id)) {
    throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
  }
  if (existing) {
    assertNoConflict(existing.updatedAt);
  }
  if (!existing && quotaGate) {
    await quotaGate(false);
  }

  const record: CanvasRecord = {
    id: data.id,
    user_id: existingUserId || userId,
    title: data.title,
    description: data.description,
    viewport: vp,
    defaultModel: data.defaultModel || '',
    enableWebSearch: data.enableWebSearch ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    nodes: normalized.nodes,
    edges: normalized.edges,
    nodeCount: normalized.nodes.length,
    edgeCount: normalized.edges.length,
  };
  inMemoryStore.canvases.set(data.id, record);
  return record;
}

export async function deleteCanvas(canvasId: string, userId: string, isAdmin = false): Promise<boolean> {
  // 共享默认画板禁删：软删会让所有用户对该 id 永久 404，全局默认板锁死
  if (isSharedDefaultCanvas(canvasId)) {
    throw new ForbiddenError('默认画板不可删除', 'CANVAS_FORBIDDEN');
  }

  const p = getPool();
  if (p) {
    const client = await p.connect();
    try {
      await initDbSchema();
      await client.query('BEGIN');
      const check = await client.query('SELECT user_id FROM canvases WHERE id = $1 AND deleted_at IS NULL', [canvasId]);
      if (check.rows.length === 0) {
        await client.query('COMMIT');
        return false; // 不存在或已软删，幂等返回
      }
      if (!isAdmin && check.rows[0].user_id !== userId) {
        throw new ForbiddenError('无权删除此画板', 'CANVAS_FORBIDDEN');
      }
      // 软删主行 + 子表即时物理清理（对齐原物理 DELETE 的 CASCADE 语义）
      await client.query('UPDATE canvases SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [canvasId]);
      await client.query('DELETE FROM nodes WHERE canvas_id = $1', [canvasId]);
      await client.query('DELETE FROM edges WHERE canvas_id = $1', [canvasId]);
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      // 业务错误（如 403）必须穿透，不得降级落内存分支造成 200 假成功
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG deleteCanvas(${canvasId}) fallback to in-memory:`, e);
    } finally {
      client.release();
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas || canvas.deleted_at) return false;
  if (!isAdmin && canvas.user_id !== userId) {
    throw new ForbiddenError('无权删除此画板', 'CANVAS_FORBIDDEN');
  }
  canvas.deleted_at = new Date().toISOString();
  canvas.nodes = [];
  canvas.edges = [];
  return true;
}

/** 画布是否存在（供配额判定区分新建/更新） */
export async function canvasExists(canvasId: string): Promise<boolean> {
  const info = await getCanvasOwnerInfo(canvasId);
  return info.exists;
}

/** 轻量读取画布归属：exists + ownerId（不加载 nodes/edges） */
export async function getCanvasOwnerInfo(
  canvasId: string
): Promise<{ exists: boolean; ownerId: string | null }> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT user_id FROM canvases WHERE id = $1 AND deleted_at IS NULL', [canvasId]);
      return { exists: res.rows.length > 0, ownerId: res.rows[0]?.user_id ?? null };
    } catch (e) {
      handlePgError(e);
      console.warn('PG getCanvasOwnerInfo fallback to in-memory:', e);
    }
  }
  const canvas = inMemoryStore.canvases.get(canvasId);
  return { exists: Boolean(canvas && !canvas.deleted_at), ownerId: canvas?.user_id ?? null };
}

/** 画布内 AI 推理节点（chat 类型）数量 */
export async function countCanvasNodes(canvasId: string): Promise<number> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT COUNT(*)::int as count FROM nodes WHERE canvas_id = $1 AND type = $2 AND deleted_at IS NULL', [
        canvasId,
        'chat',
      ]);
      return res.rows[0].count;
    } catch (e) {
      handlePgError(e);
      console.warn('PG countCanvasNodes fallback to in-memory:', e);
    }
  }
  const canvas = inMemoryStore.canvases.get(canvasId);
  return (canvas?.nodes || []).filter((n: any) => (n.type || 'chat') === 'chat').length;
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
           WHERE n.canvas_id = $1 AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR c.user_id = $2)
             AND (n.question ILIKE $3 OR n.answer ILIKE $3 OR n.note ILIKE $3)
           LIMIT 30`
        : `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE c.deleted_at IS NULL AND ($1::uuid IS NULL OR c.user_id = $1)
             AND (n.question ILIKE $2 OR n.answer ILIKE $2 OR n.note ILIKE $2)
           LIMIT 30`;
      const params = canvasId
        ? [canvasId, userId || null, `%${queryText.trim()}%`]
        : [userId || null, `%${queryText.trim()}%`];
      const res = await p.query(sql, params);
      return res.rows;
    } catch (e) {
      handlePgError(e);
      console.warn('PG searchNodes failed:', e);
    }
  }

  const q = queryText.toLowerCase();
  const results: any[] = [];
  for (const canvas of inMemoryStore.canvases.values()) {
    if (canvas.deleted_at) continue;
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
