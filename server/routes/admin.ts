import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listAdminUsers,
  getAdminOverview,
  updateUserStatus,
  grantUserVipDays,
  getUserOrFail,
  restoreAccount,
  getMaskedModelConfig,
  resolveConfigForSave,
  saveModelConfigWithAudit,
  listAllOrders,
  listAuditLogs,
} from '../services/admin.service.js';
import { getAiModelConfig } from '../services/ai.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { GoogleGenAI } from '@google/genai';

export const adminRouter = Router();

// Apply auth and admin check to all admin routes
adminRouter.use(authMiddleware);
adminRouter.use(requireAdmin);

/**
 * GET /api/admin/overview
 * Operation dashboard metrics (total users, tokens, canvases, models)
 */
adminRouter.get('/overview', asyncHandler(async (_req: Request, res: Response) => {
  const overview = await getAdminOverview();
  res.json({ success: true, overview });
}));

/**
 * GET /api/admin/users
 * Paginated user query with filters
 */
adminRouter.get('/users', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const role = typeof req.query.role === 'string' ? req.query.role : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const result = await listAdminUsers({ page, limit, search, role, status });
  res.json({
    success: true,
    ...result,
    page,
    limit,
  });
}));

/**
 * GET /api/admin/audit-logs
 * Paginated audit log query (Spec F2)
 */
adminRouter.get('/audit-logs', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;

  const result = await listAuditLogs({ page, limit, action, userId });
  res.json({
    success: true,
    ...result,
    page,
    limit,
  });
}));

/**
 * GET /api/admin/orders
 * Paginated order list (Spec E3) with optional status filter
 */
adminRouter.get('/orders', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  // 'all'（前端默认视图）归一为不过滤（审计修复：High-2）
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : '';
  const status = rawStatus && rawStatus !== 'all' ? rawStatus : undefined;

  const result = await listAllOrders({ page, limit, status });
  res.json({
    success: true,
    ...result,
    page,
    limit,
  });
}));

/**
 * PUT /api/admin/users/:id/status
 * Freeze or unfreeze a user account. If frozen, kicks active sessions.
 */
const UserStatusSchema = z.object({
  is_active: z.boolean(),
});

adminRouter.put('/users/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const { is_active } = validate(UserStatusSchema, req.body, 'INVALID_STATUS');
  const targetUser = await getUserOrFail(req.params.id);

  // Protect super admin from self-freezing
  if (targetUser.id === req.user!.id && !is_active) {
    res.status(400).json({ error: '不能冻结当前登录的管理员自身账号' });
    return;
  }

  const updated = await updateUserStatus(targetUser.id, is_active, {
    actorId: req.user!.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({
    success: true,
    message: is_active ? '账号已成功解封' : '账号已被冻结并强制踢下线',
    user: updated,
  });
}));

/**
 * PUT /api/admin/users/:id/restore
 * Spec F4：恢复已注销账号（30 天冷却期内）。未注销/不存在 → 404。
 */
adminRouter.put('/users/:id/restore', asyncHandler(async (req: Request, res: Response) => {
  const restored = await restoreAccount(req.user!.id, req.params.id);
  res.json({
    success: true,
    message: '账号已恢复',
    user: restored,
  });
}));

/**
 * POST /api/admin/users/:id/vip
 * Grant or extend VIP membership days for a user
 */
const GrantVipSchema = z.object({
  days: z.number().int().min(0, '天数不能为负数'),
});

