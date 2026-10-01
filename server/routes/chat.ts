import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, validateInputLimits, roleBasedRateLimiter } from '../middleware/auth.js';
import { chatQuotaMiddleware } from '../middleware/quota.js';
import { validate } from '../lib/validate.js';
import { AppError } from '../lib/errors.js';
import { chatOrchestrator } from '../services/ai/chat-orchestrator.service.js';

export { MAX_GROUNDING_SOURCES, MAX_GROUNDING_QUERIES } from '../services/ai/ai-constants.js';

export const chatRouter = Router();

/**
 * Spec F3：POST /api/chat 入参 zod 校验
 * （长度规则仍由 validateInputLimits 中间件负责）
 */
const ChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'model']),
        content: z.string(),
      })
    )
    .min(1, '提问消息列表不能为空'),
  model: z.string().optional(),
  canvasId: z.string().nullable().optional(),
  nodeId: z.string().nullable().optional(),
  systemInstruction: z.string().optional(),
});

/**
 * POST /api/chat
 * Secure AI chat with input limits, quota pre-check, SSE streaming, and post-inference audit logging
 * Supports both Google Gemini native models and OpenAI-compatible models (DeepSeek, GPT-4o, etc.)
 */
chatRouter.post(
  '/',
  authMiddleware,
  roleBasedRateLimiter,
  validateInputLimits,
  chatQuotaMiddleware,
  async (req: Request, res: Response) => {
    const user = req.user!;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    let parsed;
    try {
      parsed = validate(ChatSchema, req.body);
    } catch (error: unknown) {
      if (error instanceof AppError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }

    await chatOrchestrator.streamChat({
      user,
      messages: parsed.messages,
      model: parsed.model,
      systemInstruction: parsed.systemInstruction,
      canvasId: parsed.canvasId,
      nodeId: parsed.nodeId,
      res,
    });
  }
);
