import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { OrderRecord } from '../core/records.js';

/**
 * Create an order for recharge or VIP subscription
 */
export async function createOrder(data: {
  userId: string;
  planId: string;
  planName: string;
  amountCents: number;
  durationDays: number;
  paymentMethod?: string;
  status?: 'pending' | 'paid' | 'failed' | 'refunded';
}): Promise<OrderRecord> {
  const p = getPool();
  const orderNo = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const now = new Date().toISOString();
  const status = data.status || 'paid';
  const paymentMethod = data.paymentMethod || 'online_pay';

  const orderRecord: OrderRecord = {
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    order_no: orderNo,
    user_id: data.userId,
    plan_id: data.planId,
    plan_name: data.planName,
    amount_cents: data.amountCents,
    currency: 'CNY',
    status,
    duration_days: data.durationDays,
    payment_method: paymentMethod,
    created_at: now,
    paid_at: status === 'paid' ? now : null,
  };

  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `INSERT INTO orders (order_no, user_id, plan_id, plan_name, amount_cents, currency, status, duration_days, payment_method, created_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, 'CNY', $6, $7, $8, NOW(), NOW())
         RETURNING *`,
        [
          orderNo,
          data.userId,
          data.planId,
          data.planName,
          data.amountCents,
          status,
          data.durationDays,
          paymentMethod,
        ]
      );
      if (res.rows.length > 0) {
        orderRecord.id = res.rows[0].id;
        orderRecord.created_at = res.rows[0].created_at;
        orderRecord.paid_at = res.rows[0].paid_at;
      }
      return orderRecord;
    } catch (e) {
      console.warn('PG createOrder failed, fallback to memory:', e);
    }
  }

  // 内存兜底（无 pool 或 PG 失败时才写内存，PG 成功不双写）
  inMemoryStore.orders.unshift(orderRecord);
  return orderRecord;
}

/**
 * List orders for a user
 */
export async function listUserOrders(userId: string): Promise<OrderRecord[]> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      return res.rows.map((r) => ({
        id: r.id,
        order_no: r.order_no,
        user_id: r.user_id,
        plan_id: r.plan_id,
        plan_name: r.plan_name,
        amount_cents: r.amount_cents,
        currency: r.currency,
        status: r.status,
        duration_days: r.duration_days,
        payment_method: r.payment_method,
        created_at: r.created_at,
        paid_at: r.paid_at,
      }));
    } catch (e) {
      console.warn('PG listUserOrders failed, using memory:', e);
    }
  }

  return inMemoryStore.orders.filter((o) => o.user_id === userId);
}
