# ADR-0012: 默认画板禁删

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: data-protection, default-canvas, multi-tenancy

## Context and Problem Statement

枝想有一个**全局共享默认画板**（`default-board` / `default-canvas`）——所有新用户首屏共用同一行（见 ADR-0004 严格属主制）。如果允许软删：

- 软删会让所有用户对该 id 永久 404（`deleted_at IS NULL` 查询过滤）；
- 全局默认板**锁死**——所有用户登录后看到空状态；
- 历史上曾因 `board-` 前缀的"属主共享"放行导致过一次线上事故。

## Decision Drivers

- 默认画板是**全局共享**资源，删除影响所有用户；
- 禁删是**物理层兜底**（不是业务校验）；
- 误删场景：用户想删的可能是自己的某个画板，不是默认画板；
- 唯一合法操作是 admin 在后端**重置默认画板内容**（不影响 id 存在性）。

## Considered Options

- **Option A: 允许软删**（历史方案）
- **Option B: 物理禁删 + admin 重置内容**（已选）
- **Option C: 复制默认画板给每个用户**（无共享）

## Decision Outcome

**Chosen option: B**, because 物理禁删是**最简单且最不易绕过**的兜底。共享默认画板保留产品级"首屏一致体验"，同时不让任何操作影响 id 存在性。

### 实现

```typescript
// server/repositories/canvas.repository.ts
export function isSharedDefaultCanvas(canvasId: string): boolean {
  return canvasId === 'default-board' || canvasId === 'default-canvas';
}

// deleteCanvas 入口
if (isSharedDefaultCanvas(canvasId)) {
  throw new ForbiddenError('默认画板不可删除', 'DEFAULT_CANVAS_PROTECTED');
}
```

### Positive Consequences

- **物理层兜底**：即使 service 层有 bug 也无法绕过 repository 拦截；
- 保留产品级"首屏一致"体验；
- 与 ADR-0004 严格属主制的"放行点"形成闭环。

### Negative Consequences

- 默认画板内容可能"脏"（用户填的测试内容）；
- 禁删与用户的"清理画板列表"期望冲突（前端需隐藏默认画板的删除按钮）；
- admin 重置默认画板是**破坏性操作**，需谨慎。

### Follow-up / Mitigation

- 前端在画板列表隐藏默认画板的删除按钮；
- admin 重置默认画板需写 `user_audit_logs` 完整留痕；
- 二期可引入"默认画板版本管理"（保留历史版本）。

## Pros and Cons of the Options

### Option A: 允许软删

- **Good**: 灵活
- **Bad**: 全局锁死风险

### Option B: 物理禁删（已选）

- **Good**: 物理兜底；简单
- **Bad**: admin 重置需谨慎

### Option C: 复制默认画板

- **Good**: 无共享
- **Bad**: 首屏体验不一致；新用户无内容

## References

- 代码：`server/repositories/canvas.repository.ts:9-17`、`server/services/canvas.service.ts` deleteCanvas 路径
- 文档：`docs/specs/H1-画布多租户严格属主制.md`、`docs/specs/2026-09-默认画板禁删.md`
