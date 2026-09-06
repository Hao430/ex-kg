import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { initDbSchema } from '../core/schema.js';
import { inMemoryStore } from '../core/memory-store.js';
import { BillingError, NotFoundError } from '../lib/errors.js';
import type { CreditTransactionRecord, OrderRecord } from '../core/records.js';

export async function deductCredits(data: {
  userId: string;
  canvasId?: string | null;
  modelName: string;
  tokensConsumed: number;
  actionType?: string;
}): Promise<{ newBalance: number; transactionId: string }> {
  const p = getPool();
  const txId = crypto.randomUUID();

  if (p) {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      // Atomic update with check
      const uRes = await client.query(
        `UPDATE users
         SET credits_balance = GREATEST(0, credits_balance - $1), updated_at = NOW()
         WHERE id = $2
         RETURNING credits_balance`,
        [data.tokensConsumed, data.userId]
      );

      if (uRes.rows.length === 0) {
        throw new NotFoundError('用户不存在');
      }

      const newBalance = Number(uRes.rows[0].credits_balance);

      await client.query(
        `INSERT INTO credit_transactions (id, user_id, canvas_id, model_name, tokens_consumed, balance_after, action_type, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          txId,
          data.userId,
          data.canvasId || null,
          data.modelName,
          data.tokensConsumed,
          newBalance,
          data.actionType || 'ai_chat',
        ]
      );

      await client.query('COMMIT');
      return { newBalance, transactionId: txId };
    } catch (e) {
      await client.query('ROLLBACK');
      // PG 事务失败必须显式失败（防止调用方误以为扣费成功）；无 pool 时由下方内存路径兜底
      if (e instanceof NotFoundError) throw e;
      console.error('PG deductCredits transaction failed:', e);
      throw new BillingError('算力扣除事务失败，请稍后重试');
    } finally {
      client.release();
    }
  }

  // In-memory fallback（未配置 PG 时的容灾路径）
  const user = inMemoryStore.users.get(data.userId);
  if (!user) throw new NotFoundError('用户不存在');

  user.credits_balance = Math.max(0, user.credits_balance - data.tokensConsumed);
  const txRecord: CreditTransactionRecord = {
    id: txId,
    user_id: data.userId,
    canvas_id: data.canvasId || null,
    model_name: data.modelName,
    tokens_consumed: data.tokensConsumed,
    balance_after: user.credits_balance,
    action_type: data.actionType || 'ai_chat',
    created_at: new Date().toISOString(),
    user_email: user.email,
  };
  inMemoryStore.creditTransactions.unshift(txRecord);
  return { newBalance: user.credits_balance, transactionId: txId };
}

export async function adjustUserCredits(data: {
  userId: string;
  amount: number; // positive to add, negative to subtract
  operatorId: string;
  reason: string;
}): Promise<{ newBalance: number; transactionId: string }> {
  const p = getPool();
  const txId = crypto.randomUUID();

  if (p) {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      const uRes = await client.query(
        `UPDATE users
         SET credits_balance = GREATEST(0, credits_balance + $1), updated_at = NOW()
         WHERE id = $2
         RETURNING credits_balance`,
        [data.amount, data.userId]
      );

      if (uRes.rows.length === 0) throw new NotFoundError('用户不存在');
      const newBalance = Number(uRes.rows[0].credits_balance);

      await client.query(
        `INSERT INTO credit_transactions (id, user_id, canvas_id, model_name, tokens_consumed, balance_after, action_type, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5, 'admin_adjustment', NOW())`,
        [txId, data.userId, `admin:${data.reason}`, -data.amount, newBalance]
      );

      await client.query('COMMIT');
      return { newBalance, transactionId: txId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const user = inMemoryStore.users.get(data.userId);
  if (!user) throw new NotFoundError('用户不存在');
  user.credits_balance = Math.max(0, user.credits_balance + data.amount);

  const txRecord: CreditTransactionRecord = {
    id: txId,
    user_id: data.userId,
    canvas_id: null,
    model_name: `admin:${data.reason}`,
    tokens_consumed: -data.amount,
    balance_after: user.credits_balance,
    action_type: 'admin_adjustment',
    created_at: new Date().toISOString(),
    user_email: user.email,
  };
  inMemoryStore.creditTransactions.unshift(txRecord);
  return { newBalance: user.credits_balance, transactionId: txId };
}

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
