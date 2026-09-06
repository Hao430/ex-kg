# Spec E1+E2 — PaymentProvider 抽象 + MockProvider 订单生命周期

> 来源：`docs/里程碑与分期规划.md` E 组 E1/E2、决策 #7（一期不接真实支付）；验收「下单 → 模拟支付 → 回调 → VIP 生效，全链路可走通」
> 状态：本轮实施

## 1. 设计

**`server/services/payment/payment-provider.ts`（E1 抽象）**：
```ts
export interface PaymentProvider {
  readonly name: string;
  createPayment(order: OrderRecord): Promise<{ payUrl: string }>;
  queryPayment(orderNo: string): Promise<{ status: 'pending' | 'paid' | 'failed' }>;
  handleCallback(payload: { orderNo: string; success: boolean }): Promise<{ orderNo: string; success: boolean }>;
  refund(order: OrderRecord): Promise<{ success: boolean }>;
}
```
**`server/services/payment/mock-provider.ts`（E2）**：内部 Map 记录模拟支付状态；`createPayment` → `mock://pay/{orderNo}` 置 pending；`simulatePay(orderNo)`（仅测试/非生产使用的模拟回调入口）；`refund` 置 refunded。

**billing.service 新流程**：
- `startSubscription(userId, plan)` → `createOrder(status: 'pending')` + `createPayment` → `{ orderNo, payUrl, amountCents }`
- `mockPayOrder(userId, orderNo)`（仅 mock + 非生产）：校验订单存在/属主/pending → `handleCallback` → `updateOrderStatus(paid)` → VIP 激活（复用订阅的续期/角色逻辑，抽 `activateOrder(order)`）
- `getOrderStatus(userId, orderNo)` → `queryPayment` + 订单记录
- 既有 `subscribeUserPlan`（一步开通）保留，内部共用 activate 逻辑
- billing.repository 新增 `findOrderByNo(orderNo)`、`updateOrderStatus(orderNo, status)`

**路由 `server/routes/subscriptions.ts`**（挂 `/api/subscriptions`，authMiddleware）：
- `POST /orders` `{plan}` → 201 `{ orderNo, payUrl, amountCents }`
- `POST /orders/:orderNo/mock-pay` → VIP 生效（**非生产环境限定**，生产 404）
- `GET /orders/:orderNo` → `{ status, order }`

**状态机**：`pending → paid | failed | refunded`；重复支付已 paid 单 → 409 `ORDER_ALREADY_PAID`。

## 2. 测试先行（`tests/e1-payment.test.ts`）

1. startSubscription → 201 + orderNo + payUrl `mock://`；GET 状态 pending；/me 仍 trial
2. mock-pay → 订单 paid、VIP 生效（me entitlements.plan='vip'）、到期顺延 7 天（weekly）
3. 重复 mock-pay 同单 → 409 ORDER_ALREADY_PAID
4. 未知 orderNo mock-pay / 查询 → 404
5. 他人订单 mock-pay → 403
6. 一步开通 /api/auth/subscribe 回归 200

## 3. 验收标准

- [ ] 新测试全绿；既有 49 用例不回归；`tsc --noEmit` 通过
- [ ] 子代理审计通过后提交
