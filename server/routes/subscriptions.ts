import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { startSubscription, mockPayOrder, getOrderStatus, isPaymentEnabled } from '../services/billing.service.js';

export const subscriptionsRouter = Router();

const OrderPlanSchema = z.object({
  plan: z.enum(['weekly', 'monthly', 'yearly']),
});

/**
 * POST /api/subscriptions/orders
 * Create a pending order and return the (mock) payment URL
 * 一期未接真实支付，PAYMENT_ENABLED 默认禁用（503），过渡走微信人工充值。
 */
subscriptionsRouter.post('/orders', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  if (!isPaymentEnabled()) {
    res.status(503).json({ error: '在线支付暂未开放，请通过客服微信人工充值开通会员', code: 'PAYMENT_DISABLED' });
    return;
  }
  const { plan } = validate(OrderPlanSchema, req.body, 'INVALID_PLAN');
  const result = await startSubscription(req.user!.id, plan);
  res.status(201).json(result);
}));

/**
 * POST /api/subscriptions/orders/:orderNo/mock-pay
 * Simulate a successful payment callback (non-production only)
 */
subscriptionsRouter.post('/orders/:orderNo/mock-pay', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  if (!isPaymentEnabled()) {
    res.status(503).json({ error: '在线支付暂未开放', code: 'PAYMENT_DISABLED' });
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  const result = await mockPayOrder(req.user!.id, req.params.orderNo);

  res.json({
    success: true,
    message: '模拟支付成功，VIP 已生效',
    order: result.order,
    role: result.role,
    vip_expires_at: result.vip_expires_at,
  });
}));

/**
 * GET /api/subscriptions/orders/:orderNo
 * Query order status (owner only)
 */
subscriptionsRouter.get('/orders/:orderNo', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const order = await getOrderStatus(req.user!.id, req.params.orderNo);
  res.json({ status: order.status, order });
}));
