# ADR-0018: 默认画板私有化——移除最后一个跨租户放行

- **Status**: Accepted
- **Date**: 2026-09-12
- **Deciders**: 枝想架构组
- **Tags**: security, multi-tenancy, sync, default-board

## Context and Problem Statement

ADR-0004 确立严格属主制，保留的唯一放行是全局共享默认画板：`default-board` / `default-canvas` 是所有用户首屏共用的**同一行**，任何登录用户都能读写。当时的前提是「整板替换」写入语义——最坏结果是互相覆盖，虽然已经是跨租户写入，但读到的是「最后写的那份」。

节点级合并上线（ADR-0017）后语义变了：A 的保存不再删除 B 的节点，**两边的节点会稳定共存**在同一行里。于是这条放行从「覆盖竞争」升级为：

- **持续跨租户读**：任何用户打开首屏就会看到其他用户创建的节点（不是残留，而是持续累积）；
- **稳定混合写入**：多个用户的节点在同一画板内长期共存，谁也无法清理对方的；
- 与 ADR-0016 刚确立的「画布数据严格属主制（admin 亦不例外）」直接冲突——收掉了 admin 例外，却留着一条人人可用的共享通道。

诉求：把 `default-board` 从「全局共享草稿区」收口为**首个认领者的普通画板**，授权路径上不再有任何放行。

## Decision Drivers

- 承诺一致性：ADR-0016 之后，画布放行点必须收敛到零；
- 默认板的内容会持久累积他人数据，不能靠「用户看不见」糊过去；
- 存量内容**不能默默丢**：老用户本地/服务端已有 `default-board` 内容，切过去必须能带走；
- 灰度安全：翻开关那一刻不能打断正在编辑的旧标签页；
- 禁删本身要保留（代价为零），但它与授权应当解耦。

## Considered Options

- **Option A: 保持共享，只做前端隔离** — 客户端各自渲染自己的节点。服务端仍是同一行，隔离靠客户端自觉，等于没有隔离。
- **Option B: 每用户私有默认板 + 公开 id 虚拟映射**（`default:<userId>`）— 对外仍叫 `default-board`，服务端翻译成内部 id。兼容性最好，但 id 翻译要覆盖约 10 个调用点，且要防内部 id 泄漏到响应。
- **Option C: 认领即私有 + 客户端改用新 id**（已选）— `default-board` 退化为一个普通画板 id，谁先保存谁拥有；客户端不再硬编码它，需要新板时生成新 id。

## Decision Outcome

**Chosen option: "C"**，因为隔离强度最高（服务端零放行，不依赖任何 id 翻译的正确性），且与「客户端已有游客草稿认领机制」这条现成通道吻合，不需要新建映射层。

### 具体范围

| 位置 | legacy（默认） | private |
| :--- | :--- | :--- |
| `getCanvas` 非属主 | 200（共享行） | 404 |
| `saveCanvas` 非属主 | 200（写入共享行） | 403 `CANVAS_FORBIDDEN` |
| `PATCH /meta` 非属主 | 403（共享板整体禁改） | 403/404（与普通他人画板同口径） |
| `PATCH /meta` 属主 | 403（影响他人，禁改） | 200（就是自己的板） |
| `DELETE` 任何人 | 403（禁删） | 403（禁删） |
| chat 归因 / 配额 `canvasId` | 放行 | 与普通画板同口径 |

实现上，授权路径全部继续走 `isSharedDefaultCanvas()`，它变成**随模式切换的开关**；新增 `isDefaultCanvasPublicId()` 只用于「禁删」与 id 判定（与授权解耦，两种模式都禁删）。

**「未认领」= 行不存在**：服务端不 seed 默认板，行由首个保存者 upsert 创建并认领，因此**不需要** `ALTER COLUMN user_id DROP NOT NULL`。

