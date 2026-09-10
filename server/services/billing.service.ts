import { findUserById, updateVipMembership } from '../repositories/user.repository.js';
import {
  createOrder,
  findOrderByNo,
  updateOrderStatus,
} from '../repositories/billing.repository.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { mockProvider } from './payment/mock-provider.js';
import { getAlipayProvider, isAlipayConfigured } from './payment/alipay-provider.js';
import type { PaymentProvider } from './payment/payment-provider.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import type { OrderRecord, UserRecord } from '../core/records.js';

const planInfoMap = {
  weekly: { days: 7, name: '周度 Pro 会员', amountCents: 990 },
  monthly: { days: 30, name: '月度 Pro 会员', amountCents: 2490 },
  // yearly（¥199）已下架（2026-09-10）：支付宝渠道单笔限额 ¥50
};

export type SubscriptionPlan = keyof typeof planInfoMap;

/**
 * 一期未接真实支付，在线充值接口默认禁用（PAYMENT_ENABLED=true 才开放）。
 * 二期（ADR-0014）：支付宝 alipay.trade.page.pay；未配置 ALIPAY 三要素时回落 mock 渠道
 * （开发/测试环境模拟支付全链路，保 e1-payment.test.ts 回归）。
 */
export function isPaymentEnabled(): boolean {
  return process.env.PAYMENT_ENABLED === 'true';
}

/** 支付渠道选择：支付宝配置齐备 → alipay，否则 mock（PAYMENT_ENABLED 仍是业务总开关） */
export function getPaymentProvider(): PaymentProvider {
  if (isAlipayConfigured()) return getAlipayProvider();
  return mockProvider;
}

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
 * Subscribe user to a time-based membership plan (weekly, monthly)
 * — one-step activation, kept for backward compatibility.
 */
export async function subscribeUserPlan(data: {
  userId: string;
  plan: 'weekly' | 'monthly';
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
export async function startSubscription(userId: string, plan: 'weekly' | 'monthly'): Promise<{
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

  const { payUrl } = await getPaymentProvider().createPayment(order);

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
 * 支付到账结算（支付宝 notify 与查单兜底共用，ADR-0014）：
 * 条件更新 pending → paid 防并发双激活，成功后叠期激活 VIP。
 * 幂等语义：订单已是 paid（如 notify 与查单并发到达）返回现有订单，不重复叠期；
 * 订单不存在或非 paid/pending（failed/refunded）返回 null 由调用方决定应答。
 */
export async function settleOrderPaid(orderNo: string): Promise<OrderRecord | null> {
  const updated = await updateOrderStatus(orderNo, 'paid', 'pending');
  if (updated) {
    await activateOrder(updated);
    return updated;
  }
  const existing = await findOrderByNo(orderNo);
  return existing?.status === 'paid' ? existing : null;
}

/**
 * 处理支付宝异步通知（POST /api/subscriptions/notify，ADR-0014）。
 * 验签即鉴权：验签失败/参数校验失败一律 'fail'（支付宝按重试策略重发）；
 * 到账判定三重校验：签名 → app_id 归属 → 金额与订单精确一致（字符串比对防精度/篡改）。
 * 响应规范：处理成功（含重复通知的幂等命中）返回 'success' 纯文本。
 */
export async function handleAlipayNotify(form: Record<string, unknown>): Promise<'success' | 'fail'> {
  const provider = getPaymentProvider();
  if (provider.name !== 'alipay') {
    console.warn('alipay notify received but alipay provider not configured');
    return 'fail';
  }
  const alipay = getAlipayProvider();
  if (!alipay.verifyNotifySignature(form)) {
    console.warn('alipay notify signature verification failed');
    return 'fail';
  }

  const outTradeNo = String(form.out_trade_no || '');
  const order = await findOrderByNo(outTradeNo);
  if (!order) {
    console.warn(`alipay notify for unknown order: ${outTradeNo}`);
    return 'fail';
  }
  if (String(form.app_id || '') !== alipay.appId) {
    console.warn(`alipay notify app_id mismatch: ${form.app_id}`);
    return 'fail';
  }
  if (String(form.total_amount || '') !== (order.amount_cents / 100).toFixed(2)) {
    console.warn(`alipay notify amount mismatch for order ${outTradeNo}: ${form.total_amount}`);
    return 'fail';
  }

  const tradeStatus = String(form.trade_status || '');
  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    // 非成功态（TRADE_CLOSED 等）：确认收到即可，不激活、不置失败（查单兜底负责终态同步）
    return 'success';
  }

  const settled = await settleOrderPaid(outTradeNo);
  if (!settled) {
    console.warn(`alipay notify could not settle order ${outTradeNo}`);
    return 'fail';
  }

  await recordAuditLog({
    userId: settled.user_id,
    action: 'subscribe',
    targetType: 'order',
    targetId: outTradeNo,
    details: { planId: settled.plan_id, source: 'alipay_notify' },
  });
  return 'success';
}

/** 查单兜底节流：同一订单两次真实查单最小间隔（防前端轮询打爆网关） */
const QUERY_THROTTLE_MS = 5000;
const lastQueryAt = new Map<string, number>();

/**
 * pending 单对账兜底（notify 可能丢失）：alipay 渠道下查官方订单状态并同步本地，
 * paid → settleOrderPaid（幂等）、failed → 置 failed；网络异常静默降级（notify 为主路径）。
 */
async function syncPendingOrderWithProvider(order: OrderRecord): Promise<void> {
  if (order.status !== 'pending') return;
  const provider = getPaymentProvider();
  if (provider.name !== 'alipay') return;

  const now = Date.now();
  const last = lastQueryAt.get(order.order_no) ?? 0;
  if (now - last < QUERY_THROTTLE_MS) return;
  lastQueryAt.set(order.order_no, now);

  try {
    const { status } = await getAlipayProvider().queryPayment(order.order_no);
    if (status === 'paid') {
      const settled = await settleOrderPaid(order.order_no);
      if (settled) {
        await recordAuditLog({
          userId: settled.user_id,
          action: 'subscribe',
          targetType: 'order',
          targetId: order.order_no,
          details: { planId: settled.plan_id, source: 'query_sync' },
        });
      }
    } else if (status === 'failed') {
      await updateOrderStatus(order.order_no, 'failed', 'pending');
    }
  } catch (e) {
    console.warn(`order query sync failed for ${order.order_no}:`, e);
  }
}

/**
 * Get the current order record for the owning user
 * （pending 单先做一次查单兜底，返回最新状态）
 */
export async function getOrderStatus(userId: string, orderNo: string): Promise<OrderRecord> {
  const order = await findOrderByNo(orderNo);
  if (!order) {
    throw new NotFoundError('订单不存在');
  }
  if (order.user_id !== userId) {
    throw new ForbiddenError('无权操作此订单');
  }
  await syncPendingOrderWithProvider(order);
  return (await findOrderByNo(orderNo)) ?? order;
}
