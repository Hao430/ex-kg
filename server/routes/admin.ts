import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAdminOverview,
  listAdminUsers,
  updateUserStatus,
  adjustUserCredits,
  grantUserVipDays,
  listAdminTransactions,
  findUserById,
  getAiModelConfig,
  saveAiModelConfig,
  AiModelConfig,
} from '../db.js';
import { authMiddleware, requireAdmin } from '../middlewares.js';
import { GoogleGenAI } from '@google/genai';

export const adminRouter = Router();

// Apply auth and admin check to all admin routes
adminRouter.use(authMiddleware);
adminRouter.use(requireAdmin);

/**
 * GET /api/admin/overview
 * Operation dashboard metrics (total users, tokens, canvases, models)
 */
adminRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const overview = await getAdminOverview();
    res.json({ success: true, overview });
  } catch (error: any) {
    console.error('Admin overview error:', error);
    res.status(500).json({ error: error?.message || '获取看板数据失败' });
  }
});

/**
 * GET /api/admin/users
 * Paginated user query with filters
 */
adminRouter.get('/users', async (req: Request, res: Response) => {
  try {
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
  } catch (error: any) {
    console.error('Admin list users error:', error);
    res.status(500).json({ error: error?.message || '获取用户列表失败' });
  }
});

/**
 * PUT /api/admin/users/:id/status
 * Freeze or unfreeze a user account. If frozen, kicks active sessions.
 */
const UserStatusSchema = z.object({
  is_active: z.boolean(),
});

adminRouter.put('/users/:id/status', async (req: Request, res: Response) => {
  try {
    const parseResult = UserStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: '无效的状态参数', code: 'INVALID_STATUS' });
      return;
    }

    const { id } = req.params;
    const targetUser = await findUserById(id);
    if (!targetUser) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    // Protect super admin from self-freezing
    if (targetUser.id === req.user!.id && !parseResult.data.is_active) {
      res.status(400).json({ error: '不能冻结当前登录的管理员自身账号' });
      return;
    }

    const updated = await updateUserStatus(id, parseResult.data.is_active);
    res.json({
      success: true,
      message: parseResult.data.is_active ? '账号已成功解封' : '账号已被冻结并强制踢下线',
      user: updated,
    });
  } catch (error: any) {
    console.error('Admin update status error:', error);
    res.status(500).json({ error: error?.message || '更改用户状态失败' });
  }
});

/**
 * POST /api/admin/users/:id/credits
 * Manual credit adjustment with audit trail
 */
const AdjustCreditsSchema = z.object({
  amount: z.number().int().refine((val) => val !== 0, '调账点数不能为 0'),
  reason: z.string().min(2, '请填写调账原因（至少 2 个字）'),
});

adminRouter.post('/users/:id/credits', async (req: Request, res: Response) => {
  try {
    const parseResult = AdjustCreditsSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || '调账参数无效',
        code: 'INVALID_ADJUSTMENT',
      });
      return;
    }

    const { id } = req.params;
    const targetUser = await findUserById(id);
    if (!targetUser) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const { amount, reason } = parseResult.data;
    const operator = req.user!;

    const { newBalance, transactionId } = await adjustUserCredits({
      userId: id,
      amount,
      operatorId: operator.id,
      reason: `[管理员 ${operator.email}] ${reason}`,
    });

    res.json({
      success: true,
      message: `已成功${amount > 0 ? '增加' : '扣除'} ${Math.abs(amount)} 点数，用户当前余额为 ${newBalance} 点`,
      new_balance: newBalance,
      transaction_id: transactionId,
    });
  } catch (error: any) {
    console.error('Admin adjust credits error:', error);
    res.status(500).json({ error: error?.message || '调账失败' });
  }
});

/**
 * POST /api/admin/users/:id/vip
 * Grant or extend VIP membership days for a user
 */
const GrantVipSchema = z.object({
  days: z.number().int().min(0, '天数不能为负数'),
});

adminRouter.post('/users/:id/vip', async (req: Request, res: Response) => {
  try {
    const parseResult = GrantVipSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || 'VIP 天数参数无效',
        code: 'INVALID_VIP_DAYS',
      });
      return;
    }

    const { id } = req.params;
    const targetUser = await findUserById(id);
    if (!targetUser) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const { days } = parseResult.data;
    const result = await grantUserVipDays({ userId: id, days });

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
  } catch (error: any) {
    console.error('Admin grant VIP error:', error);
    res.status(500).json({ error: error?.message || '设置 VIP 会员天数失败' });
  }
});

/**
 * GET /api/admin/transactions
 * Global credit transaction ledger
 */
adminRouter.get('/transactions', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const actionType = typeof req.query.actionType === 'string' ? req.query.actionType : undefined;

    const result = await listAdminTransactions({ page, limit, userId, actionType });
    res.json({
      success: true,
      ...result,
      page,
      limit,
    });
  } catch (error: any) {
    console.error('Admin list transactions error:', error);
    res.status(500).json({ error: error?.message || '获取流水失败' });
  }
});

/**
 * GET /api/admin/model-config
 * Retrieve current active AI Model & Provider settings (masking secrets)
 */
adminRouter.get('/model-config', async (_req: Request, res: Response) => {
  try {
    const config = await getAiModelConfig();
    const hasKey = Boolean(config.openai_api_key && config.openai_api_key.trim().length > 0);
    const maskedKey = hasKey
      ? config.openai_api_key.length > 8
        ? `${config.openai_api_key.slice(0, 3)}••••••••${config.openai_api_key.slice(-4)}`
        : '••••••••'
      : '';

    res.json({
      success: true,
      config: {
        ...config,
        openai_api_key: maskedKey,
        has_openai_key: hasKey,
      },
    });
  } catch (error: any) {
    console.error('Admin get model-config error:', error);
    res.status(500).json({ error: error?.message || '获取模型配置失败' });
  }
});

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
});

adminRouter.put('/model-config', async (req: Request, res: Response) => {
  try {
    const parseResult = ModelConfigSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: parseResult.error.issues[0]?.message || '配置参数无效',
        code: 'INVALID_CONFIG',
      });
      return;
    }

    const currentConfig = await getAiModelConfig();
    let newApiKey = parseResult.data.openai_api_key;

    // If key contains mask bullets or is empty and previous key exists, keep current key
    if (!newApiKey || newApiKey.includes('••••') || newApiKey.trim() === '') {
      newApiKey = currentConfig.openai_api_key || '';
    }

    const saved = await saveAiModelConfig(
      {
        ...parseResult.data,
        openai_api_key: newApiKey,
      },
      req.user?.email
    );

    res.json({
      success: true,
      message: '模型与接口配置已成功保存并立即生效',
      config: {
        ...saved,
        openai_api_key: saved.openai_api_key ? '••••••••' : '',
        has_openai_key: Boolean(saved.openai_api_key),
      },
    });
  } catch (error: any) {
    console.error('Admin save model-config error:', error);
    res.status(500).json({ error: error?.message || '保存模型配置失败' });
  }
});

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

