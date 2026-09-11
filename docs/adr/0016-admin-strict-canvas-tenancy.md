# ADR-0016: 画布数据严格属主制收口——移除 admin 例外

- **Status**: Accepted
- **Date**: 2026-09-11
- **Deciders**: 枝想架构组
- **Tags**: security, multi-tenancy, idor, admin

## Context and Problem Statement

ADR-0004 确立多租户严格属主制，但保留了一句「读/写/删只允许属主本人**或 admin**」。该 admin 例外随后被扩散到画布列表、单读、保存、删除、meta、分享、chat 归因与配额归属查询——`role === 'admin'` 一旦为 true 就跳过 `user_id` 过滤。

直接后果：管理员登录普通 App 时，`GET /api/canvases` 返回**全站所有用户的画板**并混入他自己的画板库/顶栏下拉；按 id 还能读写删任意用户画布、以他人画板作 chat 归因、查看他人画布节点配额。这与对外承诺的「数据按用户严格隔离」相矛盾。

诉求：管理员应是**运营角色**（看聚合统计与日志、管理用户/订单/模型），而不是可以读取用户内容的超级用户。仅对**列表**收权不足以消除跨租户读取面，需一次性移除全部属主放行。

## Decision Drivers

- 对外承诺「数据按用户严格隔离」必须与实现一致；
- 最小权限：admin 的运营需求（统计/日志/用户管理）**不需要**画布内容；
- 消除隐式旁路，缩小 IDOR 审计面（放行点越少越安全）；
- 保持共享默认板（`default-board`）的全局体验与既有语义不变；
- 保留 admin 的**配额额度**（不限画板/节点）——这是权限额度，不是数据访问。

## Considered Options

- **Option A: 维持 admin 全域放行** — 保留现状 + 补审计。
- **Option B: 只收列表** — `GET /api/canvases` 恒按属主过滤，保留按 id 的 admin 单板放行用于排障。
- **Option C: 全面移除画布属主放行**（已选） — admin 与普通用户同口径；运营台只保留聚合统计与日志。

## Decision Outcome

**Chosen option: "C"**, because 只有彻底移除才对得起「严格隔离」的承诺；B 仍保留「知道 id 即可读内容」的确定通道，且 id 可从日志侧获得，隔离不成立。

### 具体范围

移除 admin 属主放行（admin 走与非属主完全相同的错误语义）：

| 操作 | 非属主/admin 结果 |
| :--- | :--- |
| `GET /api/canvases`（列表） | 仅返回本人画板 |
| `GET /api/canvases/:id` | 404 NOT_FOUND（不泄露存在性） |
| `POST /api/canvases/:id/save` | 403 CANVAS_FORBIDDEN（软删 404） |
| `DELETE /api/canvases/:id` | 403 CANVAS_FORBIDDEN |
| `PATCH /api/canvases/:id/meta` | 403 CANVAS_FORBIDDEN |
| `POST/DELETE /api/canvases/:id/share` | 403 CANVAS_FORBIDDEN |
| chat 以他人画布归因 | 404 NOT_FOUND |
| `GET /api/quota?canvasId=他人` | 404 NOT_FOUND |
| `POST /api/canvases/:id/auto-title`（本次顺带收紧） | 他人**已保存**画布 404；未保存画布仍放行 |

实现上直接**删除仓储层的 `isAdmin` 参数**（`canvas.repository.ts` 的 list/get/save/delete/updateMeta），并顺带把 `listCanvases/getCanvas` 的 `userId` 由可选收紧为**必填**，消除「无 userId 即返回全部」的潜在旁路。admin 保留：配额额度（`plan='admin'`）、`/api/admin/*` 聚合统计与日志、admin-only API 网关、以及作为普通用户对共享默认板的读写。

### Positive Consequences

- 「数据按用户严格隔离」对 admin 也成立，实现与对外承诺一致；
- 画布放行点收敛到**唯一**的 `isSharedDefaultCanvas()`，IDOR 审计面最小；
- 仓储层不再有 `isAdmin` 分支，权限逻辑单点、易验证。

### Negative Consequences

- admin 失去「按 id 直达用户画板」的排障/客服能力；
- 前端无变化，但 admin 自己的画板库会收窄为本人画板（预期行为）。

### Follow-up / Mitigation

- 若日后确需运维查看用户内容，另建**独立、显式、带审计**的运维入口（写 `user_audit_logs`），而非恢复隐式放行；
- 越权矩阵模板 `tests/authz-matrix.template.ts` 与 `docs/安全发布checklist.md` §1 已同步为「admin 不例外」；
- 本 ADR 部分修订 ADR-0004：仅移除其中的 admin 例外，其余（默认画板共享、默认板禁删、软删语义）继续有效。

### 同日跟进：两处残留读取通道（2026-09-11）

本 ADR 落地后的复查又发现两条**非属主放行、但同样绕过属主制读取内容**的通道，已一并封堵：

| 通道 | 机制 | 处置 |
| :--- | :--- | :--- |
| 审计日志回显分享码 | `share_create` 把 `shareCode` 写入 `user_audit_logs.details`，admin 经 `/api/admin/audit-logs` 收集任意用户的活跃分享码，再走公开读取得该画布快照 | 写入侧不再落 `shareCode`（归属由 `target_id` 锚定）；读取侧对历史存量行脱敏（`audit.repository.ts` 的 `redactAuditDetails`） |
| 节点检索可省略属主 | `searchNodes(queryText, canvasId?, userId?)` 的 `userId` 可选，省略时 SQL 走 `$n::uuid IS NULL` 放行分支，退化为**全站检索**；当时唯一调用方均传值，属潜在旁路 | `userId` 收紧为必填，SQL 与内存分支均无 NULL 放行（`searchUserNodes` 同步） |

两条均已补回归测试（`tests/k2-share.test.ts` 断言审计不回显分享码；`tests/s1-data-isolation.test.ts` 断言非属主/admin 检索他人画板恒为空），并把模式固化进 `docs/安全发布checklist.md` §1。

## Pros and Cons of the Options

### Option A: 维持 admin 全域放行

- **Good**: 运维方便
- **Bad**: 与隔离承诺矛盾；跨租户读取面长期存在

### Option B: 只收列表

- **Good**: 改动小
- **Bad**: 仍可按 id 读取任意内容；隔离名不副实

### Option C: 全面移除（已选）

- **Good**: 承诺一致、审计面最小、权限单点
- **Bad**: 失去 ad-hoc 排障能力，需要时另建审计入口

## References

- 代码：`server/repositories/canvas.repository.ts`、`server/services/canvas.service.ts`、`server/services/share.service.ts`、`server/routes/canvases.ts`、`server/routes/quota.ts`、`server/middleware/quota.ts`
- 前置决策：`docs/adr/0004-strict-tenant-ownership.md`（本 ADR 移除其 admin 例外）
- 规则：`CODEBUDDY.md` 画布访问权限（H1）条目、`docs/安全发布checklist.md` §1、`tests/authz-matrix.template.ts`
