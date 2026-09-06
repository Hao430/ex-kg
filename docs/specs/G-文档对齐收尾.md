# Spec G — 文档与实现对齐收尾（一期收官）

> 来源：`docs/里程碑与分期规划.md` G 组 G4/G6 及历轮（A-F）落地后的文档滞后
> 状态：本轮实施；G1/G2/G3/G5 已在前轮完成

## 1. 已知滞后清单（以代码为准对齐文档）

**技术架构文档**：
- §1.1 技术栈：缺 nodemailer；TypeScript 版本描述
- §2 架构图：Server Layer 路由清单缺 `/api/subscriptions`、`/api/feedback` 说明口径、errorHandler、jobs
- §3 数据模型：users 字段清单过时（credits_balance 已删、缺 email_verified/verify_token/verify_expires_at/reset_token/reset_expires_at/deleted_at）；credit_transactions 小节未删；audit_logs 写入已落地（不再是纯预留）；20 张表口径复核（credit_transactions 删除后 19 张）
- §4 关键算法：扣费相关描述（4.1 无；4.3 无）——核对无 credits 残留
- §5 安全：限流清单补全（signup 5/h/IP、forgot-password 5/h/IP、resend 3/10min/user、login 15/min）；scrypt 加固参数（F5 已提）；邮箱验证/注销流程/审计日志查询端点补述

**README**：
- 目录树补 `server/jobs`、`server/services/payment`、`server/middleware/quota`、`server/repositories` 细分清单
- 文档导航补 `docs/specs/` 与 `docs/开发规范.md`

**需求说明文档（PRD）**：
- 补 D3 邮箱验证要求（未验证禁推理）与 F4 注销（30 天冷却）至 3.4/相应模块
- 3.4 订阅定价处核对 E1/E2 一期 Mock 支付口径

**里程碑**：
- 待定项 #1/#2/#3/#5 均已定案（宽限 7 天、D1 5/h、保留 90 天、G6 归属二期）→ 待定表更新，#4（二期支付渠道）保持待定
- G 组全部勾选；基线描述更新（一期收官状态）

## 2. 验收标准（grep 抽查清单）

- [ ] 四份文档 grep `credits_balance|credit_transactions|deductCredits` 零残留
- [ ] 技术架构文档表数量口径 = 实际（19 张：20 - credit_transactions）
- [ ] 限流数值文档 = 代码（signup 5/h、forgot 5/h、resend 3/10min、login 15/min、chat 25/60/120）
- [ ] README 目录树与 `server/` 实际目录一致
- [ ] 里程碑待定表仅剩 #4（二期支付渠道）
- [ ] `tsc --noEmit` + `npm test` 不回归（纯文档轮，应零代码改动）
