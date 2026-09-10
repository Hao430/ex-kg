# ADR-0014: 接入支付宝电脑网站支付（alipay.trade.page.pay）

- **Status**: Accepted
- **Date**: 2026-09-10
- **Deciders**: 枝想架构组
- **Tags**: payment, security, integration

## Context and Problem Statement

一期（ADR-0006）以 `PAYMENT_ENABLED=false` + MockProvider + 客服微信人工充值过渡。二期需求是接入支付宝在线支付（充值 VIP 订阅 weekly/monthly/yearly），替换人工充值入口（用户 2026-09-10 拍板移除）。约束：

- 本产品是响应式 Web，PC 与手机都要能支付；
- 资金安全是硬约束：验签、金额校验、幂等激活缺一不可；
- 既有 `PaymentProvider` 抽象（Spec E1）与 e1-payment.test.ts 锁定的 mock 行为不得回归；
- tests/ 只读，新增测试文件需用户显式授权（已授权：`tests/alipay-payment.test.ts`）。

## Decision Drivers

- 签名/验签正确性（RSA2）是资金安全核心，不允许自实现踩坑；
- 与既有 provider 抽象无缝：未配置支付宝时必须回落 mock（保开发/测试链路）；
- notify 是支付宝服务器回调：不能挂登录态、不能挂 IP 限流；
- 通知可能丢失/乱序/重复：本地状态机必须幂等且可对账兜底。

## Considered Options

- **Option A: 官方 alipay-sdk v4** — Ant Group 维护，TS 原生，封装 RSA2 签名/验签与 v3 API
- **Option B: 自实现签名/验签** — 仅用 node:crypto，自己拼签名字符串
- **Option C: 其他第三方封装库** — 社区维护质量参差

## Decision Outcome

**Chosen option: "Option A: 官方 alipay-sdk v4"**, because 验签是资金安全核心，官方包把 urlencode 原串、sign_type 剔除、v3 响应验签等坑全部内置，且 TS 类型完善、ESM/CJS 双格式与本项目兼容。

### Positive Consequences

- `AlipayProvider` 仅做业务映射（下单 URL / 状态映射 / notify 验签透传），代码量小；
- mock 回落由 `getPaymentProvider()`（`billing.service.ts`）统一裁决，e1 测试零改动回归；
- 测试用真实 SDK + 测试密钥对 + 本地假网关，验签代码路径全真。

### Negative Consequences

- 依赖 SDK 版本行为（v4 与 v3 教程 API 有差异：`pageExecute`/`checkNotifySignV2`/`curl`）；
- v3 curl 强制响应验签，联调假网关/抓包时需理解 `alipay-signature` 头机制。

### Follow-up / Mitigation

- 查单对账兜底（`getOrderStatus` 内 pending 单主动 query，5s 节流）防 notify 丢失；
- `settleOrderPaid` 条件更新 pending→paid + `activateOrder` 叠期，notify 与查单并发到达幂等；
- 退款接口已实现（`alipay.trade.refund`）但一期不暴露业务端点。

## Pros and Cons of the Options

### Option A: 官方 alipay-sdk v4

- good：签名/验签正确性由官方维护；v3 API（query/refund）直接可用；类型完善
- bad：新增 ~2MB 依赖树；API 与主流 v3 教程差异大，需读 SDK 源码确认

### Option B: 自实现

- good：零依赖、完全可控
- bad：notify 验签的 decode 原串、sign_type 兼容、v3 响应验签等细节极易踩坑，资金场景不可接受

## 关键决策细节

1. **notify 端点（POST /api/subscriptions/notify）免 authMiddleware、免 subscriptionRateLimiter**——调用方是支付宝服务器（form-urlencoded），验签即鉴权；限流会造成通知重试风暴。这是对 ADR-0007「每端点独立限流器」纪律的显式豁免（`subscriptions.ts` 文件级判据仍满足，理由记录于此）。
2. **到账判定只信 notify + 查单**，return_url 同步回跳不做任何业务判定（仅展示）。
3. **金额校验用字符串精确比对**（`total_amount === (amount_cents/100).toFixed(2)`），配合签名校验拦截金额篡改；`app_id` 归属校验防跨应用重放。
4. **非成功态 notify（TRADE_CLOSED 等）回 'success' 但不激活**——确认收到即可，终态同步由查单兜底负责。
5. **移动端一期不接 wap.pay**：page.pay 在手机浏览器会拉起支付宝收银台 H5/APP，体验稍绕但可用；后续按需二接。
6. **人工充值入口移除**：RechargeModal 删微信公告条与 `VITE_SUPPORT_WECHAT_ID`；支付不可用（503 PAYMENT_DISABLED）时显示「在线支付暂未开放」。
7. **年度套餐下架（2026-09-10）**：支付宝渠道单笔限额 ¥50，yearly（¥199）超限——`planInfoMap`/下单 schema/前端档位卡全部移除 yearly，服务端硬拒（400 INVALID_PLAN）防直连绕过；存量 yearly 订单不受影响（plan_id 为 varchar 无枚举约束）。用户经周卡/月卡叠加覆盖长周期需求（`activateOrder` 到期叠期）。

## 排障提示（联调必读）

- **验签必失败**首先检查：是否把「应用公钥」当成 `ALIPAY_ALIPAY_PUBLIC_KEY` 配置（应配开放平台侧的**支付宝公钥**）；沙箱与生产密钥是否混用。
- 私钥必须是 **PKCS8**（`keyType: 'PKCS8'`，SDK 默认 PKCS1）；.env 单行 base64 由 provider 内 `toPem()` 自动补头尾。
- `app.ts` 的 `express.urlencoded` 是 notify 解析前提，勿删。
- notify 应答必须是纯文本 `success`（非 JSON、非 2xx JSON body），否则支付宝按重试策略持续重发。

## References

- `server/services/payment/alipay-provider.ts`（新增）
- `server/services/billing.service.ts`（getPaymentProvider / settleOrderPaid / handleAlipayNotify / 查单兜底）
- `server/routes/subscriptions.ts`（notify 端点）
- `server/repositories/billing.repository.ts`（createOrder paid_at 修复：pending 单不再被盖 paid_at）
- `tests/alipay-payment.test.ts`（只读豁免，用户 2026-09-10 授权）
- `docs/adr/0006-mock-payment-phase1.md`（一期过渡，本 ADR 取代其人工充值方案）
- 外部：alipay.trade.page.pay 文档 https://opendocs.alipay.com/open/59da99d0_alipay.trade.page.pay
