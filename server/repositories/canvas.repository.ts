import pg from 'pg';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import type { CanvasRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

/**
 * 画布访问权限（H1 安全加固，2026-09-07）：严格属主制——读/写/删一律属主本人或 admin。
 *
 * 默认画板 `default-board` / `default-canvas`（ADR-0018，2026-09-12）：
 * - 历史语义是「全局共享单行」（ADR-0004 保留的唯一放行），所有登录用户读写同一行。节点级
 *   合并上线后它从「覆盖竞争」升级为「跨租户节点稳定混合 + 持续跨租户读」，与 ADR-0016 的
 *   严格属主承诺直接冲突，必须收口。
 * - `SAVE_DEFAULT_BOARD_MODE=private` 后它退化为**首个认领者的普通画板**：授权路径不再有
 *   任何放行，未认领 = 行不存在（由首个保存者 upsert 创建并认领，无需 DROP NOT NULL）。
 * - 两种模式下公开 id 都**不可删除**：软删会让所有用户对该 id 永久 404，默认板锁死。
 *
 * 已废弃的历史放行：board- 前缀、seed_ 前缀、demo-user-1 属主、guest_* 属主（游客模式已删除）。
 */

/** 公开 id 判定，**与授权无关**：仅供「禁删」与 id 归属判断使用 */
export function isDefaultCanvasPublicId(canvasId: string): boolean {
  return canvasId === 'default-board' || canvasId === 'default-canvas';
}

/**
 * 默认画板是否仍按「全局共享」放行（仅授权路径使用）。
 * 默认 legacy = 部署时零行为变化；发布顺序是**客户端先行 + soak ≥7 天**，再翻 private
 * （见 ADR-0018：窗口期内非属主的旧标签页会在保存时才失败）。
 */
export function isSharedDefaultCanvas(canvasId: string): boolean {
  return process.env.SAVE_DEFAULT_BOARD_MODE !== 'private' && isDefaultCanvasPublicId(canvasId);
}

/** 将行数组按 size 分块，供批量多值 INSERT 控制单条 SQL 参数数量 */
function chunkRows<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

export async function listCanvases(userId: string): Promise<CanvasRecord[]> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      // 严格属主制（ADR-0016）：画布列表恒按属主过滤，admin 不再放行。
      const whereClause = 'WHERE c.deleted_at IS NULL AND c.user_id = $1';
      const values = [userId];

      const res = await p.query(
        `SELECT
          c.id, c.user_id, c.title, c.description, c.viewport_x, c.viewport_y, c.viewport_zoom,
          c.default_model, c.is_favorite, c.is_archived, c.folder_id, c.created_at, c.updated_at,
          COUNT(DISTINCT n.id)::int as node_count,
          COUNT(DISTINCT e.id)::int as edge_count
        FROM canvases c
        LEFT JOIN nodes n ON n.canvas_id = c.id AND n.deleted_at IS NULL
        LEFT JOIN edges e ON e.canvas_id = c.id AND e.deleted_at IS NULL
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
        isFavorite: r.is_favorite ?? false,
        isArchived: r.is_archived ?? false,
        folderId: r.folder_id ?? null,
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
    .filter((c) => !c.deleted_at && c.user_id === userId)
    .map((c) => ({
      ...c,
      isFavorite: c.isFavorite ?? false,
      isArchived: c.isArchived ?? false,
      folderId: c.folderId ?? null,
      // 计数排除墓碑（与 PG 分支的 LEFT JOIN ... AND deleted_at IS NULL 同口径）
      nodeCount: (c.nodes || []).filter((n: any) => !n?.deleted_at).length,
      edgeCount: (c.edges || []).filter((e: any) => !e?.deleted_at).length,
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

export async function getCanvas(canvasId: string, userId: string): Promise<CanvasRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const cRes = await p.query('SELECT * FROM canvases WHERE id = $1 AND deleted_at IS NULL', [canvasId]);
      if (cRes.rows.length === 0) return null;

      const c = cRes.rows[0];
      // Multi-tenant check: strict ownership — only the owner (shared default canvas is the sole exception)
      if (c.user_id !== userId && !isSharedDefaultCanvas(canvasId)) {
        return null;
      }

      // 墓碑行不得回吐给前端（ADR-0017）：节点/边一律带 deleted_at IS NULL 过滤
      const nRes = await p.query(
        'SELECT * FROM nodes WHERE canvas_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC',
        [canvasId]
      );
      const eRes = await p.query('SELECT * FROM edges WHERE canvas_id = $1 AND deleted_at IS NULL', [canvasId]);

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
        isFavorite: c.is_favorite ?? false,
        isArchived: c.is_archived ?? false,
        folderId: c.folder_id ?? null,
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
  if (canvas.user_id !== userId && !isSharedDefaultCanvas(canvasId)) {
    return null;
  }
  return {
    ...canvas,
    isFavorite: canvas.isFavorite ?? false,
    isArchived: canvas.isArchived ?? false,
    folderId: canvas.folderId ?? null,
    // 与 PG 分支同口径：墓碑行不回吐（内存分支的 deleted_at 由合并写入路径落，见 saveCanvas）
    nodes: (canvas.nodes || [])
      .filter((n: any) => !n?.deleted_at)
      .map((n) => normalizeMemoryNode(n, canvas.defaultModel)),
    edges: (canvas.edges || []).filter((e: any) => !e?.deleted_at),
  };
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
  assertAcyclicParentMap(parentOf);
}

/**
 * 环检测内核（可复用于合并模式）：`parentOf` 是完整的「节点 id → 父 id」映射。
 * 合并模式下 payload 只带部分节点，环可能横跨「payload 节点 + 服务端存活节点」，
 * 因此必须把两边合并后再判断，只看 payload 会漏判。
 */
function assertAcyclicParentMap(parentOf: Map<string, string | null>): void {
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

/** 按 id 去重（同批重复 id 会让 ON CONFLICT DO UPDATE 报 21000，必须先去） */
function dedupeById<T extends { id?: string }>(items: T[] | undefined, label: string, canvasId: string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items || []) {
    if (!item || !item.id || seen.has(item.id)) {
      if (item?.id) console.warn(`[saveCanvas] 丢弃重复${label} id=${item.id} canvas=${canvasId}`);
      continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 合并模式：把节点排成「父先于子」的顺序，并修掉不可达的 parentId。
 *
 * 两个原因：
 * 1. `parent_id` 是自引用 FK。多值 INSERT 内子行先于父行是否触发 FK 失败，取决于 RI
 *    检查在语句结束时（而非逐行）执行这一实现细节——显式拓扑排序让顺序确定，不去赌它。
 *    存量代码是整板 DELETE 后重插，父子必在同批，所以这条隐患一直没暴露。
 * 2. 父既不在本批 payload、又不在服务端存活集合里的节点：留着 parentId 必然 FK 失败、
 *    整单回滚——用户表现为「画板存不进去」。置空并在回执里报出修复过的 id。
 */
function sortNodesParentFirst(
  nodes: any[],
  liveNodeIds: Set<string>
): { ordered: any[]; repairedNodeIds: string[] } {
  const byId = new Map<string, any>(nodes.map((n) => [n.id, n]));
  const repairedNodeIds: string[] = [];
  const parentOf = new Map<string, string | null>();

  for (const n of nodes) {
    const raw = n?.data?.parentId ? String(n.data.parentId) : null;
    let pid = raw;
    if (pid && (pid === n.id || (!byId.has(pid) && !liveNodeIds.has(pid)))) {
      pid = null;
      repairedNodeIds.push(n.id);
    }
    if (pid !== raw) n.data = { ...(n.data || {}), parentId: null };
    parentOf.set(n.id, pid);
  }

  const ordered: any[] = [];
  const state = new Map<string, 1 | 2>(); // 1 = 访问中，2 = 已排好
  const visit = (id: string): void => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) {
      throw new ValidationError('节点层级关系存在循环引用，已拒绝保存', 'NODE_PARENT_CYCLE');
    }
    state.set(id, 1);
    const pid = parentOf.get(id) ?? null;
    if (pid && byId.has(pid)) visit(pid);
    state.set(id, 2);
    ordered.push(byId.get(id));
  };
  for (const n of nodes) visit(n.id);

  return { ordered, repairedNodeIds };
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

/**
 * 节点 → 21 列行值（id/canvas_id + 19 个业务列）。写入路径的双分支共用，
 * 保证 legacy 与 merge 落库口径逐字一致。
 *
 * 刻意**不含** width/height/is_pinned/tokens_used/created_at/deleted_at/canvas_id：
 * 这些列不在前端可编辑字段里，合并语义下天然保留（legacy 的 DELETE-all + 重插
 * 每次都把它们重置为 DEFAULT，是既有缺陷）。
 */
function buildNodeRow(node: any, canvasId: string, defaultModel: string): any[] {
  const d = node.data || {};
  const pos = node.position || { x: 0, y: 0 };
  const nodeType = node.type || 'chat';
  const answer = d.answer || '';
  const noteText = d.content || d.noteContent || d.note || '';
  const contentText = d.content || d.noteContent || '';

  // Extract extra custom data
  const {
    title: _t, question: _q, answer: _a, content: _c, noteContent: _nc, note: _n,
    messages: _m, status: _st, isCollapsed: _ic, branchTriggerPhrase: _btp,
    enableWebSearch: _ews, color: _col, depth: _dep, model: _mod,
    grounding: _gr, parentId: _pid,
    ...customFields
  } = d;

  return [
    node.id,
    canvasId,
    d.parentId || null,
    nodeType,
    d.title || d.question || (nodeType === 'note' ? '便签' : '思考节点'),
    d.question || '',
    answer,
    noteText,
    contentText,
    Array.isArray(d.messages) ? JSON.stringify(d.messages) : '[]',
    d.status || (answer ? 'idle' : 'suggested'),
    pos.x,
    pos.y,
    typeof d.depth === 'number' ? d.depth : 0,
    d.model || defaultModel || '',
    d.grounding ? JSON.stringify(d.grounding) : '[]',
    Boolean(d.isCollapsed),
    d.branchTriggerPhrase || '',
    d.enableWebSearch !== false,
    d.color || '',
    JSON.stringify(customFields || {}),
  ];
}

/** 节点 INSERT 列清单（与 buildNodeRow 一一对应，改一处必须改另一处） */
const NODE_INSERT_COLUMNS =
  'id, canvas_id, parent_id, type, title, question, answer, note, content, ' +
  'messages, status, pos_x, pos_y, depth, model_used, grounding, ' +
  'is_collapsed, branch_trigger_phrase, enable_web_search, color, custom_data';

const EDGE_INSERT_COLUMNS =
  'id, canvas_id, source_id, target_id, source_handle, target_handle, ' +
  'label, animated, type, style, marker_end';

/** 把行值数组拼成多值 INSERT 的 VALUES 段，参数依次压入 values */
function buildTuples(rows: any[][], values: any[]): string {
  return rows.map((row) => `(${row.map((v) => `$${values.push(v)}`).join(', ')})`).join(', ');
}

function buildEdgeRow(edge: any, canvasId: string): any[] {
  return [
    edge.id,
    canvasId,
    edge.source,
    edge.target,
    edge.sourceHandle || null,
    edge.targetHandle || null,
    edge.label || null,
    Boolean(edge.animated),
    edge.type || 'smoothstep',
    edge.style || null,
    edge.markerEnd || null,
  ];
}

interface MergeWriteResult {
  ignoredNodeIds: string[];
  repairedNodeIds: string[];
  nodeCount: number;
  edgeCount: number;
}

/**
 * 合并写入（ADR-0017，protocolVersion >= 2）：只 upsert 本次带来的节点/边，其余原样不动。
 * 这是「没带 = 不动」的落地点——正是它与 legacy 整板替换的语义分水岭。
 *
 * 执行顺序不可交换：节点 upsert → 节点墓碑（含级联边墓碑）→ 显式边墓碑 → 边 upsert。
 * 保证同一份 payload 里既携带又声明删除的 id 一定以删除收场。
 */
async function mergeWriteCanvas(
  client: pg.PoolClient,
  canvasId: string,
  payloadNodes: any[],
  payloadEdges: any[],
  deletedNodeIds: string[],
  deletedEdgeIds: string[],
  defaultModel: string
): Promise<MergeWriteResult> {
  // 1) 跨板搬节点拦截：id 是全局主键，把他人板内节点提交到本板必须拒绝（只报 id，不泄露内容）
  if (payloadNodes.length > 0) {
    const clash = await client.query(
      'SELECT id FROM nodes WHERE id = ANY($1::varchar[]) AND canvas_id <> $2 LIMIT 1',
      [payloadNodes.map((n) => n.id), canvasId]
    );
    if (clash.rows.length > 0) {
      throw new ValidationError('节点不属于当前画板，已拒绝保存', 'NODE_CANVAS_MISMATCH');
    }
  }

  // 2) 服务端存活节点（父映射 + 存活集合一次取回）
  const liveRes = await client.query(
    'SELECT id, parent_id FROM nodes WHERE canvas_id = $1 AND deleted_at IS NULL',
    [canvasId]
  );
  const liveNodeIds = new Set<string>(liveRes.rows.map((r: any) => r.id as string));
  const parentOf = new Map<string, string | null>(
    liveRes.rows.map((r: any) => [r.id as string, (r.parent_id as string | null) ?? null])
  );

  // 3) 环检测：payload 的父子关系叠加到服务端存活映射上再判断。
  //    只看 payload 会漏判「新节点 → 服务端既有节点 → 新节点」这类跨批环。
  for (const n of payloadNodes) {
    const pid = n?.data?.parentId ? String(n.data.parentId) : null;
    parentOf.set(n.id, pid === n.id ? null : pid);
  }
  assertAcyclicParentMap(parentOf);

  // 4) 父先于子排序 + 修掉不可达 parentId
  const { ordered, repairedNodeIds } = sortNodesParentFirst(payloadNodes, liveNodeIds);

  // 5) 节点 upsert。WHERE 双重守卫：删除胜出（墓碑行不得复活）+ 禁止跨板搬节点。
  //    被守卫拒绝的行不会出现在 RETURNING 里，据此算出 ignoredNodeIds。
  const deletedNodeSet = new Set(deletedNodeIds);
  const returnedNodeIds = new Set<string>();
  if (ordered.length > 0) {
    const nodeRows = ordered.map((node) => buildNodeRow(node, canvasId, defaultModel));
    const NODE_BATCH_SIZE = 200; // 200 × 21 参数 = 4200，远低于 PG 65535 上限
    for (const batch of chunkRows(nodeRows, NODE_BATCH_SIZE)) {
      const values: any[] = [];
      const res = await client.query(
        `INSERT INTO nodes (${NODE_INSERT_COLUMNS})
         VALUES ${buildTuples(batch, values)}
         ON CONFLICT (id) DO UPDATE SET
           parent_id = EXCLUDED.parent_id, type = EXCLUDED.type, title = EXCLUDED.title,
           question = EXCLUDED.question, answer = EXCLUDED.answer, note = EXCLUDED.note,
           content = EXCLUDED.content, messages = EXCLUDED.messages, status = EXCLUDED.status,
           pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, depth = EXCLUDED.depth,
           model_used = EXCLUDED.model_used, grounding = EXCLUDED.grounding,
           is_collapsed = EXCLUDED.is_collapsed, branch_trigger_phrase = EXCLUDED.branch_trigger_phrase,
           enable_web_search = EXCLUDED.enable_web_search, color = EXCLUDED.color,
           custom_data = EXCLUDED.custom_data,
           rev = nodes.rev + 1, updated_at = NOW()
         WHERE nodes.canvas_id = EXCLUDED.canvas_id AND nodes.deleted_at IS NULL
         RETURNING id`,
        values
      );
      for (const row of res.rows) returnedNodeIds.add(row.id as string);
    }
  }
  const ignoredNodeIds = ordered.map((n) => n.id as string).filter((id) => !returnedNodeIds.has(id));

  // 6) 节点墓碑 + 级联边墓碑
  if (deletedNodeIds.length > 0) {
    await client.query(
      `UPDATE nodes SET deleted_at = NOW(), rev = rev + 1, updated_at = NOW()
       WHERE canvas_id = $1 AND deleted_at IS NULL AND id = ANY($2::varchar[])`,
      [canvasId, deletedNodeIds]
    );
    await client.query(
      `UPDATE edges SET deleted_at = NOW(), rev = rev + 1, updated_at = NOW()
       WHERE canvas_id = $1 AND deleted_at IS NULL
         AND (source_id = ANY($2::varchar[]) OR target_id = ANY($2::varchar[]))`,
      [canvasId, deletedNodeIds]
    );
  }

  // 7) 显式边墓碑
  if (deletedEdgeIds.length > 0) {
    await client.query(
      `UPDATE edges SET deleted_at = NOW(), rev = rev + 1, updated_at = NOW()
       WHERE canvas_id = $1 AND deleted_at IS NULL AND id = ANY($2::varchar[])`,
      [canvasId, deletedEdgeIds]
    );
  }

  // 8) 边端点校验必须对「服务端存活节点集合」，不能对 payload 节点集合——
  //    否则 diff 语义下所有「连到未改动节点的新边」都会被误丢（合并模式最容易踩的坑）。
  //    存活集合由「写入前的存活 − 墓碑 + 本次接受」直接推出，不必再查一次库。
  const liveAfter = new Set<string>();
  for (const id of liveNodeIds) if (!deletedNodeSet.has(id)) liveAfter.add(id);
  for (const id of returnedNodeIds) if (!deletedNodeSet.has(id)) liveAfter.add(id);

  const edges = payloadEdges.filter(
    (e) => e?.source && e?.target && liveAfter.has(String(e.source)) && liveAfter.has(String(e.target))
  );
  if (edges.length < payloadEdges.length) {
    // 静默丢边很难排查，留一条日志（合并语义下这应当很少发生）
    console.warn(
      `[saveCanvas] 合并写入丢弃 ${payloadEdges.length - edges.length} 条端点非存活的边 canvas=${canvasId}`
    );
  }

  // 9) 边 upsert，同样带墓碑与跨板守卫
  if (edges.length > 0) {
    const edgeRows = edges.map((edge: any) => buildEdgeRow(edge, canvasId));
    const EDGE_BATCH_SIZE = 500;
    for (const batch of chunkRows(edgeRows, EDGE_BATCH_SIZE)) {
      const values: any[] = [];
      await client.query(
        `INSERT INTO edges (${EDGE_INSERT_COLUMNS})
         VALUES ${buildTuples(batch, values)}
         ON CONFLICT (id) DO UPDATE SET
           source_id = EXCLUDED.source_id, target_id = EXCLUDED.target_id,
           source_handle = EXCLUDED.source_handle, target_handle = EXCLUDED.target_handle,
           label = EXCLUDED.label, animated = EXCLUDED.animated, type = EXCLUDED.type,
           style = EXCLUDED.style, marker_end = EXCLUDED.marker_end,
           rev = edges.rev + 1, updated_at = NOW()
         WHERE edges.canvas_id = EXCLUDED.canvas_id AND edges.deleted_at IS NULL`,
        values
      );
    }
  }

  // 10) 计数必须在事务内重算：合并语义下 payload 长度 ≠ 板内总量
  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM nodes WHERE canvas_id = $1 AND deleted_at IS NULL) AS node_count,
       (SELECT COUNT(*)::int FROM edges WHERE canvas_id = $1 AND deleted_at IS NULL) AS edge_count`,
    [canvasId]
  );

  return {
    ignoredNodeIds,
    repairedNodeIds,
    nodeCount: counts.rows[0].node_count,
    edgeCount: counts.rows[0].edge_count,
  };
}

