import { getDb } from '../core/db.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { OrderRecord } from '../core/records.js';
import { handlePgError } from '../core/db-guard.js';

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
  const db = getDb();
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

  if (db) {
    try {
      // paid_at 仅在 paid 状态落库（此前 hardcode NOW() 会让 pending 单被盖上支付时间，
      // 破坏支付宝 notify 幂等核对与对账口径）
      const res = await db.query(
        `INSERT INTO orders (order_no, user_id, plan_id, plan_name, amount_cents, currency, status, duration_days, payment_method, created_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, 'CNY', $6, $7, $8, NOW(), CASE WHEN $9 = 'paid' THEN NOW() ELSE NULL END)
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
          status,
        ]
      );
      if (res.rows.length > 0) {
        orderRecord.id = res.rows[0].id;
        orderRecord.created_at = res.rows[0].created_at;
        orderRecord.paid_at = res.rows[0].paid_at;
      }
      return orderRecord;
    } catch (e) {
      handlePgError(e);
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
  const db = getDb();
  if (db) {
    try {
      const res = await db.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      return res.rows.map(mapRowToOrder);
    } catch (e) {
      handlePgError(e);
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
  const db = getDb();
  if (db) {
    try {
      const where = params.status ? 'WHERE o.status = $1' : '';
      const values = params.status ? [params.status] : [];
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS count FROM orders o ${where}`,
        values
      );
      const dataRes = await db.query(
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
      handlePgError(e);
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
  const db = getDb();
  if (db) {
    try {
      const res = await db.query('SELECT * FROM orders WHERE order_no = $1', [orderNo]);
      if (res.rows.length > 0) return mapRowToOrder(res.rows[0]);
    } catch (e) {
      handlePgError(e);
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
  const db = getDb();
  if (db) {
    try {
      const res = await db.query(
        `UPDATE orders
         SET status = $1,
             paid_at = CASE WHEN $3 = 'paid' THEN NOW() ELSE paid_at END
         WHERE order_no = $2 ${expectedStatus ? 'AND status = $4' : ''}
         RETURNING *`,
        expectedStatus ? [status, orderNo, status, expectedStatus] : [status, orderNo, status]
      );
      if (res.rows.length > 0) return mapRowToOrder(res.rows[0]);
      return null;
    } catch (e) {
      handlePgError(e);
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

/**
 * 结算到账（原子）：把「pending → paid」与「VIP 叠期」放进**同一个事务**提交。
 *
 * 为什么必须是一个事务：拆成两段时，第二段失败（生产下 `handlePgError` 对任何 PG 错误抛
 * 503，一次瞬时抖动就够）会留下「订单已 paid、VIP 没叠期」。而这条状态**永久不自愈**——
 * 支付宝重试走到「订单已是 paid」分支直接应答 success 停止重发，查单兜底又因
 * `status !== 'pending'` 提前返回，`settleOrderPaid` 的幂等分支同样只认 paid：
 * 三处都进不去，钱收了货不发。包进事务后失败即整体回滚，订单退回 pending，
 * 支付宝重试即可正常结算。
 *
 * VIP 叠期用**单条 UPDATE** 完成读-改-写（基准 `GREATEST(当前到期, NOW())`、admin 不降级）：
 * 原实现是先 `findUserById` 读、再 `updateVipMembership` 写，同一用户两个订单并发结算
 * （多标签页各买一单）会双双读到同一个旧到期时间，后写覆盖先写——有一单的天数凭空消失。
 *
 * 返回语义（与 updateOrderStatus 的幂等分支对齐）：结算成功返回订单；订单已是 paid
 * （notify 与查单并发到达）返回现状不重复叠期；不存在或 failed/refunded 返回 null。
 */
export async function settlePaidOrder(orderNo: string): Promise<OrderRecord | null> {
  const db = getDb();
  if (db) {
    try {
      return await db.withTransaction(async (client) => {
        const res = await client.query(
          `UPDATE orders
           SET status = 'paid',
               paid_at = CASE WHEN paid_at IS NULL THEN NOW() ELSE paid_at END
           WHERE order_no = $1 AND status = 'pending'
           RETURNING *`,
          [orderNo]
        );

        if (res.rows.length > 0) {
          const order = mapRowToOrder(res.rows[0]);
          // 同一事务内叠期：失败即整体回滚，绝不留下「已 paid 未开通」
          await client.query(
            `UPDATE users
             SET role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'vip' END,
                 vip_expires_at = GREATEST(COALESCE(vip_expires_at, NOW()), NOW()) + make_interval(days => $2::int),
                 updated_at = NOW()
             WHERE id = $1`,
            [order.user_id, order.duration_days]
          );
          return order;
        }

        // 条件更新未命中：已是 paid（幂等命中）返回现状；failed/refunded/不存在返回 null
        const cur = await client.query('SELECT * FROM orders WHERE order_no = $1', [orderNo]);
        return cur.rows.length > 0 && cur.rows[0].status === 'paid'
          ? mapRowToOrder(cur.rows[0])
          : null;
      });
    } catch (e) {
      handlePgError(e);
      console.warn('PG settlePaidOrder failed, falling back to memory:', e);
    }
  }

  // 内存分支：语义与上面的 SQL 逐条对齐（无 pool 时才走到这里）
  const order = inMemoryStore.orders.find((o) => o.order_no === orderNo);
  if (!order) return null;
  if (order.status === 'paid') return order;
  if (order.status !== 'pending') return null;

  order.status = 'paid';
  order.paid_at = order.paid_at || new Date().toISOString();

  const user = inMemoryStore.users.get(order.user_id);
  if (user) {
    const now = Date.now();
    const current = user.vip_expires_at ? new Date(user.vip_expires_at).getTime() : 0;
    const base = current > now ? current : now; // = GREATEST(当前到期, NOW())
    user.vip_expires_at = new Date(base + order.duration_days * 24 * 3600 * 1000).toISOString();
    if (user.role !== 'admin') user.role = 'vip';
    user.updated_at = new Date().toISOString();
  }
  return order;
}
