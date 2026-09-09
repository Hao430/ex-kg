# ADR-0011: 邮箱验证（验证码先行）

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: security, registration, email-verification

## Context and Problem Statement

旧流程：注册 → 创建账号（`email_verified=false`）→ 发验证邮件 → 用户点链接。

问题：

- 大量用户**不发邮件**就流失（验证邮件进垃圾箱 / 等待不耐烦）；
- 攻击者可批量创建未验证账号刷"30 次生成额度"；
- 邮箱验证率低于 30%，但已生成大量未激活账号占用资源。

## Decision Drivers

- 注册即"邮箱已验证"——必须先证明邮箱控制权；
- 验证码比链接**更友好**（不需要离开应用）；
- 验证码**短窗口 + 短长度**：10 分钟、6 位数字；
- 防重放：连错 5 次作废；
- 链接式验证保留，仅服务 admin 换绑邮箱后二次验证。

## Considered Options

- **Option A: 链接式验证**（旧）
- **Option B: 验证码先行**（已选）
- **Option C: OAuth 第三方登录**（无验证问题）
- **Option D: 跳过验证**（仅体验版）

## Decision Outcome

**Chosen option: B**, because 验证码流程在**用户转化率**和**安全**之间取了最好的折中。

### 流程

```
1. POST /api/auth/send-register-code (email)
   → 6 位码生成，10 分钟有效
   → 每邮箱 60s 冷却，每 IP 5/h
   → 存 email_verification_codes 表（PG + 内存双模）
2. POST /api/auth/sign-up (email, password, name, code)
   → 原子消费 code（连错 5 次作废）
   → 账号创建时 email_verified=true
3. 未验证拦截（仅 chat 路由）
   → 403 EMAIL_NOT_VERIFIED
   → admin 换绑邮箱后的二次验证场景
```

### Positive Consequences

- 注册转化率显著提升（无需离开应用）；
- 攻击者无法批量创建未验证账号（必须真控制邮箱）；
- 验证码体验优于链接（手机用户更熟悉）；
- 链接式 `/verify-email` 与 `/resend-verification` 保留，**仅服务 admin 换绑邮箱后的二次验证**。

### Negative Consequences

- 验证码邮件**必须真发**（生产 SMTP 缺配启动即抛错，见 `mailer.ts:18-22`）；
- 验证码输入**对老年人不友好**（但比链接友好）；
- 5/h IP 限流在共享 IP（公司 / 学校网络）下可能误伤。

### Follow-up / Mitigation

- 生产环境 SMTP 缺配 fail-fast 已在 `mailer.ts` 实现；
- 共享 IP 误伤场景可加"白名单企业邮箱域名"（二期）；
- 监控注册转化率（验证码未消费率 > 50% 时告警）。

## Pros and Cons of the Options

### Option A: 链接式验证

- **Good**: 传统
- **Bad**: 转化率低；用户离开应用

### Option B: 验证码先行（已选）

- **Good**: 转化率高；体验好
- **Bad**: 邮件必须真发；老年人不友好

### Option C: OAuth 第三方

- **Good**: 无验证问题
- **Bad**: 引入第三方；隐私合规审查

### Option D: 跳过验证

- **Good**: 极简
- **Bad**: 攻击者刷号；账号资产无价值

## References

- 代码：`server/routes/auth.ts`、`server/repositories/email-code.repository.ts`、`server/lib/mailer.ts`
- 文档：`docs/specs/D3-邮箱验证.md`、`docs/specs/2026-09-注册验证码重设计.md`
