# ADR-0006: 一期不接真实支付（PaymentProvider 抽象 + Mock）

- **Status**: Superseded by ADR-0014（2026-09-10 接入支付宝；PaymentProvider 抽象与 mock 开发链路仍沿用本 ADR 设计）
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: payment, phase1, abstraction

## Context and Problem Statement

枝想一期产品定位"内部 alpha + 受邀公测"，**真实支付接入**会带来：

- 支付牌照 / 商户号审核（1-3 个月）；
- 财务合规（开票、对账、退款）；
- 资金流与会员状态机耦合的安全风险。

但商业化能力又是**二期必须的**——不能等到二期再设计，要在一期就把"支付接口"标准化。

## Decision Drivers

- 一期不接真实支付，但保留商业化数据模型（`orders` 表已建）；
- `PaymentProvider` 抽象为 4 个方法：`createPayment / queryPayment / handleCallback / refund`；
- 一期 `MockProvider` 跑通订单全生命周期；
- `PAYMENT_ENABLED=false`（默认）下 `/api/subscriptions/orders` 与 `mock-pay` 返回 503 `PAYMENT_DISABLED`；
- VIP 仍可通过 Admin 后台赠送（一期唯一获客路径）。

## Considered Options

- **Option A: 直接接微信/支付宝支付**（一期就上）
- **Option B: 不做支付**（连抽象都没有）
- **Option C: PaymentProvider 抽象 + MockProvider**（已选）
- **Option D: 第三方聚合支付**（如 Ping++）

## Decision Outcome

**Chosen option: C**, because 它在不引入外部支付依赖的前提下，让一期的"订单创建/支付回调/退款"流程跑通，**让二期接入真实渠道只换 Provider 实现**。

### Positive Consequences

- 一期即可演示"下单→支付→VIP 激活→到期"完整闭环（虽然支付是 mock）；
- 二期接入微信/支付宝**只换 `payment-provider.ts` 实现**，`billing.service.ts` 无需改；
- 订单表 `orders` 已存 `payment_method / amount_cents / status`，二期直接可用；
- 套餐定价已锁定（周卡 ¥9.9 / 月卡 ¥24.9 或 ¥29.9 / 年卡 ¥199）——待产品收口口径。

### Negative Consequences

- 一期 `MockProvider` 与真实支付的行为差异（如异步回调的时序、对账接口）需要**模拟**而非"真"；
- 用户可能误以为真支付（虽然有明显的 `mock-pay` 按钮命名）；
- 定价数据散落在 `README` / `里程碑` / `CODEBUDDY.md` 三处，未收口（见技术债清单 §文档口径）。

### Follow-up / Mitigation

- 二期接真实支付前**必须**写 ADR-0006-Supersede（命名 `0006-supersede-real-payment.md`）；
- 收口定价文案：以 `grep -rn "月卡" docs/ README.md` 输出为准，待产品决策；
- 增加"订阅价格一致性"CI 检查（防止再次口径漂移）。

## Pros and Cons of the Options

### Option A: 直接接真实支付

- **Good**: 一步到位
- **Bad**: 牌照周期；财务合规；安全风险

### Option B: 不做支付

- **Good**: 极简
- **Bad**: 二期重做数据模型；orders 表要后补

### Option C: 抽象 + Mock（已选）

- **Good**: 一期跑通流程；二期零成本接入
- **Bad**: Mock 行为与真实渠道的差异

### Option D: 第三方聚合

- **Good**: 标准接口
- **Bad**: 第三方依赖；费用

## References

- 代码：`server/services/payment/payment-provider.ts:1-15`、`server/services/payment/mock-provider.ts`、`server/routes/subscriptions.ts`
- 文档：`docs/specs/E1-支付抽象与Mock生命周期.md`、`docs/里程碑与分期规划.md` §一-7
