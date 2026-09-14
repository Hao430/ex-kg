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
const { createOrder, updateOrderStatus, findOrderByNo, settlePaidOrder } = await import(
  '../../server/repositories/billing.repository.js'
);

let userId = '';

/**
 * 仓储调用一律包用户作用域——**与生产同构**：下单/查单/结算都发生在登录态请求里
 * （`subscriptionsRouter` 各端点均在 `authMiddleware` 之后；`/api/auth/subscribe` 已于
 * 2026-09-14 移除，因为它是「无支付即开通」的白拿 VIP 通道），
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

/**
 * settlePaidOrder（原子结算，2026-09-14）
 *
 * 为什么必须真库：默认套件只跑内存分支——内存是单线程顺序执行，`settlePaidOrder` 的
 * 事务、`make_interval` 叠期 SQL、以及「单条 UPDATE 完成读-改-写」这三件事全都覆盖不到。
 * 而这三件正是资金路径上「已付款未开通」「并发丢天数」两类缺陷的防线。
 */
describe('PG 真库：settlePaidOrder 原子结算与叠期', () => {
  /** 读当前 VIP 到期时间（ms）；无到期时间返回 null */
  async function vipExpiryMs(): Promise<number | null> {
    const rows = await pgQuery('SELECT vip_expires_at FROM users WHERE id = $1', [userId]);
    return rows[0]?.vip_expires_at ? new Date(rows[0].vip_expires_at).getTime() : null;
  }

  async function pendingOrder(days: number) {
    return createOrderInPg({
      userId,
      planId: 'weekly',
      planName: '周度 Pro 会员',
      amountCents: 990,
      durationDays: days,
      paymentMethod: 'online_pay',
      status: 'pending',
    });
  }

  t('原子结算：订单转 paid 与 VIP 叠期在同一事务内一起提交', async () => {
    const order = await pendingOrder(7);
    const before = await vipExpiryMs();

    const settled = await asUser(() => settlePaidOrder(order.order_no));
    assert.ok(settled, 'pending 单应结算成功');
    assert.equal(settled!.status, 'paid');
    assert.ok(settled!.paid_at, '结算后必须写入支付时间');

    const after = await vipExpiryMs();
    assert.ok(after !== null, 'VIP 到期时间必须被写入——否则就是「已 paid 未开通」');
    const added = (after! - (before ?? Date.now())) / 86400000;
    assert.ok(added > 6.9 && added < 7.1, `应叠 7 天，实际 ${added}`);
  });

  t('幂等：同一订单重复结算不重复叠期', async () => {
    const order = await pendingOrder(7);
    await asUser(() => settlePaidOrder(order.order_no));
    const first = await vipExpiryMs();

    await asUser(() => settlePaidOrder(order.order_no));
    const second = await vipExpiryMs();
    assert.equal(second, first, '重复结算（notify 与查单并发）不得重复叠期');
  });

  t('叠期基准取库里当前值：7 天单之后再结 30 天单 → 累计 37 天', async () => {
    const o1 = await pendingOrder(7);
    await asUser(() => settlePaidOrder(o1.order_no));
    const base = (await vipExpiryMs())!;

    const o2 = await pendingOrder(30);
    await asUser(() => settlePaidOrder(o2.order_no));

    const added = ((await vipExpiryMs())! - base) / 86400000;
    assert.ok(
      added > 29.9 && added < 30.1,
      `第二单应在第一单的到期时间上顺延 30 天（基准取库里当前值，不是更早读到的旧值），实际 ${added}`
    );
  });

  t('并发结算同一用户的两个订单：7 天 + 30 天都不丢（丢失更新回归）', async () => {
    const base = await vipExpiryMs();

    // 两个订单同时结算：原实现是「findUserById 读 → updateVipMembership 写」两段，
    // 两个请求会双双读到同一个旧到期时间，后写覆盖先写，有一单的天数凭空消失。
    const [o1, o2] = await Promise.all([pendingOrder(7), pendingOrder(30)]);
    await Promise.all([
      asUser(() => settlePaidOrder(o1.order_no)),
      asUser(() => settlePaidOrder(o2.order_no)),
    ]);

    const added = ((await vipExpiryMs())! - (base ?? Date.now())) / 86400000;
    assert.ok(
      added > 36.5 && added < 37.5,
      `两单共 37 天必须都叠上（丢天数说明读-改-写没有原子化），实际 ${added}`
    );
  });

  t('admin 结算后角色不被降级，且 failed 单不会被结算', async () => {
    await pgQuery(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
    const adminOrder = await pendingOrder(7);
    await asUser(() => settlePaidOrder(adminOrder.order_no));
    const roleRows = await pgQuery('SELECT role FROM users WHERE id = $1', [userId]);
    assert.equal(roleRows[0].role, 'admin', 'admin 不应被结算降级为 vip');
    await pgQuery(`UPDATE users SET role = 'user' WHERE id = $1`, [userId]);

    const closed = await pendingOrder(7);
    await asUser(() => updateOrderStatus(closed.order_no, 'failed'));
    const settled = await asUser(() => settlePaidOrder(closed.order_no));
    assert.equal(settled, null, 'failed 单不得被结算（返回 null 交由调用方应答）');
  });
});
