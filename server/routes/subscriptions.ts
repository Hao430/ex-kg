import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, subscriptionRateLimiter } from '../middleware/auth.js';
import { asyncHandler } from '../lib/async-handler.js';
import { validate } from '../lib/validate.js';
import { startSubscription, mockPayOrder, getOrderStatus, handleAlipayNotify, isPaymentEnabled } from '../services/billing.service.js';
import { runWithSystem } from '../core/db-context.js';

export const subscriptionsRouter = Router();

// 订阅端点限流（技术债 #0012，ADR-0007 独立实例）：IP 维度 10/min，防刷"尝试下单"
// 注意：限流器逐端点挂载——/notify 例外（见其端点注释）。

const OrderPlanSchema = z.object({
  // yearly（¥199）已下架（2026-09-10）：支付宝渠道单笔限额 ¥50
  plan: z.enum(['weekly', 'monthly']),
});

/**
 * POST /api/subscriptions/orders
 * Create a pending order and return the payment URL（支付宝收银台，ADR-0014；
 * 未配置 ALIPAY 三要素时回落 mock 渠道供开发/测试使用）
 * PAYMENT_ENABLED 默认禁用（503 PAYMENT_DISABLED）。
 */
subscriptionsRouter.post('/orders', subscriptionRateLimiter, authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  if (!isPaymentEnabled()) {
    res.status(503).json({ error: '在线支付暂未开放，请稍后再试', code: 'PAYMENT_DISABLED' });
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
subscriptionsRouter.post('/orders/:orderNo/mock-pay', subscriptionRateLimiter, authMiddleware, asyncHandler(async (req: Request, res: Response) => {
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
 * Query order status (owner only)。alipay 渠道下 pending 单会先做一次查单对账兜底
 * （billing.service.getOrderStatus 内部节流）。
 */
subscriptionsRouter.get('/orders/:orderNo', subscriptionRateLimiter, authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const order = await getOrderStatus(req.user!.id, req.params.orderNo);
  res.json({ status: order.status, order });
}));

/**
 * POST /api/subscriptions/notify（ADR-0014）
 * 支付宝异步通知回调：调用方是支付宝服务器（form-urlencoded），仅此端点
 * **不挂 authMiddleware 与 subscriptionRateLimiter**——验签即鉴权，限流会让
 * 通知重试风暴雪上加霜；豁免理由同步记录于 arch-tests 判据说明与 ADR-0014。
 *
 * 处理成功必须返回纯文本 'success'（支付宝据此停止重试），否则返回 'fail'。
 */
subscriptionsRouter.post('/notify', asyncHandler(async (req: Request, res: Response) => {
  // 回调方是支付宝服务器：按 out_trade_no 跨租户定位订单（验签即鉴权）
  const result = await runWithSystem('subscriptions: 支付宝回调按订单号跨租户结算（ADR-0014）', () =>
    handleAlipayNotify((req.body as Record<string, unknown>) || {})
  );
  res.type('text/plain').send(result);
}));
