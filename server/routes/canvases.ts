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
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../lib/validate.js';

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
 * GET /api/canvases/:id/search
 * Search nodes inside canvas
 */
canvasesRouter.get('/:id/search', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const results = await searchUserNodes(query, req.params.id, user.id);
  res.json({ results });
}));
