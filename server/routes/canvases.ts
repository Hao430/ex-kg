import { Router, Request, Response } from 'express';
import { listCanvases, getCanvas, saveCanvas, deleteCanvas, searchNodes } from '../db.js';
import { authMiddleware } from '../middlewares.js';

export const canvasesRouter = Router();

// Apply auth to all canvas management routes for multi-tenant isolation
canvasesRouter.use(authMiddleware);

/**
 * GET /api/canvases
 * List only current user's canvases (admin can see all)
 */
canvasesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const isAdmin = user.role === 'admin';
    const canvases = await listCanvases(user.id, isAdmin);
    res.json(canvases);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to list canvases' });
  }
});

/**
 * GET /api/canvases/:id
 * Get single canvas with IDOR check
 */
canvasesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const isAdmin = user.role === 'admin';
    const canvas = await getCanvas(req.params.id, user.id, isAdmin);

    if (!canvas) {
      res.status(404).json({ error: '画板不存在或无权访问 (IDOR Protected)' });
      return;
    }
    res.json(canvas);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to get canvas' });
  }
});

/**
 * POST /api/canvases/:id/save
 * Save canvas state with tenant ownership enforcement
 */
canvasesRouter.post('/:id/save', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const isAdmin = user.role === 'admin';
    const { title, description, viewport, defaultModel, enableWebSearch, nodes, edges } = req.body;

    const saved = await saveCanvas(
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
  } catch (error: any) {
    console.error('Failed to save canvas:', error);
    const status = error?.message?.includes('IDOR') ? 403 : 500;
    res.status(status).json({ error: error?.message || 'Failed to save canvas state' });
  }
});

/**
 * DELETE /api/canvases/:id
 * Delete canvas with tenant check
 */
canvasesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const isAdmin = user.role === 'admin';
    const success = await deleteCanvas(req.params.id, user.id, isAdmin);
    res.json({ success });
  } catch (error: any) {
    const status = error?.message?.includes('IDOR') ? 403 : 500;
    res.status(status).json({ error: error?.message || 'Failed to delete canvas' });
  }
});

/**
 * GET /api/canvases/:id/search
 * Search nodes inside canvas
 */
canvasesRouter.get('/:id/search', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const results = await searchNodes(query, req.params.id, user.id);
    res.json({ results });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Search failed' });
  }
});
