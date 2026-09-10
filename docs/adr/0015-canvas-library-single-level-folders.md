# ADR-0015: 画板管理采用「检索 + 收藏/归档 + 单层分组」，拒绝任意层级文件夹树

- **Status**: Accepted
- **Date**: 2026-09-10
- **Deciders**: 枝想架构组
- **Tags**: data-model, sync, frontend, ux

## Context and Problem Statement

画板数量增长后管理体感变差：列表是扁平的 `ORDER BY updated_at DESC`（`server/repositories/canvas.repository.ts:47`），前端只有顶栏一个 `w-64 / max-h-52` 下拉（`src/components/ui/Topbar.tsx:283`），无搜索、无排序、无分组；免费版封顶 3 块（`server/services/quota.service.ts:5`），因此「画板多」几乎只发生在 VIP/Admin 身上。需要一套可扩展的画板管理模型。

数据模型已有可复用资产：`canvases.is_favorite` / `is_archived` 列已建、`tags` / `canvas_tags` 表已建但一期全部空壳未启用（`server/core/schema.ts:88-89,267-285`，`docs/技术债清单.md:55`）。二期规划已把「标签 + 全文检索」列为留存引擎并排在第 5 项（`docs/里程碑与分期规划.md:158`）。前端列表为 local-first：`board-store` 是唯一真相，`sync-queue` 持久化离线意图（`src/lib/board-store.ts`、`src/lib/sync-queue.ts`）。任何新管理维度都必须兼容离线与跨设备，不能破坏现有同步状态机。

核心判断：用户痛点本质是**找不到**，而非**分不开**。文件夹强制「单归属 + 预先建目录」，在中小规模下收益低于成本（典型「文件夹荒废」）。

## Decision Drivers

- **体感收益**：解决「找不到」，而非制造分类维护负担。
- **实现风险**：`board-store` / `sync-queue` 是刚重构完的敏感链路，改动越大回归面越广。
- **路线一致性**：不得与已立项的二期「标签 + 全文检索」形成两套并存的分类模型。
- **迁移成本**：复用已建列/表，schema.ts 走 additive `ADD COLUMN IF NOT EXISTS` 自愈路径。
- **local-first 完整性**：离线/跨设备语义不能倒退。
- **商业价值**：画板多的是付费用户，管理能力可作 VIP 体验的一部分。

## Considered Options

- **Option A: 仅加强扁平检索** — 搜索 + 排序，不引入任何分类维度。
- **Option B: 收藏 + 归档 + 画板库页** — 复用 `is_favorite` / `is_archived`，独立的可检索管理页，无层级。
- **Option C: B + 单层分组（folder）** — 在 B 之上加单归属、不可嵌套的分组。
- **Option D: 任意层级文件夹树** — 可嵌套的目录树。
- **Option E: 标签 + 全文检索** — 已立项的二期路线，多归属、可多维检索。

## Decision Outcome

**Chosen option: "Option C"**（分两阶段：先 B 后分组），因为它在解决「找不到」的同时给出用户熟悉的「分组」心智，复用既有列/表、迁移成本最低，且不取代二期标签路线。**Option D 明确拒绝**：嵌套层级会显著放大移动/删除的级联语义与离线性复杂度，收益在可预见规模内不成立。**Option E 保留并共存**：分组负责单归属导航，标签负责多维检索，两者语义分工，分组不阻塞标签落地。

### Positive Consequences

- 复用 `is_favorite` / `is_archived`，Phase 1 零新建表；Phase 2 仅新增 `folders` 表 + `canvases.folder_id`。
- 单层单归属，UI 直观；文件夹删除只解除归属，不触碰画板内容，风险面小。
- 集合型查询（收藏/归档/分组）可在前端内存完成，离线可用。
- 与二期标签不冲突：`tags` 仍按原排期激活。

### Negative Consequences

- 单层不可嵌套，重度分类用户可能觉得不够。
- 与标签语义存在重叠，需要产品口径文档，否则用户困惑「该用分组还是标签」。
- 前端同步层需要新增 `meta` 意图（收藏/归档/移动），`sync-queue` 需从「一板一任务」升级为「一板多操作」，是本决策的主要实现风险。
- 文件夹 CRUD 首版按「在线优先」交付，离线不可新建/改名/删除分组（移动画板仍可离线）；完整离线 CRUD 为后续项。

### Follow-up / Mitigation

- 写 Spec L1 锁定数据模型、双模仓储、同步扩展点与测试矩阵（`docs/specs/L1-画板库与单层分组.md`）。
- 分组/标签边界写入需求文档：**分组 = 导航（单归属），标签 = 检索（多归属）**。
- 监控人均画板数与分组使用率；若分组使用率长期低迷，走 ADR 复审，保留收藏/归档/检索。
- 归档**不释放**配额，防止「归档即变相扩容」。

## Pros and Cons of the Options

### Option A: 仅加强扁平检索

- Good: 改动最小，无数据模型变更；直接命中「找不到」。
- Bad: 无法满足用户明确提出的「分组」诉求；画板到几十块后仍缺结构。

### Option B: 收藏 + 归档 + 画板库页

- Good: 复用已建列；收藏置顶 + 归档收纳 + 搜索已覆盖绝大多数增长场景；风险低。
- Bad: 没有层级，用户主动归类诉求未被满足。

### Option C: B + 单层分组

- Good: 兼顾检索与归类；单归属语义简单；不级联删画板。
- Bad: 同步层需支持 `meta` 意图；与标签有语义重叠需治理。

### Option D: 任意层级文件夹树

- Good: 表达力最强，重度用户上限高。
- Bad: 子文件夹移动/删除/跨层级的级联与离线对账复杂度和缺陷面显著上升；当前规模下投入产出比不成立。

### Option E: 标签 + 全文检索

- Good: 多归属、可组合筛选，是已论证的留存引擎。
- Bad: 是二期既定项，单独提前会打乱排期；不含「导航式」分组心智。

## References

- `server/repositories/canvas.repository.ts:28-79`（扁平列表查询）
- `src/components/ui/Topbar.tsx:225-362`（现有画板下拉）
- `server/core/schema.ts:78-103,266-285`（canvases 列、tags 空壳表）
- `src/lib/board-store.ts`、`src/lib/sync-queue.ts`（local-first 列表与离线队列）
- `docs/里程碑与分期规划.md:152-166`（二期标签 + 全文检索排期）
- `docs/adr/0008-sync-state-machine.md`（同步状态机）
- `docs/specs/L1-画板库与单层分组.md`（实施 spec）