export async function saveCanvas(
  data: {
    id: string;
    title?: string;
    description?: string;
    viewport?: { x: number; y: number; zoom: number };
    defaultModel?: string;
    enableWebSearch?: boolean;
    nodes: any[];
    edges: any[];
    expectedUpdatedAt?: string;
    /** ADR-0017：缺失 = 1 = 整板替换（旧客户端）；>= 2 = 节点级合并 */
    protocolVersion?: number;
    deletedNodeIds?: string[];
    deletedEdgeIds?: string[];
  },
  userId: string,
  /** 新建画布（exists=false）前的配额闸门；复用事务内已查的 exists，省一次独立预查 */
  quotaGate?: (exists: boolean) => Promise<void>
): Promise<CanvasRecord> {
  const p = getPool();
  const now = new Date().toISOString();
  const vp = data.viewport || { x: 0, y: 0, zoom: 1 };

  // ADR-0017 协议分流：判据只能是显式版本号。旧客户端的整板 payload 与新客户端的
  // 「本次改动」结构上无法区分，且空数组在旧客户端是「清空」、在新客户端是「无删除」。
  const merge = (data.protocolVersion ?? 1) >= 2;
  // 回执里带上「本次按哪个协议解释」，与 saveMode 一起排障（阶段 6 观测）
  const protocolVersion = data.protocolVersion ?? 1;

  // 熔断旧写路径（阶段 6 soaker 之后再翻）：旧客户端会命中其降级分支弹「请刷新」并停止重试。
  // 刻意**不**带 latest_updated_at——带上会触发旧客户端的重试循环。
  if (!merge && process.env.SAVE_LEGACY_REPLACE_ENABLED === 'false') {
    console.warn(`[canvas-save] 409 CLIENT_OUTDATED canvas=${data.id}（旧协议客户端仍在写入）`);
    throw new ConflictError('客户端版本过旧，请刷新页面后重试', 'CLIENT_OUTDATED');
  }

  // 环链校验在权限/事务之前统一执行，PG 与内存双分支共用（技术债 #0006）。
  // 合并模式下这只是「payload 内」的快速拒绝，跨 payload 与服务端的环在事务内补判。
  assertAcyclicParentChain(data.nodes);

  // 归一化分两条路径，**不能共用**：
  // - legacy：去重 + 丢悬挂边（整板重插，端点必然都在 payload 里）
  // - merge：只去重，**绝不按 payload 端点过滤边**——diff 语义下「连到未改动节点的新边」
  //   端点不在 payload 里，按旧规则会被全部误丢。端点校验改在服务端存活集合上做。
  const normalized = merge
    ? { nodes: dedupeById(data.nodes, '节点', data.id), edges: dedupeById(data.edges, '边', data.id) }
    : normalizeCanvasPayload(data);

  /** 乐观锁：画布已存在且调用方声明了其已知版本时校验，防止并发静默覆盖 */
  const assertNoConflict = (serverUpdatedAt: string | null | undefined): void => {
    if (!data.expectedUpdatedAt || !serverUpdatedAt) return;
    const known = new Date(data.expectedUpdatedAt).getTime();
    if (Number.isNaN(known)) return; // 非法时间串视为未携带，避免恒等比较误报
    const current = new Date(serverUpdatedAt).getTime();
    if (known !== current) {
      // 409 只有一个来源：整板替换路径的画板级乐观锁（合并路径刻意不校验它，见下）。记一行，
      // 它是「还有多少旧客户端在跑」的直接读数——为 0 才能安全翻 SAVE_LEGACY_REPLACE_ENABLED。
      console.warn(`[canvas-save] 409 CANVAS_SAVE_CONFLICT canvas=${data.id}（整板替换路径版本落后）`);
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

      // 严格属主：仅属主本人可写（共享默认画板除外）
      if (existing.rows.length > 0 && existingUserId !== userId && !isSharedDefaultCanvas(data.id)) {
        throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
      }

      if (existing.rows.length > 0 && !merge) {
        // 合并模式下**刻意不校验画板级乐观锁**：挂机两小时的设备改一个节点照样会被
        // 409 挡下，用户报的「改完被云端的覆盖掉」就没修好。节点级 op 之间靠 rev 定序，
        // 冲突面从整块板缩到同一个节点。title/viewport 仍是整字段 LWW（只在真的改了时上行）。
        assertNoConflict(existing.rows[0].updated_at);
      }

      // 新建画布前配额校验（事务内复用 exists，避免服务层独立预查同一行）
      if (existing.rows.length === 0 && quotaGate) {
        await quotaGate(false);
      }

      const assignedUserId = existingUserId || userId;

      // 合并模式下 title/viewport/defaultModel 允许缺省 = 「本次没改」，用 COALESCE 保住原值；
      // 旧路径按原样传非空值，两条路径共用同一条 SQL，legacy 行为逐字不变。
      const titleParam = merge ? data.title ?? null : data.title || '未命名思维探索';
      const viewportParam =
        merge && !data.viewport ? [null, null, null] : [vp.x, vp.y, vp.zoom];
      const modelParam = merge ? data.defaultModel ?? null : data.defaultModel || '';

      upsertRes = await client.query(
        `INSERT INTO canvases (id, user_id, title, description, viewport_x, viewport_y, viewport_zoom, default_model, updated_at)
         VALUES ($1, $2, COALESCE($3, '未命名思维探索'), $4, COALESCE($5, 0), COALESCE($6, 0), COALESCE($7, 1), COALESCE($8, ''), NOW())
         ON CONFLICT (id) DO UPDATE SET
           title = COALESCE($3, canvases.title),
           description = COALESCE($4, canvases.description),
           viewport_x = COALESCE($5, canvases.viewport_x),
           viewport_y = COALESCE($6, canvases.viewport_y),
           viewport_zoom = COALESCE($7, canvases.viewport_zoom),
           default_model = COALESCE($8, canvases.default_model),
           updated_at = NOW()
         WHERE canvases.deleted_at IS NULL
         RETURNING created_at, updated_at, title, viewport_x, viewport_y, viewport_zoom, default_model`,
        [
          data.id,
          assignedUserId,
          titleParam,
          data.description || null,
          viewportParam[0],
          viewportParam[1],
          viewportParam[2],
          modelParam,
        ]
      );

      if (upsertRes.rowCount === 0) {
        // 并发窄窗口：SELECT 之后该行被其他连接软删，ON CONFLICT 的 WHERE 未命中
        throw new NotFoundError('画板不存在或已删除');
      }

      let mergeResult: MergeWriteResult | null = null;

      if (!merge) {
        // ---- 旧路径：整板替换（protocolVersion 缺失，行为逐字不变）----
        await client.query('DELETE FROM nodes WHERE canvas_id = $1', [data.id]);
        const nodeRows = normalized.nodes.map((node: any) =>
          buildNodeRow(node, data.id, data.defaultModel || '')
        );
        const NODE_BATCH_SIZE = 200;
        for (const batch of chunkRows(nodeRows, NODE_BATCH_SIZE)) {
          const values: any[] = [];
          await client.query(
            `INSERT INTO nodes (${NODE_INSERT_COLUMNS}) VALUES ${buildTuples(batch, values)}`,
            values
          );
        }

        await client.query('DELETE FROM edges WHERE canvas_id = $1', [data.id]);
        const edgeRows = normalized.edges.map((edge: any) => buildEdgeRow(edge, data.id));
        const EDGE_BATCH_SIZE = 500;
        for (const batch of chunkRows(edgeRows, EDGE_BATCH_SIZE)) {
          const values: any[] = [];
          await client.query(
            `INSERT INTO edges (${EDGE_INSERT_COLUMNS})
             VALUES ${buildTuples(batch, values)}
             ON CONFLICT (id) DO NOTHING`,
            values
          );
        }
      } else {
        // ---- 合并路径：只 upsert 本次改动，未带的一律不动 ----
        mergeResult = await mergeWriteCanvas(
          client,
          data.id,
          normalized.nodes,
          normalized.edges,
          Array.from(new Set(data.deletedNodeIds || [])),
          Array.from(new Set(data.deletedEdgeIds || [])),
          data.defaultModel || ''
        );
      }

      await client.query('COMMIT');

      // 以 DB 时间戳为准返回（乐观锁版本必须与下次 GET 一致），不再落穿到内存分支
      const row = upsertRes.rows[0];
      return {
        id: data.id,
        user_id: assignedUserId,
        title: row.title,
        description: data.description,
        viewport: { x: row.viewport_x, y: row.viewport_y, zoom: row.viewport_zoom },
        defaultModel: row.default_model,
        enableWebSearch: data.enableWebSearch ?? true,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        // 合并路径不回吐全量节点（payload 只是本次改动，回吐反而误导）；计数由事务内重算
        nodes: mergeResult ? undefined : normalized.nodes,
        edges: mergeResult ? undefined : normalized.edges,
        nodeCount: mergeResult ? mergeResult.nodeCount : normalized.nodes.length,
        edgeCount: mergeResult ? mergeResult.edgeCount : normalized.edges.length,
        saveMode: merge ? 'merge' : 'replace',
        protocolVersion,
        ...(mergeResult
          ? {
              ignoredNodeIds: mergeResult.ignoredNodeIds,
              repairedNodeIds: mergeResult.repairedNodeIds,
            }
          : {}),
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
  if (existing && existingUserId !== userId && !isSharedDefaultCanvas(data.id)) {
    throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
  }
  if (existing && !merge) {
    assertNoConflict(existing.updatedAt); // 合并模式刻意不校验画板级乐观锁，见 PG 分支注释
  }
  if (!existing && quotaGate) {
    await quotaGate(false);
  }

  if (!merge) {
    const record: CanvasRecord = {
      id: data.id,
      user_id: existingUserId || userId,
      title: data.title || '未命名思维探索',
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
      saveMode: 'replace',
      protocolVersion,
    };
    inMemoryStore.canvases.set(data.id, record);
    return record;
  }

  // ---- 内存分支的合并写入（与 PG 分支同语义，双模输出不得漂移）----
  const baseNodes: any[] = existing?.nodes || [];
  const baseEdges: any[] = existing?.edges || [];
  const liveNodeIds = new Set(baseNodes.filter((n) => !n?.deleted_at).map((n) => n.id));

  // 跨板搬节点拦截（与 PG 分支同语义）。内存分支没有全局节点表，节点散在各自的
  // canvas.nodes 里，只能扫一遍——这是降级分支，正确性优先于这点开销。
  if (normalized.nodes.length > 0) {
    const submitted = new Set(normalized.nodes.map((n) => n.id));
    for (const [cid, c] of inMemoryStore.canvases) {
      if (cid === data.id) continue;
      if ((c.nodes || []).some((n: any) => submitted.has(n.id))) {
        throw new ValidationError('节点不属于当前画板，已拒绝保存', 'NODE_CANVAS_MISMATCH');
      }
    }
  }
  const parentOf = new Map<string, string | null>(
    baseNodes
      .filter((n) => !n?.deleted_at)
      .map((n) => [n.id, (n?.data?.parentId as string | null) ?? null] as const)
  );
  for (const n of normalized.nodes) {
    const pid = n?.data?.parentId ? String(n.data.parentId) : null;
    parentOf.set(n.id, pid === n.id ? null : pid);
  }
  assertAcyclicParentMap(parentOf);

  const { ordered, repairedNodeIds } = sortNodesParentFirst(normalized.nodes, liveNodeIds);

  const deletedNodeSet = new Set(data.deletedNodeIds || []);
  const deletedEdgeSet = new Set(data.deletedEdgeIds || []);
  const ignoredNodeIds: string[] = [];
  const mergedNodes = [...baseNodes];

  for (const node of ordered) {
    const idx = mergedNodes.findIndex((n) => n.id === node.id);
    if (idx >= 0 && mergedNodes[idx]?.deleted_at) {
      ignoredNodeIds.push(node.id); // 删除胜出：墓碑行不得复活
      continue;
    }
    if (idx >= 0) mergedNodes[idx] = node;
    else mergedNodes.push(node);
  }

  // 节点墓碑 + 级联边墓碑（先于边 upsert，保证同批「既带又删」以删除收场）
  const tombstonedNow = new Set<string>();
  if (deletedNodeSet.size > 0) {
    for (let i = 0; i < mergedNodes.length; i++) {
      const n = mergedNodes[i];
      if (deletedNodeSet.has(n.id) && !n.deleted_at) {
        mergedNodes[i] = { ...n, deleted_at: now };
        tombstonedNow.add(n.id);
      }
    }
  }

  const mergedEdges = [...baseEdges];
  const edgeTouched = (e: any): boolean =>
    deletedEdgeSet.has(e.id) ||
    (!e.deleted_at && (tombstonedNow.has(String(e.source)) || tombstonedNow.has(String(e.target))));
  for (let i = 0; i < mergedEdges.length; i++) {
    const e = mergedEdges[i];
    if (e.deleted_at) continue;
    if (edgeTouched(e)) mergedEdges[i] = { ...e, deleted_at: now };
  }

  const liveAfter = new Set<string>();
  for (const n of mergedNodes) if (!n.deleted_at && !tombstonedNow.has(n.id)) liveAfter.add(n.id);

  for (const edge of normalized.edges) {
    if (!edge?.source || !edge?.target) continue;
    if (!liveAfter.has(String(edge.source)) || !liveAfter.has(String(edge.target))) continue;
    const idx = mergedEdges.findIndex((e) => e.id === edge.id);
    if (idx >= 0 && mergedEdges[idx]?.deleted_at) continue; // 删除胜出
    if (idx >= 0) mergedEdges[idx] = edge;
    else mergedEdges.push(edge);
  }

  const record: CanvasRecord = {
    id: data.id,
    user_id: existingUserId || userId,
    title: data.title ?? existing?.title ?? '未命名思维探索',
    description: data.description ?? existing?.description,
    viewport: data.viewport ?? existing?.viewport ?? vp,
    defaultModel: data.defaultModel ?? existing?.defaultModel ?? '',
    enableWebSearch: data.enableWebSearch ?? existing?.enableWebSearch ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    nodes: mergedNodes,
    edges: mergedEdges,
    nodeCount: mergedNodes.filter((n) => !n.deleted_at).length,
    edgeCount: mergedEdges.filter((e) => !e.deleted_at).length,
    saveMode: 'merge',
    protocolVersion,
    ignoredNodeIds,
    repairedNodeIds,
  };
  inMemoryStore.canvases.set(data.id, record);
  return record;
}

export async function deleteCanvas(canvasId: string, userId: string): Promise<boolean> {
  // 默认画板禁删（两种模式都禁，与授权解耦）：软删会让所有用户对该 id 永久 404
  if (isDefaultCanvasPublicId(canvasId)) {
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
      if (check.rows[0].user_id !== userId) {
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
  if (canvas.user_id !== userId) {
    throw new ForbiddenError('无权删除此画板', 'CANVAS_FORBIDDEN');
  }
  canvas.deleted_at = new Date().toISOString();
  canvas.nodes = [];
  canvas.edges = [];
  return true;
}

/** Spec L1 / ADR-0015：画板库元数据补丁（只改这几项，不触碰 nodes/edges、不走内容乐观锁） */
export interface CanvasMetaPatch {
  title?: string;
  isFavorite?: boolean;
  isArchived?: boolean;
  /** null = 移出分组；字符串 = 挂到该分组（须属于画板属主） */
  folderId?: string | null;
}

/**
 * 轻量元数据更新（收藏 / 归档 / 标题）。
 *
 * 与 deleteCanvas 同口径的属主校验。legacy 模式下默认板是全局单行（所有用户共用），任何
 * 用户级偏好（收藏/归档）都会影响他人，故整体禁改（变更标题请走画板自身保存）；private 模式
 * 下它是属主自己的普通画板，收藏/归档照常（判据用 isSharedDefaultCanvas，随模式切换）。
 * 返回最新 updated_at：由应用层在每个 UPDATE 里显式 `NOW()` 推进（`initDbSchema()` **不创建
 * 任何触发器**，设计稿里的 `trigger_set_timestamp()` 只是历史设计稿，见 docs/数据库建表脚本.sql），
 * 前端必须用它推进乐观锁版本，否则下一次内容保存会 409。
 */
/**
 * 节点/边墓碑 GC（ADR-0017，挂日清任务）。
 *
 * 合并写入把「删除」表达为软删墓碑（`deleted_at` 非空的 nodes/edges 行），而不是物理删行——
 * 墓碑是「删除胜出」的载体：陈旧的挂机设备再上传那些节点时会被 `WHERE deleted_at IS NULL`
 * 的守卫拒绝，不会把删掉的内容复活。代价是墓碑会随删除次数无限累积，需要按保留期回收。
 *
 * - 保留期默认 30 天（对齐 ADR-0005 的软删冷却口径），由 `CANVAS_TOMBSTONE_RETENTION_DAYS` 配置；
 * - **先删边再删节点**：边引用节点，顺序反过来会有一小段「边还在、节点没了」的窗口；
 * - 只回收**过期的**墓碑，新墓碑一律保留（否则刚删的内容会被挂机设备当场复活）。
 *
 * 风险边界（接受）：GC 之后，超过保留期未联网、本地仍持有那些节点的陈旧客户端再上传时会把
 * 它们复活。复活的内容是该用户自己的、节点 id 由客户端生成（UUIDv7，不可能与他人复用），
 * 且 30 天远大于 sync-queue 的退避上限（`MAX_RETRIES=5`，间隔 `min(2^n·2s, 30s)`），
 * 正常联网的设备不可能拖到那时还没把删除传上来。
 *
 * 内存分支无需 GC：墓碑就是进程内 Map 里记录的 `deleted_at` 字段，重启即空。
 */
export async function cleanupCanvasTombstones(
  retentionDays = 30
): Promise<{ edges: number; nodes: number }> {
  const p = getPool();
  if (p) {
    try {
      // 保留期 <= 0 视为「全部回收」（与 cleanupDeletedUsers 口径一致，便于运维一键清空）
      const expired =
        retentionDays > 0
          ? `deleted_at IS NOT NULL AND deleted_at <= NOW() - make_interval(days => $1)`
          : `deleted_at IS NOT NULL`;
      const args = retentionDays > 0 ? [retentionDays] : [];
      const edges = await p.query(`DELETE FROM edges WHERE ${expired}`, args);
      const nodes = await p.query(`DELETE FROM nodes WHERE ${expired}`, args);
      return { edges: edges.rowCount || 0, nodes: nodes.rowCount || 0 };
    } catch (e) {
      handlePgError(e);
      console.warn('PG cleanupCanvasTombstones failed:', e);
    }
  }

  // 内存兜底：内存分支的删除是数组内标记（`deleted_at` 字段），随进程消亡，没有可回收的行
  void inMemoryStore.canvases.size;
  return { edges: 0, nodes: 0 };
}

export async function updateCanvasMeta(
  canvasId: string,
  patch: CanvasMetaPatch,
  userId: string
): Promise<CanvasRecord> {
  if (isSharedDefaultCanvas(canvasId)) {
    throw new ForbiddenError('共享默认画板不支持收藏/归档等个性化设置', 'CANVAS_FORBIDDEN');
  }

  const p = getPool();
  if (p) {
    const client = await p.connect();
    try {
      await initDbSchema();
      await client.query('BEGIN');
      const check = await client.query('SELECT user_id FROM canvases WHERE id = $1 AND deleted_at IS NULL', [canvasId]);
      if (check.rows.length === 0) {
        throw new NotFoundError('画板不存在或已删除');
      }
      const canvasOwner = check.rows[0].user_id;
      if (canvasOwner !== userId) {
        throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
      }
      // 分组归属校验：folderId 必须属于「画板属主」（而非请求者），防跨租户串联
      if (patch.folderId != null) {
        const f = await client.query('SELECT user_id FROM folders WHERE id = $1', [patch.folderId]);
        if (f.rows.length === 0 || f.rows[0].user_id !== canvasOwner) {
          throw new ValidationError('分组不存在或不属于该画板属主', 'FOLDER_INVALID');
        }
      }

      const hasFolderPatch = patch.folderId !== undefined;
      const res = await client.query(
        `UPDATE canvases SET
           title = COALESCE($2, title),
           is_favorite = COALESCE($3, is_favorite),
           is_archived = COALESCE($4, is_archived),
           folder_id = CASE WHEN $5::boolean THEN $6::varchar ELSE folder_id END,
           updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, user_id, title, description, viewport_x, viewport_y, viewport_zoom,
                   default_model, is_favorite, is_archived, folder_id, created_at, updated_at`,
        [
          canvasId,
          patch.title ?? null,
          patch.isFavorite ?? null,
          patch.isArchived ?? null,
          hasFolderPatch,
          patch.folderId ?? null,
        ]
      );
      if (res.rowCount === 0) {
        // 并发窄窗口：SELECT 之后该行被其他连接软删
        throw new NotFoundError('画板不存在或已删除');
      }
      await client.query('COMMIT');

      const r = res.rows[0];
      return {
        id: r.id,
        user_id: r.user_id,
        title: r.title,
        description: r.description,
        viewport: { x: r.viewport_x, y: r.viewport_y, zoom: r.viewport_zoom },
        defaultModel: r.default_model,
        enableWebSearch: true,
        isFavorite: r.is_favorite ?? false,
        isArchived: r.is_archived ?? false,
        folderId: r.folder_id ?? null,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      // 业务错误（403/404）必须穿透，不得降级落内存分支造成 200 假成功
      if (e instanceof AppError) throw e;
      handlePgError(e);
      console.warn(`PG updateCanvasMeta(${canvasId}) fallback to in-memory:`, e);
    } finally {
      client.release();
    }
  }

  const canvas = inMemoryStore.canvases.get(canvasId);
  if (!canvas || canvas.deleted_at) {
    throw new NotFoundError('画板不存在或已删除');
  }
  if (canvas.user_id !== userId) {
    throw new ForbiddenError('无权修改其他用户的画板', 'CANVAS_FORBIDDEN');
  }
  if (patch.folderId != null) {
    const folder = inMemoryStore.folders.get(patch.folderId);
    if (!folder || folder.user_id !== canvas.user_id) {
      throw new ValidationError('分组不存在或不属于该画板属主', 'FOLDER_INVALID');
    }
  }
  if (patch.title !== undefined) canvas.title = patch.title;
  if (patch.isFavorite !== undefined) canvas.isFavorite = patch.isFavorite;
  if (patch.isArchived !== undefined) canvas.isArchived = patch.isArchived;
  if (patch.folderId !== undefined) canvas.folderId = patch.folderId;
  canvas.updatedAt = new Date().toISOString();
  return {
    ...canvas,
    isFavorite: canvas.isFavorite ?? false,
    isArchived: canvas.isArchived ?? false,
    folderId: canvas.folderId ?? null,
  };
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
  return (canvas?.nodes || []).filter((n: any) => (n.type || 'chat') === 'chat' && !n?.deleted_at).length;
}

/**
 * 节点检索（严格属主制）：userId 必填，只返回本人画布的节点。
 * 2026-09-11 安全修复：此前 userId 可选，省略即走 `$n::uuid IS NULL` 放行分支退化为全站检索，
 * 属跨租户读取的潜在旁路；现收敛为必填，SQL 不再保留 NULL 放行分支（ADR-0016 口径）。
 */
export async function searchNodes(queryText: string, userId: string, canvasId?: string): Promise<any[]> {
  const p = getPool();
  if (p && queryText.trim()) {
    try {
      await initDbSchema();
      const sql = canvasId
        ? `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE n.canvas_id = $1 AND c.deleted_at IS NULL AND c.user_id = $2 AND n.deleted_at IS NULL
             AND (n.question ILIKE $3 OR n.answer ILIKE $3 OR n.note ILIKE $3)
           LIMIT 30`
        : `SELECT n.id, n.canvas_id, n.question as title, n.question, n.answer, n.note as note_content, n.depth, n.model_used as model, n.created_at
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           WHERE c.deleted_at IS NULL AND c.user_id = $1 AND n.deleted_at IS NULL
             AND (n.question ILIKE $2 OR n.answer ILIKE $2 OR n.note ILIKE $2)
           LIMIT 30`;
      const params = canvasId
        ? [canvasId, userId, `%${queryText.trim()}%`]
        : [userId, `%${queryText.trim()}%`];
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
    if (canvas.user_id !== userId) continue; // 严格属主制：userId 必填，跨租户一律不返回
    for (const node of canvas.nodes || []) {
      if (node?.deleted_at) continue; // 墓碑行不参与检索（与 PG 分支 n.deleted_at IS NULL 同口径）
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
