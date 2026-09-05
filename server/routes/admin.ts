import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAdminOverview,
  listAdminUsers,
  updateUserStatus,
  adjustUserCredits,
  listAdminTransactions,
  findUserById,
} from '../db.js';
import { authMiddleware, requireAdmin } from '../middlewares.js';

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