adminRouter.post('/users/:id/vip', asyncHandler(async (req: Request, res: Response) => {
  const { days } = validate(GrantVipSchema, req.body, 'INVALID_VIP_DAYS');
  const targetUser = await getUserOrFail(req.params.id);

  const result = await grantUserVipDays({
    userId: targetUser.id,
    days,
    actorId: req.user!.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const formattedDate = result.vip_expires_at
    ? new Date(result.vip_expires_at).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  res.json({
    success: true,
    message: days > 0
      ? `已成功为用户 ${targetUser.email} 增授 ${days} 天 VIP 会员（到期时间：${formattedDate}）`
      : `已取消用户 ${targetUser.email} 的 VIP 会员权限`,
    user: result.user,
    vip_expires_at: result.vip_expires_at,
  });
}));

/**
 * GET /api/admin/model-config
 * Retrieve current active AI Model & Provider settings (masking secrets)
 */
adminRouter.get('/model-config', asyncHandler(async (_req: Request, res: Response) => {
  const config = await getMaskedModelConfig();
  res.json({ success: true, config });
}));

/**
 * PUT /api/admin/model-config
 * Update AI Model & Provider settings
 */
const ModelConfigSchema = z.object({
  provider: z.enum(['gemini', 'openai']),
  openai_base_url: z.string().optional().default('https://api.openai.com/v1'),
  openai_api_key: z.string().optional().default(''),
  openai_model: z.string().min(1, '请输入有效的模型名称'),
  gemini_model: z.string().optional().default('gemini-3.8-flash'),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().min(100).max(32000).optional().default(4096),
  custom_system_prompt: z.string().optional().default(''),
  vip_only_models: z.array(z.string()).optional(),
});

adminRouter.put('/model-config', asyncHandler(async (req: Request, res: Response) => {
  const data = validate(ModelConfigSchema, req.body, 'INVALID_CONFIG');
  const resolved = await resolveConfigForSave(data);

  const saved = await saveModelConfigWithAudit(resolved, req.user?.email, {
    actorId: req.user!.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  res.json({
    success: true,
    message: '模型与接口配置已成功保存并立即生效',
    config: {
      ...saved,
      openai_api_key: saved.openai_api_key ? '••••••••' : '',
      has_openai_key: Boolean(saved.openai_api_key),
    },
  });
}));

/**
 * POST /api/admin/model-config/test
 * Test AI model connectivity in OpenAI or Gemini format
 */
adminRouter.post('/model-config/test', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { provider, openai_base_url, openai_api_key, openai_model, gemini_model } = req.body;
    const currentConfig = await getAiModelConfig();

    if (provider === 'openai') {
      const baseUrl = (openai_base_url || currentConfig.openai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
      let apiKey = openai_api_key;
      if (!apiKey || apiKey.includes('••••')) {
        apiKey = currentConfig.openai_api_key;
      }

      if (!apiKey) {
        res.status(400).json({ error: '请先填写 OpenAI 兼容 API Key', code: 'MISSING_API_KEY' });
        return;
      }

      const model = openai_model || currentConfig.openai_model || 'deepseek-chat';
      const endpoint = `${baseUrl}/chat/completions`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a test assistant.' },
            { role: 'user', content: 'Ping: Please reply with "DeepDive OpenAI Integration OK!" in 10 words.' },
          ],
          max_tokens: 50,
          temperature: 0.3,
        }),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = errText;
        try {
          const jsonErr = JSON.parse(errText);
          errMsg = jsonErr?.error?.message || jsonErr?.message || errText;
        } catch {}
        res.status(400).json({
          success: false,
          error: `HTTP ${response.status} 错误: ${errMsg}`,
          latencyMs,
          endpoint,
        });
        return;
      }

      const data = await response.json();
      const reply = data?.choices?.[0]?.message?.content || '无内容返回';

      res.json({
        success: true,
        message: 'OpenAI 格式接口联调测试成功！',
        reply,
        latencyMs,
        modelUsed: data?.model || model,
        endpoint,
      });
      return;
    } else {
      // Gemini test
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.status(400).json({ error: '环境变量 GEMINI_API_KEY 未配置' });
        return;
      }
      const ai = new GoogleGenAI({ apiKey });
      const model = gemini_model || 'gemini-3.8-flash';
      const result = await ai.models.generateContent({
        model,
        contents: 'Ping: Please reply with "DeepDive Gemini Integration OK!" in 10 words.',
      });
      const latencyMs = Date.now() - startTime;
      res.json({
        success: true,
        message: 'Google Gemini 引擎测试成功！',
        reply: result.text || '就绪',
        latencyMs,
        modelUsed: model,
      });
    }
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    console.error('Admin test model connection error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || '测试连接超时或失败',
      latencyMs,
    });
  }
});
