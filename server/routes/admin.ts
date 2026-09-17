import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listAdminUsers,
  getAdminOverview,
  updateUserStatus,
  grantUserVipDays,
  getUserOrFail,
  restoreAccount,
  adminUpdateUserEmail,
  unbindOAuthIdentity,
  getMaskedModelConfig,
  resolveConfigForSave,
  saveModelConfigWithAudit,
  listAllOrders,
  listAuditLogs,
  listAiRequestLogs,
  listEventLogs,
} from '../services/admin.service.js';
import { listFeedbacksForAdmin, updateFeedbackStatus } from '../services/feedback.service.js';
import { getAiModelConfig, isModelConfigured } from '../services/ai.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { checkDbStatus } from '../core/db-status.js';
import { validate } from '../lib/validate.js';
import { authMiddleware, requireAdmin, adminLogReadRateLimiter, adminUserWriteRateLimiter, adminFeedbackReadRateLimiter } from '../middleware/auth.js';
import { runWithSystem } from '../core/db-context.js';
import { assertSafeOutboundUrl } from '../lib/outbound-url.js';
import { AppError } from '../lib/errors.js';
import { GoogleGenAI } from '@google/genai';

export const adminRouter = Router();

// Apply auth and admin check to all admin routes
adminRouter.use(authMiddleware);
adminRouter.use(requireAdmin);

// 运营台的聚合统计/日志/用户管理**必然跨租户**（ADR-0016 保留的 admin 能力就只有这些），
// 因此在鉴权通过后整台路由切到 system 作用域（ADR-0019）。位置必须在 requireAdmin 之后：
// 作用域是「已确认是管理员」才授予的跨租户通行证，不是路由自带属性。
adminRouter.use((_req, _res, next) => runWithSystem('admin: 跨租户运营台聚合与用户管理（ADR-0016）', next));

/**
 * GET /api/admin/overview
 * Operation dashboard metrics (total users, tokens, canvases, models)
 * 附带 database（checkDbStatus）：底座存储状态供前端「底座数据存储与事务状态」面板消费
 */
adminRouter.get('/overview', asyncHandler(async (_req: Request, res: Response) => {
  const overview = await getAdminOverview();
  const database = await checkDbStatus();
  // Spec E4：模型配置状态透出（false = 管理员未配置可用模型，全站推理 400 MODEL_NOT_CONFIGURED），
  // Admin 后台据此展示醒目告警横幅
  const modelConfigured = await isModelConfigured();
  res.json({ success: true, overview, database, modelConfigured });
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
 * GET /api/admin/ai-logs
 * 分页查询 AI 推演调用日志（Spec I 可观测：含 provider/联网检索/首字延迟/容灾明细）
 */
adminRouter.get('/ai-logs', adminLogReadRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;

  const result = await listAiRequestLogs({ page, limit, status, userId });
  res.json({
    success: true,
    ...result,
    page,
    limit,
  });
}));

/**
 * GET /api/admin/event-logs
 * 分页查询业务事件日志（Spec I 可观测：画布冲突/配额拦截/推演容灾等）
 */
adminRouter.get('/event-logs', adminLogReadRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const event = typeof req.query.event === 'string' ? req.query.event : undefined;
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;

  const result = await listEventLogs({ page, limit, category, event, userId });
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
 * GET /api/admin/feedbacks
 * 运营台工单列表（Spec P1）：状态/类型过滤 + 分页 + 状态角标计数。
 * 跨租户读——adminRouter 已在 requireAdmin 之后整台切 system 作用域（ADR-0019）。
 */
const AdminFeedbackListSchema = z.object({
  status: z.enum(['pending', 'processing', 'resolved', 'rejected']).optional(),
  type: z.enum(['suggestion', 'bug', 'ux', 'other']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get('/feedbacks', adminFeedbackReadRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  // 'all'（前端默认视图）归一为不过滤，沿用 orders 端点惯例
  const rawStatus = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
  const rawType = typeof req.query.type === 'string' && req.query.type !== 'all' ? req.query.type : undefined;

  const { status, type, page, limit } = validate(AdminFeedbackListSchema, {
    status: rawStatus,
    type: rawType,
    page: req.query.page,
    limit: req.query.limit,
  });

  const result = await listFeedbacksForAdmin({ status, type, page, limit });
  res.json({
    success: true,
    ...result,
    page: page ?? 1,
    limit: limit ?? 20,
  });
}));

/**
 * PUT /api/admin/feedbacks/:id
 * 工单状态流转 + 回复（Spec P1）。流转合法性与「已解决必须带回复」在 service 层校验；
 * 首次进入终态时落 resolved_by/resolved_at（此后修订回复不改）。
 */
const AdminFeedbackUpdateSchema = z.object({
  status: z.enum(['pending', 'processing', 'resolved', 'rejected']),
  admin_reply: z.string().max(2000).optional(),
});

const FeedbackIdParamSchema = z.object({
  // 先校验 uuid：否则畸形 id 会在 PG 触发 22P02，语义应是 400 而不是 500/404
  id: z.string().uuid('无效的工单 ID'),
});

adminRouter.put('/feedbacks/:id', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { id } = validate(FeedbackIdParamSchema, req.params);
  const { status, admin_reply } = validate(AdminFeedbackUpdateSchema, req.body);

  const updated = await updateFeedbackStatus({
    id,
    status,
    adminReply: admin_reply,
    adminUserId: req.user!.id,
  });

  res.json({ success: true, feedback: updated });
}));

/**
 * PUT /api/admin/users/:id/status
 * Freeze or unfreeze a user account. If frozen, kicks active sessions.
 */
const UserStatusSchema = z.object({
  is_active: z.boolean(),
});

/**
 * ⚠️ 运营台**写接口**统一挂 `adminUserWriteRateLimiter`（安全审查 L5）。
 * 此前只有日志读与解绑带限流器，写接口一个都没有——管理员会话被拿走或被前端循环误触发时
 * 没有任何刹车。按 admin 用户维度计数（30/min），不是按 IP。
 */
adminRouter.put('/users/:id/status', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
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
adminRouter.put('/users/:id/restore', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const restored = await restoreAccount(req.user!.id, req.params.id);
  res.json({
    success: true,
    message: '账号已恢复',
    user: restored,
  });
}));