**客户端配套**（发布顺序要求客户端先行，阶段 5b）：
- 新画板一律生成 uuidv7，不再硬编码 `default-board`（启动引导占位 / 新建画板 / 删空后的兜底）。空白账号的占位板要等服务端确认「一块都没有」后才落地，离线不凭空多出画板；
- **「共享」标记改由服务端给**：列表接口回传 `isShared`（= `isSharedDefaultCanvas(id)`，随模式切换），客户端据此决定是否给出收藏/归档/分组入口。此前客户端拿公开 id 集合（`SHARED_BOARD_IDS`）自行判断，private 模式下会把**认领者自己的**默认板当成共享板、锁掉这些入口（与服务端 200 的判定相矛盾）。该 id 集合只保留「禁删」用途——那是 `isDefaultCanvasPublicId`，与模式无关。
- `default-board` **不可访问（404/403）**且本地确有内容时，把它整份搬成一块自己的新板并排队上传（`src/lib/board-migrate.ts`）：**只有服务端明确拒绝才搬**——服务端仍可读时什么都不做（legacy 共享期是空操作，否则会把共享板复制成一堆副本）；离线 / 401 / 5xx 不打标记、下次启动重试；本地只剩引导态则直接摘掉旧引用，交给调用方给一块新画布。按账号一次性幂等标记，与游客认领同形状，但**必须换新 id**（沿用 `default-board` 等于去抢那行共享板）；

### Positive Consequences

- 画布授权放行点归零：ADR-0016 收敛后的最后一条通道关闭，隔离承诺与实现完全一致；
- 跨租户节点混合累积停止，历史混合内容随各自认领被切分；
- `default-board` 变成普通画板，节点级合并、墓碑、GC 等机制对它一视同仁，不再有特例分支。

### Negative Consequences

- **`default-board` 的语义变更影响存量用户**：它从「全局共享草稿区」变成「首个认领者的普通画板」，其他人的首屏改为各自的新板；需要一次性内容认领，做不好就是用户内容凭空消失；
- ADR-0012（默认画板禁删）的原始动机（"全局共享画板删除会锁死所有用户"）随之失效——禁删保留，但理由改为「公开 id 被客户端硬编码引用，软删会让这些引用永久 404」；
- 切换必须**客户端先行 + soak ≥7 天**：窗口期内仍在跑旧客户端的标签页会在保存时 403，而不是像 legacy 那样静默写入共享行；
- 翻开关前必须有当日 `pg_dump`：一旦有用户写入私有默认板，翻回 legacy 会让这些内容「消失」（改为读写共享行）。

## References

- 代码：`server/repositories/canvas.repository.ts`（`isDefaultCanvasPublicId` / `isSharedDefaultCanvas` / 列表回传 `isShared`）、`src/components/ui/BoardLibraryModal.tsx`（shared 与 undeletable 两个判据）、`server/services/canvas.service.ts`、`server/middleware/quota.ts`、`src/App.tsx`（新板 id 生成与不可访问回退）、`src/lib/board-migrate.ts`（存量内容再落位）、`src/lib/board-store.ts`（`dropLocalEntry`）、`src/lib/board-scope.ts`（游客草稿认领、迁移幂等标记）
- 开关：`.env.example` 的 `SAVE_DEFAULT_BOARD_MODE`（`legacy` 默认 / `private`）
- 测试：`tests/h4-default-board-private.test.ts`（private 模式）、`tests/h1-canvas-tenant-softdelete.test.ts`（legacy 共享回归）、`tests/board-migrate.test.ts`（存量再落位）
- 前置决策：`docs/adr/0004-strict-tenant-ownership.md`（本 ADR 移除其唯一放行）、`docs/adr/0016-admin-strict-canvas-tenancy.md`、`docs/adr/0017-node-level-merge-and-tombstones.md`（节点级合并，本 ADR 的动因）
- 已同步修订：`docs/adr/0012-default-canvas-no-delete.md`（禁删理由改写，2026-09-12）
