import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listUserCanvases,
  getCanvasOrFail,
  saveUserCanvas,
  deleteUserCanvas,
  searchUserNodes,
} from '../services/canvas.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { authMiddleware, shareActionRateLimiter, autoTitleRateLimiter } from '../middleware/auth.js';
import { validate } from '../lib/validate.js';
import { createShareForCanvas, revokeShareForCanvas } from '../services/share.service.js';
import { generateAutoTitles } from '../services/title.service.js';
import { recordAiRequestLog } from '../services/ai.service.js';

export const canvasesRouter = Router();

/**
 * Spec F3：POST /api/canvases/:id/save 入参 zod 校验（id 由路由 params 提供）
 */
const SaveCanvasSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  viewport: z
    .object({
      x: z.number(),
      y: z.number(),
      zoom: z.number(),
    })
    .optional(),
  defaultModel: z.string().optional(),
  enableWebSearch: z.boolean().optional(),
  nodes: z.array(z.record(z.string(), z.any())).default([]),
  edges: z.array(z.record(z.string(), z.any())).default([]),
  expectedUpdatedAt: z.string().datetime({ message: 'expectedUpdatedAt 必须是 ISO 时间串' }).optional(),
});

// Apply auth to all canvas management routes for multi-tenant isolation
canvasesRouter.use(authMiddleware);

/**
 * GET /api/canvases
 * List only current user's canvases (admin can see all)
 */
canvasesRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const isAdmin = user.role === 'admin';
  const canvases = await listUserCanvases(user.id, isAdmin);
  res.json(canvases);
}));

/**
 * GET /api/canvases/:id
 * Get single canvas with IDOR check
 */
canvasesRouter.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const isAdmin = user.role === 'admin';
  const canvas = await getCanvasOrFail(req.params.id, user.id, isAdmin);
  res.json(canvas);
}));

/**
 * POST /api/canvases/:id/save
 * Save canvas state with tenant ownership enforcement
 */
canvasesRouter.post('/:id/save', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const isAdmin = user.role === 'admin';
  const body = validate(SaveCanvasSchema, req.body);

  const saved = await saveUserCanvas(
    {
      id: req.params.id,
      title: body.title,
      description: body.description,
      viewport: body.viewport,
      defaultModel: body.defaultModel,
      enableWebSearch: body.enableWebSearch,
      nodes: body.nodes,
      edges: body.edges,
      expectedUpdatedAt: body.expectedUpdatedAt,
    },
    user.id,
    isAdmin
  );

  // 响应瘦身：前端与测试仅消费 canvas.updatedAt（乐观锁版本），不再回显全量 nodes/edges
  const { nodes: _nodes, edges: _edges, ...canvasMeta } = saved;
  res.json({ success: true, canvas: canvasMeta });
}));

/**
 * POST /api/canvases/:id/auto-title（自动命名）
 * 根据「用户提问 + 回答摘录」生成节点标题与画板名（一次 LLM 调用产出两者）。
 * 非关键路径：LLM 失败静默返回 null，前端保留现有截断标题；调用落 ai_request_logs 归因。
 * 画布可能尚未同步（首节点完成先于首次自动保存），故不做画布存在性/属主校验，仅要求登录。
 */
const AutoTitleSchema = z.object({
  nodeId: z.string().max(64).optional(),
  question: z.string().min(1, '提问内容不能为空').max(2000),
  answer: z.string().max(4000).optional().default(''),
  includeBoard: z.boolean().optional().default(false),
});

canvasesRouter.post('/:id/auto-title', autoTitleRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const body = validate(AutoTitleSchema, req.body);
  const startTime = Date.now();

  const { result, meta } = await generateAutoTitles({
    question: body.question,
    answer: body.answer,
    includeBoard: body.includeBoard,
  });

  await recordAiRequestLog({
    userId: user.id,
    canvasId: req.params.id,
    nodeId: body.nodeId || null,
    modelName: meta.modelName,
    totalTokens: meta.totalTokens,
    latencyMs: Date.now() - startTime,
    status: meta.ok ? 'success' : 'error',
    errorMessage: meta.error || null,
    groundingChunksCount: 0,
    provider: `${meta.provider}-title`,
  });

  res.json({
    success: true,
    nodeTitle: result.nodeTitle,
    boardTitle: body.includeBoard ? result.boardTitle : null,
  });
}));

/**
 * DELETE /api/canvases/:id
 * Delete canvas with tenant check
 */
canvasesRouter.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const isAdmin = user.role === 'admin';
  const success = await deleteUserCanvas(req.params.id, user.id, isAdmin);
  res.json({ success });
}));

/**
 * POST /api/canvases/:id/share（Spec K1 / B1）
 * 创建（或幂等重建）画布的快照式只读分享；严格属主制，重复调用返回同一画板的最新分享。
 */
canvasesRouter.post('/:id/share', shareActionRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host') || 'localhost'}`;
  const result = await createShareForCanvas(user, req.params.id, appUrl);
  res.json(result);
}));

/**
 * DELETE /api/canvases/:id/share（Spec K1 / B1）
 * 撤销画布分享（软撤）；严格属主制。
 */
canvasesRouter.delete('/:id/share', shareActionRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  await revokeShareForCanvas(user, req.params.id);
  res.json({ success: true });
}));

/**
 * GET /api/canvases/:id/search
 * Search nodes inside canvas
 */
canvasesRouter.get('/:id/search', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const results = await searchUserNodes(query, req.params.id, user.id);
  res.json({ results });
}));
