# ADR-0012: 默认画板禁删

- **Status**: Accepted（2026-09-12 修订：禁删理由改写，见下）
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: data-protection, default-canvas, multi-tenancy

## Context and Problem Statement

枝想有两个**公开画板 id**（`default-board` / `default-canvas`）——它们不是内部 id，而是被客户端硬编码、被老版本前端与分享链接直接引用的**约定 id**（它们之所以公开，是因为 ADR-0004 时代它们是全局共享单行；`default-board` 已于 ADR-0018 私有化，但 id 本身仍然是公开约定）。如果允许软删：

- 软删让该 id **永久 404**（`deleted_at IS NULL` 查询过滤），而引用它的客户端与链接不会消失——老标签页、旧版本前端、历史分享都会指向一个永远不存在的画板，且用户自己无法恢复（恢复窗口只有 admin 有）；
- 历史上曾因 `board-` 前缀的"属主共享"放行导致过一次线上事故。

> **2026-09-12 修订（ADR-0018）**：本 ADR 最初的动机是"全局共享画板删除会锁死所有用户"。`default-board` 私有化后它不再是共享行，"锁死所有用户"不再成立，但**禁删保留**——理由改为上面这条 id 引用面：公开 id 被硬编码引用，软删即让这些引用永久失效。禁删因此与授权**解耦**：`isDefaultCanvasPublicId()` 判定禁删（与模式无关），`isSharedDefaultCanvas()` 判定授权放行（随 `SAVE_DEFAULT_BOARD_MODE` 切换），两者不再共用一个函数。

## Decision Drivers

- 公开 id 被客户端硬编码引用，删除会让引用永久失效且用户无法自愈；
- 禁删是**物理层兜底**（不是业务校验）；
- 误删场景：用户想删的可能是自己的某个画板，不是公开 id 画板；
- 唯一合法操作是 admin 在后端**重置画板内容**（不影响 id 存在性）。

## Considered Options

- **Option A: 允许软删**（历史方案）
- **Option B: 物理禁删 + admin 重置内容**（已选）
- **Option C: 复制默认画板给每个用户**（无共享）
- **Option D: 让公开 id 可删**（已否决，2026-09-12 随 ADR-0018 一并评估）

## Decision Outcome

**Chosen option: B**, because 物理禁删是**最简单且最不易绕过**的兜底。id 存在性不受任何用户操作影响，硬编码引用这些 id 的客户端与链接因此永远有落点。

### 实现

禁删判定用 `isDefaultCanvasPublicId()`，**它不接受授权开关影响**（两种模式下都禁删）；授权放行另用 `isSharedDefaultCanvas()`，二者刻意不共用一个函数，避免将来调授权时把禁删一起改掉：

```typescript
// server/repositories/canvas.repository.ts
/** 公开 id 判定，与授权无关：仅供「禁删」与 id 归属判断使用（ADR-0018） */
export function isDefaultCanvasPublicId(canvasId: string): boolean {
  return canvasId === 'default-board' || canvasId === 'default-canvas';
}

/** 是否仍按「全局共享」放行——仅授权路径使用，随 SAVE_DEFAULT_BOARD_MODE 切换 */
export function isSharedDefaultCanvas(canvasId: string): boolean {
  return process.env.SAVE_DEFAULT_BOARD_MODE !== 'private' && isDefaultCanvasPublicId(canvasId);
}

// deleteCanvas 入口
if (isDefaultCanvasPublicId(canvasId)) {
  throw new ForbiddenError('默认画板不可删除', 'DEFAULT_CANVAS_PROTECTED');
}
```

### Positive Consequences

- **物理层兜底**：即使 service 层有 bug 也无法绕过 repository 拦截；
- 硬编码引用这些 id 的客户端与链接永远有落点；
- 与 ADR-0004/0016 严格属主制的"放行点收敛"不冲突：禁删说的是 id 存在性，不是访问权。

### Negative Consequences

- 这些画板内容可能"脏"（用户填的测试内容）；
- 禁删与用户的"清理画板列表"期望冲突（前端需隐藏删除按钮）；
- admin 重置内容是**破坏性操作**，需谨慎。

### Follow-up / Mitigation

- 前端在画板列表隐藏公开 id 画板的删除按钮——按**公开 id 集合**判定（`src/lib/board-scope.ts` 的 `SHARED_BOARD_IDS`），与服务端一致，不依赖授权开关；
- admin 重置内容需写 `user_audit_logs` 完整留痕；
- 二期可引入"画板版本管理"（保留历史版本）。

## Pros and Cons of the Options

### Option A: 允许软删

- **Good**: 灵活
- **Bad**: 公开 id 被硬编码引用，软删即让引用永久 404；ADR-0004 时代还会锁死全局共享板

### Option B: 物理禁删（已选）

- **Good**: 物理兜底；简单
- **Bad**: admin 重置需谨慎

### Option C: 复制默认画板

- **Good**: 无共享
- **Bad**: 首屏体验不一致；新用户无内容

### Option D: 让公开 id 可删（已否决）

- **Good**: 用户自由
- **Bad**: 硬编码引用永久 404；老标签页/旧版本客户端/历史分享同时失效；用户无自愈手段（恢复窗口只有 admin 有）

## References

- 代码：`server/repositories/canvas.repository.ts`（`isDefaultCanvasPublicId` / `isSharedDefaultCanvas`）、`server/services/canvas.service.ts` deleteCanvas 路径、`src/components/ui/Topbar.tsx`（前端隐藏删除按钮，按 `SHARED_BOARD_IDS`）、`src/lib/board-scope.ts`
- 测试：`tests/h1-canvas-tenant-softdelete.test.ts`、`tests/h4-default-board-private.test.ts`（两种模式下均禁删）
- 相关决策：`docs/adr/0004-strict-tenant-ownership.md`、`docs/adr/0016-admin-strict-canvas-tenancy.md`、`docs/adr/0018-default-board-private.md`（禁删与授权解耦）
- 文档：`docs/specs/H1-画布多租户严格属主制.md`、`docs/specs/2026-09-默认画板禁删.md`
