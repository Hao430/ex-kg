/**
 * J3+ — orders「下单 / 到账结算」的 PG 真库回归（2026-09-10 新增）
 *
 * 起因：billing.repository 的 INSERT / UPDATE 把**同一个占位符**用在两种类型上下文里
 * （`status` 列 = varchar，同时又与 text 字面量 `'paid'` 比较）→ PG 报
 * `42P08 inconsistent types deduced for parameter`，导致生产环境**下单与结算 100% 失败**。
 * 默认套件（`npm test`）只跑内存降级分支，永远覆盖不到这条 PG 路径——本文件补上这个缺口。
 * （注意：给重复参数加 `::text` 强转**不能**修，必须改用独立占位符。）
 *
 * 运行方式（与 pg-smoke 一致，不进默认套件）：
 *   docker compose -f docker-compose.pg-smoke.yml up -d postgres
 *   PG_SMOKE=1 npx tsx --test tests/pg/billing-orders.pg.test.ts
 *
 * 也可用 PG_TEST_URL 指向任意一次性真库，例如远端测试库：
 *   PG_TEST_URL=postgres://user:pw@host:5432/arborize_test PG_SMOKE=1 \
 *     npx tsx --test tests/pg/billing-orders.pg.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

process.env.DATABASE_URL =
  process.env.PG_TEST_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';

const { initDbSchema } = await import('../../server/core/schema.js');
const { getSystemPool } = await import('../../server/core/pool.js');
const { runWithUser } = await import('../../server/core/db-context.js');
const { createOrder, updateOrderStatus, findOrderByNo } = await import(
  '../../server/repositories/billing.repository.js'
);

let userId = '';

/**
 * 仓储调用一律包用户作用域——**与生产同构**：下单/查单/结算都发生在登录态请求里
 * （`subscriptionsRouter` 与 `/api/auth/subscribe` 均在 `authMiddleware` 之后），
 * 由 `runWithUser` 注入 `app.user_id`（ADR-0019）。裸调会缺作用域，见下方 `createOrderInPg`。
 */
const asUser = <T>(fn: () => Promise<T>): Promise<T> => runWithUser(userId, fn);

/** 绕过仓储直查（system 池）——用来证明「这行真的在 PG 里」 */
async function pgQuery(sql: string, params: unknown[]): Promise<any[]> {
  const p = getSystemPool();
  if (!p) throw new Error('PG 未就绪：请检查 DATABASE_URL / PG_TEST_URL（或先起 pg-smoke 容器）');
  return (await p.query(sql, params)).rows;
}

/**
 * 建单，并**立刻直查一次 PG 确认它真的落库了**。
 *
 * 为什么必须多这一步：仓储的 catch 会把「缺作用域」这类错误吞掉并回落内存
 * （`handlePgError` 只在 NODE_ENV=production 时 fail-fast，CI 里不是），于是缺作用域的
 * 情况下四个用例会**全绿**——但断言全在内存 Map 上成立，本文件存在的唯一理由
 * （42P08 参数类型回归覆盖 PG 路径）已经落空。2026-09-12 CI 实测就是这个状态。
 */
async function createOrderInPg(data: Parameters<typeof createOrder>[0]) {
  const order = await asUser(() => createOrder(data));
  const rows = await pgQuery('SELECT status FROM orders WHERE order_no = $1', [order.order_no]);
  assert.equal(
    rows.length,
    1,
    `订单 ${order.order_no} 没在 PG 里——createOrder 回落内存了（作用域缺失？），本用例已失去判别力`
  );
  return order;
}

/** 建一个临时属主用户（orders.user_id 有外键约束） */
before(async () => {
  await initDbSchema();
  const p = getSystemPool();
  if (!p) throw new Error('PG 未就绪：请检查 DATABASE_URL / PG_TEST_URL（或先起 pg-smoke 容器）');
  const res = await p.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'pg-smoke-hash', 'pg-smoke') RETURNING id`,
    [`pg-orders-${Date.now()}@example.com`]
  );
  userId = res.rows[0].id as string;
});

after(async () => {
  const p = getSystemPool();
  if (!p) return;
  if (userId) {
    await p.query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await p.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await p.end();
});

describe('PG 真库：orders 下单/结算（42P08 参数类型回归）', () => {
  t('pending 单可落库，且 paid_at 必须为空', async () => {
    const order = await createOrderInPg({
      userId,
      planId: 'weekly',
      planName: '周度 Pro 会员',
      amountCents: 990,
      durationDays: 7,
      paymentMethod: 'online_pay',
      status: 'pending',
    });
    assert.ok(order.order_no.startsWith('ORD-'), '订单号格式应为 ORD- 前缀');

    const fresh = await asUser(() => findOrderByNo(order.order_no));
    assert.ok(fresh, 'pending 单应已落库');
    assert.equal(fresh!.status, 'pending');
    assert.ok(!fresh!.paid_at, 'pending 单不得被盖上支付时间（对账口径依赖此约束）');
  });

  t('paid 单可落库，且 paid_at 有值', async () => {
    const order = await createOrderInPg({
      userId,
      planId: 'weekly',
      planName: '周度 Pro 会员',
      amountCents: 990,
      durationDays: 7,
      paymentMethod: 'online_pay',
      status: 'paid',
    });
    const fresh = await asUser(() => findOrderByNo(order.order_no));
    assert.ok(fresh);
    assert.equal(fresh!.status, 'paid');
    assert.ok(fresh!.paid_at, 'paid 单必须写入支付时间');
  });

  t('结算：pending → paid 条件更新成功并写 paid_at，重复结算返回 null（防双激活）', async () => {
    const order = await createOrderInPg({
      userId,
      planId: 'weekly',
      planName: '周度 Pro 会员',
      amountCents: 990,
      durationDays: 7,
      paymentMethod: 'online_pay',
      status: 'pending',
    });

    const settled = await asUser(() => updateOrderStatus(order.order_no, 'paid', 'pending'));
    assert.ok(settled, '首次结算应成功');
    assert.equal(settled!.status, 'paid');
    assert.ok(settled!.paid_at, '结算后必须写入支付时间');

    const again = await asUser(() => updateOrderStatus(order.order_no, 'paid', 'pending'));
    assert.equal(again, null, '第二次结算必须失败（幂等，防并发双激活）');
  });

  t('结算：不带 expectedStatus 的变体同样可用（参数个数不同的那条分支）', async () => {
    const order = await createOrderInPg({
      userId,
      planId: 'weekly',
      planName: '周度 Pro 会员',
      amountCents: 990,
      durationDays: 7,
      paymentMethod: 'online_pay',
      status: 'pending',
    });

    const updated = await asUser(() => updateOrderStatus(order.order_no, 'failed'));
    assert.ok(updated);
    assert.equal(updated!.status, 'failed');
  });
});
