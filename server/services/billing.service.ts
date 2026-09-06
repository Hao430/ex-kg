import { findUserById, updateVipMembership } from '../repositories/user.repository.js';
import {
  createOrder,
} from '../repositories/billing.repository.js';
import { NotFoundError } from '../lib/errors.js';
import type { UserRecord } from '../core/records.js';

/**
 * Subscribe user to a time-based membership plan (weekly, monthly, yearly)
 */
export async function subscribeUserPlan(data: {
  userId: string;
  plan: 'weekly' | 'monthly' | 'yearly';
}): Promise<{ role: 'vip'; vip_expires_at: string; user: UserRecord }> {
  const planInfoMap = {
    weekly: { days: 7, name: '周度 Pro 会员', amountCents: 990 },
    monthly: { days: 30, name: '月度 Pro 会员', amountCents: 2490 },
    yearly: { days: 365, name: '年度 Pro 会员', amountCents: 19900 },
  };
  const planInfo = planInfoMap[data.plan] || planInfoMap.monthly;
  const addDays = planInfo.days;

  let baseTime = Date.now();
  const currentUser = await findUserById(data.userId);
  if (currentUser?.vip_expires_at && new Date(currentUser.vip_expires_at).getTime() > baseTime) {
    baseTime = new Date(currentUser.vip_expires_at).getTime();
  }

  const newExpiresAt = new Date(baseTime + addDays * 24 * 3600 * 1000).toISOString();

  // Create order log
  await createOrder({
    userId: data.userId,
    planId: data.plan,
    planName: planInfo.name,
    amountCents: planInfo.amountCents,
    durationDays: addDays,
    paymentMethod: 'online_pay',
    status: 'paid',
  });

  // admin 不降级
  const newRole = currentUser?.role === 'admin' ? 'admin' : 'vip';
  const updated = await updateVipMembership({
    userId: data.userId,
    role: newRole,
    vipExpiresAt: newExpiresAt,
  });
  if (!updated) {
    throw new NotFoundError('用户不存在');
  }

  return { role: 'vip', vip_expires_at: newExpiresAt, user: updated };
}
