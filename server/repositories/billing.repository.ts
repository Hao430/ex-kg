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

function mapRowToOrder(r: any): OrderRecord {
  return {
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
    user_email: r.user_email || undefined,
  };
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
      return res.rows.map(mapRowToOrder);
    } catch (e) {
      console.warn('PG listUserOrders failed, using memory:', e);
    }
  }

  return inMemoryStore.orders.filter((o) => o.user_id === userId);
}

/**
 * List all orders (admin, Spec E3): paginated, optional status filter, user_email joined
 */
export async function listAllOrders(params: {
  page?: number;
  limit?: number;
  status?: string;
}): Promise<{ orders: OrderRecord[]; total: number }> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 10)));
  const offset = (page - 1) * limit;
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const where = params.status ? 'WHERE o.status = $1' : '';
      const values = params.status ? [params.status] : [];
      const countRes = await p.query(
        `SELECT COUNT(*)::int AS count FROM orders o ${where}`,
        values
      );
      const dataRes = await p.query(
        `SELECT o.*, u.email AS user_email
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         ${where}
         ORDER BY o.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
      );
      return {
        orders: dataRes.rows.map(mapRowToOrder),
        total: countRes.rows[0]?.count ?? 0,
      };
    } catch (e) {
      console.warn('PG listAllOrders failed, using memory:', e);
    }
  }

  const filtered = params.status
    ? inMemoryStore.orders.filter((o) => o.status === params.status)
    : inMemoryStore.orders;
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const orders = sorted.slice(offset, offset + limit).map((o) => ({
    ...o,
    user_email: inMemoryStore.users.get(o.user_id)?.email,
  }));
  return { orders, total: filtered.length };
}

/**
 * Find an order by its order number
 */
export async function findOrderByNo(orderNo: string): Promise<OrderRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query('SELECT * FROM orders WHERE order_no = $1', [orderNo]);
      if (res.rows.length > 0) return mapRowToOrder(res.rows[0]);
    } catch (e) {
      console.warn('PG findOrderByNo failed, using memory:', e);
    }
  }

  return inMemoryStore.orders.find((o) => o.order_no === orderNo) || null;
}

/**
 * Update an order's status; stamps paid_at when transitioning to paid
 */
export async function updateOrderStatus(
  orderNo: string,
  status: OrderRecord['status'],
  expectedStatus?: OrderRecord['status']
): Promise<OrderRecord | null> {
  const p = getPool();
  if (p) {
    try {
      await initDbSchema();
      const res = await p.query(
        `UPDATE orders
         SET status = $1,
             paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE paid_at END
         WHERE order_no = $2 ${expectedStatus ? 'AND status = $3' : ''}
         RETURNING *`,
        expectedStatus ? [status, orderNo, expectedStatus] : [status, orderNo]
      );
      if (res.rows.length > 0) return mapRowToOrder(res.rows[0]);
      return null;
    } catch (e) {
      console.warn('PG updateOrderStatus failed, updating memory:', e);
    }
  }

  const order = inMemoryStore.orders.find((o) => o.order_no === orderNo);
  if (!order) return null;
  if (expectedStatus && order.status !== expectedStatus) return null; // 条件更新：状态不符返回 null（防并发双激活）
  order.status = status;
  if (status === 'paid') order.paid_at = new Date().toISOString();
  return order;
}
