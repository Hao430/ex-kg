import { findUserById, updateVipMembership } from '../repositories/user.repository.js';
import {
  createOrder,
  findOrderByNo,
  updateOrderStatus,
} from '../repositories/billing.repository.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { mockProvider } from './payment/mock-provider.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import type { OrderRecord, UserRecord } from '../core/records.js';

const planInfoMap = {
  weekly: { days: 7, name: '周度 Pro 会员', amountCents: 990 },
  monthly: { days: 30, name: '月度 Pro 会员', amountCents: 2490 },
  yearly: { days: 365, name: '年度 Pro 会员', amountCents: 19900 },
};

export type SubscriptionPlan = keyof typeof planInfoMap;

/**
 * Activate a paid order: extend VIP membership by order.durationDays
 * (base time = now, or existing expiry for renewal stacking; admin is never downgraded)
 */
export async function activateOrder(order: OrderRecord): Promise<{ role: 'vip'; vip_expires_at: string; user: UserRecord }> {
  const addDays = order.duration_days;

  let baseTime = Date.now();
  const currentUser = await findUserById(order.user_id);
  if (currentUser?.vip_expires_at && new Date(currentUser.vip_expires_at).getTime() > baseTime) {
    baseTime = new Date(currentUser.vip_expires_at).getTime();
  }

  const newExpiresAt = new Date(baseTime + addDays * 24 * 3600 * 1000).toISOString();

  // admin 不降级
  const newRole = currentUser?.role === 'admin' ? 'admin' : 'vip';
  const updated = await updateVipMembership({
    userId: order.user_id,
    role: newRole,
    vipExpiresAt: newExpiresAt,
  });
  if (!updated) {
    throw new NotFoundError('用户不存在');
  }

  await recordAuditLog({
    userId: order.user_id,
    action: 'subscribe',
    targetType: 'order',
    targetId: order.order_no,
    details: { planId: order.plan_id, orderNo: order.order_no },
  });

  return { role: 'vip', vip_expires_at: newExpiresAt, user: updated };
}

/**
 * Subscribe user to a time-based membership plan (weekly, monthly, yearly)
 * — one-step activation, kept for backward compatibility.
 */
export async function subscribeUserPlan(data: {
  userId: string;
  plan: 'weekly' | 'monthly' | 'yearly';
}): Promise<{ role: 'vip'; vip_expires_at: string; user: UserRecord }> {
  const planInfo = planInfoMap[data.plan] || planInfoMap.monthly;

  // Create order log (already paid in one-step flow)
  const created = await createOrder({
    userId: data.userId,
    planId: data.plan,
    planName: planInfo.name,
    amountCents: planInfo.amountCents,
    durationDays: planInfo.days,
    paymentMethod: 'online_pay',
    status: 'paid',
  });

  return activateOrder(created);
}

/**
 * Start a subscription: create a pending order and get a (mock) payment URL
 */
export async function startSubscription(userId: string, plan: 'weekly' | 'monthly' | 'yearly'): Promise<{
  orderNo: string;
  payUrl: string;
  amountCents: number;
}> {
  const planInfo = planInfoMap[plan] || planInfoMap.monthly;

  const order = await createOrder({
    userId,
    planId: plan,
    planName: planInfo.name,
    amountCents: planInfo.amountCents,
    durationDays: planInfo.days,
    paymentMethod: 'online_pay',
    status: 'pending',
  });

  const { payUrl } = await mockProvider.createPayment(order);

  return { orderNo: order.order_no, payUrl, amountCents: order.amount_cents };
}

/**
 * Simulate a successful payment callback for an order (mock/non-production only)
 */
export async function mockPayOrder(userId: string, orderNo: string): Promise<{
  order: OrderRecord;
  role: 'vip';
  vip_expires_at: string;
  user: UserRecord;
}> {
  const order = await findOrderByNo(orderNo);
  if (!order) {
    throw new NotFoundError('订单不存在');
  }
  if (order.user_id !== userId) {
    throw new ForbiddenError('无权操作此订单');
  }
  if (order.status !== 'pending') {
    throw new ConflictError('订单已支付或已关闭', 'ORDER_ALREADY_PAID');
  }

  await mockProvider.handleCallback({ orderNo, success: true });

  // 条件更新防并发双激活：仅 pending → paid，竞态失败方抛 409
  const updated = await updateOrderStatus(orderNo, 'paid', 'pending');
  if (!updated) throw new ConflictError('订单已支付或已关闭', 'ORDER_ALREADY_PAID');
  if (!updated) {
    throw new NotFoundError('订单不存在');
  }

  const activateResult = await activateOrder(updated);

  return { order: updated, ...activateResult };
}

/**
 * Get the current order record for the owning user
 */
export async function getOrderStatus(userId: string, orderNo: string): Promise<OrderRecord> {
  const order = await findOrderByNo(orderNo);
  if (!order) {
    throw new NotFoundError('订单不存在');
  }
  if (order.user_id !== userId) {
    throw new ForbiddenError('无权操作此订单');
  }
  return order;
}
