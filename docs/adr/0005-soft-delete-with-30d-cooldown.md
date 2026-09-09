# ADR-0005: 软删除 + 30 天冷却期

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: persistence, compliance, data-lifecycle

## Context and Problem Statement

GDPR / 个保法要求"被遗忘权"，但**误删与客服需求**需要恢复窗口：

- 用户误删画板/账号，30 分钟内后悔；
- 客服协助恢复被注销账号（短期）；
- 注销后 30 天内同邮箱可用新账号重注册（与 unique partial index 配合）；
- 超期硬删是合规底线。

## Decision Drivers

- 软删除（`deleted_at`）保留主键但标记为已删；
- 部分索引 `WHERE deleted_at IS NULL` 让活跃数据查询走索引；
- 30 天冷却期可由 Admin 手动恢复；
- 30 天后 `cleanupDeletedUsers` 任务硬删（依赖 `DELETED_USER_RETENTION_DAYS`）；
- 画板软删 + 子表 nodes/edges 即时物理清（避免悬挂引用）。

## Considered Options

- **Option A: 即时硬删**
- **Option B: 软删除 + 7 天冷却**
- **Option C: 软删除 + 30 天冷却**（已选）
- **Option D: 软删除 + 永久（仅 Admin 删）**

## Decision Outcome

**Chosen option: C**, because 30 天是用户行为研究 + GDPR 实操的折中窗口：足够覆盖误删与客服场景，又不至于让"被遗忘权"沦为空话。

### Positive Consequences

- `partial index WHERE deleted_at IS NULL` 让活跃查询不扫历史；
- 30 天内 Admin 可手动恢复（`canvas_delete / account_delete` 审计留痕）；
- `cleanupDeletedUsers(30)` 后台任务自动级联硬删；
- 同邮箱在冷却期内可重注册（新 id）。

### Negative Consequences

- 数据膨胀：30 天内所有注销数据留存；
- 30 天硬删是**全表级联**（PG `ON DELETE CASCADE`），对大表需分批（当前 30 天窗口下数据量可控）；
- 管理员账号豁免注销（见技术债清单 §单点风险）。

### Follow-up / Mitigation

- 大数据量时 `cleanupDeletedUsers` 改批量 + 进度日志；
- 增加 `data_retention_logs` 审计表，记录每次清理的 id 范围（合规留痕）。

## Pros and Cons of the Options

### Option A: 即时硬删

- **Good**: 简单
- **Bad**: 误删无法恢复；客服场景失能

### Option B: 软删除 + 7 天

- **Good**: 较短的合规窗口
- **Bad**: 用户后悔期可能不够

### Option C: 软删除 + 30 天（已选）

- **Good**: 误删覆盖 + GDPR 折中 + 客服可恢复
- **Bad**: 数据膨胀

### Option D: 永久软删

- **Good**: 万能恢复
- **Bad**: 合规风险；数据无限增长

## References

- 代码：`server/core/schema.ts` users/canvases/nodes 的 `deleted_at` 字段、`server/jobs/log-cleanup.ts:21-29`、`server/repositories/user.repository.ts` 软删查询
- 文档：`docs/specs/F4-注销流程.md`、`docs/specs/F5-scrypt与日志留存.md`