/**
 * DELETE /api/admin/users/:id/oauth/:provider
 * ADR-0023：解除某用户的第三方登录绑定（当前仅 wechat）。误绑时的**唯一退路**——
 * 用户侧刻意不提供自助解绑，若运营台也没有，一个扫错的微信就成了永久登录凭据。
 * 未绑定该第三方 → 404。
 */
adminRouter.delete('/users/:id/oauth/:provider', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const result = await unbindOAuthIdentity({
    actorId: req.user!.id,
    targetUserId: req.params.id,
    provider: req.params.provider,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({
    success: true,
    message: '已解除该用户的第三方登录绑定',
    ...result,
  });
}));

/**
 * POST /api/admin/users/:id/vip
 * Grant or extend VIP membership days for a user
 */
const GrantVipSchema = z.object({
  days: z.number().int().min(0, '天数不能为负数'),
});

adminRouter.post('/users/:id/vip', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
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
 * PUT /api/admin/users/:id/email
 * Admin 修改用户邮箱：重置邮箱验证状态并发送验证邮件，写审计日志。
 */
const UserEmailSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
});

adminRouter.put('/users/:id/email', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { email } = validate(UserEmailSchema, req.body, 'INVALID_EMAIL');
  const targetUser = await getUserOrFail(req.params.id);

  const result = await adminUpdateUserEmail({
    targetUserId: targetUser.id,
    newEmail: email,
    actorId: req.user!.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  res.json({
    success: true,
    message: `已将用户 ${result.oldEmail} 的邮箱修改为 ${result.user.email}，验证邮件已发送至新邮箱`,
    user: result.user,
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
  gemini_model: z.string().optional(), // 必须由管理员显式选择保存，不注入默认值（模型唯一来源是后台配置）
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().min(100).max(32000).optional().default(4096),
  custom_system_prompt: z.string().optional().default(''),
  vip_only_models: z.array(z.string()).optional(),
  // 技术债 #0020：Gemini 容灾链表驱动（管理员改配置即时生效，无需重新部署）
  gemini_fallback_models: z.array(z.string()).optional(),
  force_web_search: z.boolean().optional(), // Spec I：强制联网开关（默认 true，存量配置由 DEFAULT 合并补全）
});

adminRouter.put('/model-config', adminUserWriteRateLimiter, asyncHandler(async (req: Request, res: Response) => {
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
adminRouter.post('/model-config/test', adminUserWriteRateLimiter, async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { provider, openai_base_url, openai_api_key, openai_model, gemini_model } = req.body;
    const currentConfig = await getAiModelConfig();

    if (provider === 'openai') {
      // ADR-0024：地址来自请求体，必须先过出站守卫（协议/私网/元数据/内嵌凭据）
      const baseUrl = (openai_base_url || currentConfig.openai_base_url || 'https://api.openai.com/v1')
        .replace(/\/+$/, '');
      assertSafeOutboundUrl(baseUrl, { purpose: '模型配置联调' });

      let apiKey = openai_api_key;
      if (!apiKey || apiKey.includes('••••')) {
        // ⚠️ 安全审查 H2：回落成**已保存的真实密钥**时，目标主机必须与已保存的一致。
        // 否则「填一个新地址 + 不填 Key」就是一条把平台密钥送到任意主机的通道——
        // 掩码回落是为了「不重填 Key 也能测同一台」，不是「测任意一台都不用给 Key」。
        const savedBaseUrl = (currentConfig.openai_base_url || '').replace(/\/+$/, '');
        if (baseUrl !== savedBaseUrl) {
          res.status(400).json({
            error: '更换服务地址时必须重新填写 API Key（不会把已保存的密钥发往新地址）',
            code: 'API_KEY_REQUIRED_FOR_NEW_HOST',
          });
          return;
        }
        apiKey = currentConfig.openai_api_key;
      }

      if (!apiKey) {
        res.status(400).json({ error: '请先填写 OpenAI 兼容 API Key', code: 'MISSING_API_KEY' });
        return;
      }

      const model = openai_model || currentConfig.openai_model;
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
            { role: 'user', content: 'Ping: Please reply with "Arborize OpenAI Integration OK!" in 10 words.' },
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
      const model = gemini_model || currentConfig.gemini_model;
      if (!model || !model.trim()) {
        res.status(400).json({ error: '请先选择要测试的 Gemini 模型并保存配置', code: 'MODEL_NOT_CONFIGURED' });
        return;
      }
      const result = await ai.models.generateContent({
        model,
        contents: 'Ping: Please reply with "Arborize Gemini Integration OK!" in 10 words.',
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
    // AppError（出站守卫的 400 OUTBOUND_URL_REJECTED、缺 Key 等）必须保留原始状态码与 code：
    // 否则「地址非法」会被这层兜底统一改写成 500，运营台只看到一句「测试连接超时或失败」，
    // 排障方向直接指反。与 chat 路由对 AppError 的处理同款。
    if (error instanceof AppError) {
      res.status(error.status).json({
        success: false,
        error: error.message,
        code: error.code,
        latencyMs,
      });
      return;
    }
    console.error('Admin test model connection error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || '测试连接超时或失败',
      latencyMs,
    });
  }
});
