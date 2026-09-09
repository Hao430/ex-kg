# ADR-0002: PostgreSQL + 内存双模自动容灾

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: persistence, resilience, dual-mode

## Context and Problem Statement

枝想后端需要一个**始终可启动**的持久层：

- 开发场景：开发者本机经常不安装 PG；
- 演示场景：销售/客户演示时不能依赖外部服务；
- 生产场景：PG 短暂不可用时不能阻断业务。

但**生产又必须用真库**——否则重启即丢数据，等于演示模式。

## Decision Drivers

- 开发零配置即可启动；
- PG 不可用时不抛错降级；
- 双模行为**严格一致**（PG 成功时内存无副作用，业务错误必须 rethrow 不能被吞）；
- 生产模式有 fail-fast 兜底（不静默走内存）。

## Considered Options

- **Option A: 强制 PG**（未配即启动失败）
- **Option B: 仅内存**（重启即丢）
- **Option C: PG 优先 + 内存兜底**（双模）
- **Option D: 抽象 ORM**（如 Prisma/Drizzle），底层切换

## Decision Outcome

**Chosen option: C**, because 它在不引入 ORM 重型依赖的前提下，让"开发与生产"用同一份代码。**业务错误必须 rethrow** 是该模式能成立的核心纪律（见 ADR-0002 纪律条款）。

### Positive Consequences

- 零依赖启动（克隆即跑）；
- 集成测试默认走内存分支，跑得快；
- PG 短暂故障时不阻断业务（与"在线产品"目标一致）；
- 内存分支与 PG 分支**输出同款 normalize**（`normalizeMemoryNode`），可无缝切换。

### Negative Consequences

- **生产误用风险**：若忘记配 `DATABASE_URL`，重启即丢数据；
- 双模行为漂移风险（PG 分支无测试覆盖，靠人工核验）；
- 内存 Map 是单例，水平扩展时**不可共享**——多实例部署需统一回 PG。

### Discipline（关键纪律，违反即破坏设计）

1. **业务错误必须在落内存前 rethrow**：禁止 catch 吞掉造成"200 假成功"。例：`canvas.repository.ts deleteCanvas` 抛 `ForbiddenError` 不能被吞。
2. **禁止双写**：PG 成功时不写内存；清理型操作（如 `deleteUserSessions`）除外。
3. **过期判断用 `> NOW()`**；用户与画布查询都带 `deleted_at IS NULL`。
4. **内存分支输出必须与 PG 分支归一化**：`normalizeMemoryNode()` 重建 `node.data` 默认值清单，grounding 直通不补默认。

### Follow-up / Mitigation

- **生产 fail-fast 待补**：`createApp()` 启动时若 `NODE_ENV=production` 且无 `DATABASE_URL` 应抛错（参照 `mailer.ts:18-22` 的 SMTP fail-fast 模式）；
- CI 增加真库冒烟阶段（见技术债清单 §治理待办）；
- 水平扩展前必须先迁移到 PG（内存 Map 不跨进程）。

## Pros and Cons of the Options

### Option A: 强制 PG

- **Good**: 行为单一；不会误用
- **Bad**: 开发体验差；演示受阻

### Option B: 仅内存

- **Good**: 极简
- **Bad**: 任何重启即丢，生产完全不可用

### Option C: PG 优先 + 内存兜底（已选）

- **Good**: 零依赖启动 + 生产可用 + 同一份代码
- **Bad**: 双模漂移风险；生产误用风险

### Option D: 抽象 ORM

- **Good**: 切换数据库成本低；类型安全
- **Bad**: 学习成本；性能开销；与现有 `pg` 直连模式冲突

## References

- 代码：`server/core/pool.ts:11-38`、`server/core/memory-store.ts:1-100`、`server/repositories/canvas.repository.ts:28-79`
- 文档：`docs/开发规范.md` §3.4 双模持久化、`CODEBUDDY.md` 第 24-29 行
