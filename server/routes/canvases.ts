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
import { authMiddleware, shareActionRateLimiter } from '../middleware/auth.js';
import { validate } from '../lib/validate.js';
import { createShareForCanvas, revokeShareForCanvas } from '../services/share.service.js';

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

  res.json({ success: true, canvas: saved });
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
