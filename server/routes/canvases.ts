import { Router, Request, Response } from 'express';
import {
  listUserCanvases,
  getCanvasOrFail,
  saveUserCanvas,
  deleteUserCanvas,
  searchUserNodes,
} from '../services/canvas.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { authMiddleware } from '../middleware/auth.js';

export const canvasesRouter = Router();

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
  const { title, description, viewport, defaultModel, enableWebSearch, nodes, edges } = req.body;

  const saved = await saveUserCanvas(
    {
      id: req.params.id,
      title,
      description,
      viewport,
      defaultModel,
      enableWebSearch,
      nodes: nodes || [],
      edges: edges || [],
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
