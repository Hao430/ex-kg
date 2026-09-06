# Spec C — 清理算力点数体系（C1–C6 整组）

> 来源：`docs/里程碑与分期规划.md` C 组 C1–C6、决策 #3
> 状态：本轮整组实施（C1–C6 耦合：删字段必然连锁删调用方）

## 1. 删除清单

**后端**：
- C1：`users.credits_balance` 列 + CHECK 约束（schema.ts 建表移除 + 迁移语句 `DROP COLUMN IF EXISTS`）；种子账号赠送积分移除；注册 `initialCredits` 参数与 50000 赠送逻辑移除
- C2：`credit_transactions` 表与索引删除（schema 移除 + `DROP TABLE IF EXISTS`）；`deductCredits()`、`CreditTransactionRecord` 类型删除；chat.ts 3 处扣点调用删除（`ai_request_logs` 审计保留）
- C3：`quotaMiddleware` 点数预检已由 B1 `chatQuotaMiddleware` 替换（本轮确认无残留）
- C4：`/api/auth/recharge`、`/api/admin/users/:id/credits`、`/api/admin/transactions`（credit 流水）端点删除；`adjustUserCredits`/`listAdminTransactions` 删除；Admin 调账 UI 与流水 Tab 删除
- C5：前端点数显示清理——`AuthUser.credits_balance`、AuthModal/DeepDiveCanvas/LandingPage/AdminDashboard 的点数/算力文案，点数余额展示删除
- C6：孤儿字段清理——`UserRecord.credits_balance`、`ai_models_config` 无关（未使用表不在 schema 清理范围，spec 表口径见里程碑）；admin overview 的 token 统计改源 `credit_transactions` → `ai_request_logs`（表删除后唯一 token 来源）

**保留**：`orders` 表与订单链路（E 组订阅用）、`subscribeUserPlan`、RechargeModal（订阅 UI，去点数文案）、`isVip` 逻辑。

## 2. 测试先行（`tests/c-cleanup.test.ts`）

1. sign-up 响应与 /me 均无 `credits_balance` 字段
2. `POST /api/auth/recharge` → 404
3. `POST /api/admin/users/:id/credits` → 404
4. `GET /api/admin/transactions` → 404
5. 订阅链路不回归（POST /api/auth/subscribe 仍 200）
6. sign-in 响应无 credits_balance

## 3. 验收标准

- [ ] 全库 grep 无 `credits_balance` / `credit_transactions` / `deductCredits` / `recharge` 残留（除里程碑/spec 文档）
- [ ] 全站 UI 无「点数 / 算力 / 余额」字样（grep 验收）
- [ ] 新测试全绿、既有 40 用例不回归；`tsc --noEmit` 通过
- [ ] 子代理审计通过后提交
