# ADR-0017: 节点级合并与墓碑语义

- **Status**: Accepted
- **Date**: 2026-09-12
- **Deciders**: 枝想架构组
- **Tags**: sync, concurrency, protocol, canvas

## Context and Problem Statement

画布保存长期是**整板替换**（`DELETE FROM nodes/edges WHERE canvas_id = $1` 后全量重插），冲突控制只有画板级乐观锁（ADR-0008：`expectedUpdatedAt` 落后即 409）。

线上反复出现同一类投诉：**「我在 A 设备改了，回来发现被 B 设备覆盖了」**。机理是：

1. 挂机/离线的设备（半天前打开的标签页）持有旧的全量快照；
2. 它保存时把**整块板**重发一遍——包括它这两小时**根本没碰过**、而另一台设备已经改过的节点；
3. 服务端整板替换，没碰过的节点也被回写成旧值。乐观锁只在「它拿到过更旧的版本号」时才拦得住，而它的版本号恰恰是保存后推进过的，于是照样写成功。

整板替换还把两件事绑死了：

- **删除无法表达**：「我这台设备删了节点 X」在整板语义里等价于「X 不在我的 payload 里」，与「我这台设备根本没见过 X」不可区分。两台设备交替保存会互相复活对方的删除。
- **payload 随画板线性增长**：每次保存都上行全量节点与边（含 messages/grounding 等大字段），150+ 节点板可达数百 KB，移动端弱网下频繁超时，超时又触发放大重试。

诉求：把冲突面从「整块画板」缩到「同一个节点」，让设备只上行**它真的改动过的东西**，并且让**删除可表达且稳定胜出**。

## Decision Drivers

- 用户可见的正确性优先于一切：不许出现「没碰过的节点被别人的保存覆盖」；
- 向后兼容：新老客户端必须能同时在线上跑，服务端不能有版本切换窗口（发布纪律见 ADR-0002/0018 的灰度惯例）；
- 协议要能被**显式分流**，不能靠猜结构（空数组在两种语义下含义正好相反）；
- 删除必须在「删除方 vs. 陈旧重传方」之间稳定收敛，且不能让墓碑无限累积；
- 既有的画板级不变量（严格属主制 ADR-0004/0016、软删防复活、配额）一条都不能破；
- 不引入 CRDT/Yjs 级依赖（与 ADR-0008 的取舍保持一致）。

## Considered Options

- **Option A: 维持整板替换，加强乐观锁**（如每次保存都强制 `expectedUpdatedAt` 严格相等）— 会把「打开后一直没动」的设备变成永远 409，用户被迫刷新；且不解决删除不可表达的根本问题。
- **Option B: 服务端按 `updated_at` 做字段级 LWW 合并** — 不需要客户端参与，但服务端无法区分「这个节点没带 = 没改」还是「没带 = 删了」，仍然解不出删除；且整板 payload 的传输成本一分不减。
- **Option C: CRDT / Yjs** — 真正的自动合并，但引入重型依赖、改变整个画布数据模型与前端渲染路径，且与 ADR-0008 已明确记录的「二期协作场景再考虑」相悖。
- **Option D: 客户端算差分 + 服务端节点级 upsert + 显式墓碑**（已选）。

## Decision Outcome

**Chosen option: "D"**，因为在**不引入新依赖、不改数据模型**的前提下，用「协议版本 + 差分 + 墓碑」三件套精确解决了用户投诉的机理，且老客户端零中断。

### 协议：`protocolVersion` 显式分流

`POST /api/canvases/:id/save` 的请求体带 `protocolVersion`：

| 值 | 路径 | 语义 |
| :--- | :--- | :--- |
| 缺失 / `1` | 整板替换（legacy） | 行为逐字不变：`DELETE` 后重插，`expectedUpdatedAt` 冲突仍 409 |
| `>= 2` | 节点级合并 | 只 upsert 本次带来的节点/边，**未带的一律不动** |

**必须靠显式版本号，不能猜结构**：旧客户端的全量 payload 与新客户端的「本次改动」在结构上无法区分，且空数组在旧客户端是「清空」、在新客户端是「无删除」，语义正好相反。

分流开关 `SAVE_LEGACY_REPLACE_ENABLED`（默认开）：客户端全面切到 v2 并 soak ≥7 天后设为 `"false"`，此后旧 payload 一律 409 `CLIENT_OUTDATED`。该 409 **刻意不带 `latest_updated_at`**——带了旧客户端会「刷新版本号后重发」，进入死循环。

### 合并写入的执行顺序（不可交换）

`mergeWriteCanvas()` 的步骤顺序本身就是语义，换序会破坏正确性：

1. **跨板搬节点拦截**：节点 id 是全局主键，提交携带属于他人画板的节点 id → `ValidationError('NODE_CANVAS_MISMATCH')`（只报 id，不泄露内容）。
2. **环检测叠加服务端存活父映射**：只看 payload 会漏判「新节点 → 服务端既有节点 → 新节点」这类跨批环。
3. **父先于子排序**，父链不可达的节点 `parentId` 置空并记入 `repairedNodeIds`（外键 `parent_id REFERENCES nodes(id)`，父不存在则插入失败）。
4. **节点 upsert**，`ON CONFLICT (id) DO UPDATE ... WHERE nodes.canvas_id = EXCLUDED.canvas_id AND nodes.deleted_at IS NULL`——双重守卫：**删除胜出（墓碑行不得复活）** + 禁止跨板搬节点。被守卫拒绝的行不出现在 `RETURNING` 里，据此算出 `ignoredNodeIds`。
5. **节点墓碑 + 级联边墓碑**（引用被删节点的边一并墓碑）。
6. **显式边墓碑**（`deletedEdgeIds`）。
7. **边 upsert**，端点校验必须对「**服务端存活节点集合**」而非 payload 节点集合——否则 diff 语义下所有「连到未改动节点的新边」都会被误丢（合并模式最容易踩的坑）。存活集合由「写入前存活 − 墓碑 + 本次接受」在内存中推出，不多查一次库。
8. **计数在事务内重算**：合并语义下 payload 长度 ≠ 板内总量。

步骤 4/5 的先后保证了「同一份 payload 里既携带又声明删除的 id 一定以删除收场」。

### 墓碑与定序

- **删除即软删墓碑**：`nodes.deleted_at` / `edges.deleted_at` 非空。读路径一律带 `deleted_at IS NULL`（PG 与内存两分支同口径），墓碑行不回吐给前端。
- **`rev BIGINT` 是行级定序判据**：每次写入 `rev = rev + 1`。行锁下同一行的写入串行，因此 rev 严格递增（`tests/pg/h2-merge-tombstone.pg.test.ts` 锁定）。当前它记录的是**定序证据**——合并路径的 LWW 事实上由「事务提交顺序 + 行锁」决定，`rev` 尚未参与写判定；未来若要做节点级 CAS（客户端带 `baseRev` 上行）可直接复用该列，无需再改 schema。
- **画板级乐观锁在合并路径下刻意不校验**：挂机两小时改一个节点照样会被 409 挡下，用户投诉的机理就没修好。冲突面交给节点级。`title`/`viewport`/`defaultModel` 仍是整字段 LWW（`COALESCE`，缺省 = 本次没改），只有真的改了才上行。
- **`CANVAS_TOMBSTONE_RETENTION_DAYS`（默认 30）** 决定墓碑保留期，由每日清理任务物理回收（`cleanupCanvasTombstones`，**先删边再删节点**——边引用节点，反序会短暂留下悬空引用）。30 天对齐 ADR-0005 的软删冷却口径，且远大于 sync-queue 的退避上限。填 `0` = 全量回收（运维用），**不得在生产随手设 0**。

### 客户端配套

- **必须算真差分**（`src/lib/board-ops.ts`）：把整板当 diff 传等于服务端把每个节点 upsert 一遍，挂机设备照样覆盖它没碰过的节点——正确性才是主因，载荷变小是副产品。
- **基线必须落盘**：id → 投影哈希的「已知与服务端一致」基线。只放内存的话，「离线删了节点 → 刷新」会让该节点既不在 upserts 也不在 `deletedNodeIds` 里，服务端上它静默复活。基线只从两处推进：保存成功（推进为**本次已上行的那份快照**，不是当前画面——飞行期间的编辑要留给下一轮）与从服务端取回画板。
- **投影只覆盖会被持久化的字段**：React Flow 的 `selected`/`dragging`/`measured`/`dimensions`/`positionAbsolute` 不进哈希，否则打开画板时每个节点发一次 dimensions 就等于整板标脏。

### Positive Consequences

- 用户投诉的机理被消除：没碰过的节点不再被别人的保存覆盖，冲突面缩到同一个节点；
- 删除可表达且**稳定胜出**：墓碑 + `deleted_at IS NULL` 守卫让陈旧设备的重传静默失败（`ignoredNodeIds` 可观测），不再复活已删内容；
- payload 与画板规模解耦，弱网/移动端保存显著变小（`bytes` 有线上读数）；
- 老客户端零中断：缺失版本号即走原路径，两条路径并存、互不影响；
- `rev`、`saveMode`、`protocolVersion`、`ignoredNodeIds`、`repairedNodeIds` 提供了翻开关与调保留期的线上依据。

### Negative Consequences

- **协议复杂度上升**：两份写入实现并存，直到 `SAVE_LEGACY_REPLACE_ENABLED=false` 才能删掉 legacy 分支；
- **客户端多了一份必须落盘的状态**（差分基线）：它是正确性依赖，被清掉会退化为一次「整板重传」——所以基线缺失时**绝不**退化成整板 upsert，宁可留在队列里下次续跑；
- **墓碑是长期成本**：GC 之前删除只增不减，必须有保留期与回收任务（阶段 6）；
- **已被接受的风险边界**：墓碑被 GC 之后，超过保留期没联网的设备重传同一节点 id 会被当作**新节点重建**。节点 id 由客户端生成（uuidv7，ADR-0013/`src/lib/uuid.ts`），不可能与他人复用，故影响限于是「这台设备自己把老内容带回来」——30 天保留期即为这个窗口的宽度；
- **空数组语义反转**：老客户端发 `nodes: []` 是「清空整板」，新客户端发它是「本次无改动」。靠显式版本号区分，因此**绝不能让 v2 客户端省略 `protocolVersion`**。

### Follow-up / Mitigation

- 客户端全面切换后（阶段 4a/4b 已上线）观察 `mode=replace` 的占比，归零后翻 `SAVE_LEGACY_REPLACE_ENABLED=false`，再删除 legacy 分支；
- 观测口径（阶段 6）：`[canvas-save] mode= protocolVersion= bytes= ops={} ignored= repaired=` 与两条 409 warn；只记计数与画板 id，节点内容属用户数据不进日志；
- 若二期要做协作，节点级 CAS 可用已在表上的 `rev` 落地，不必再动 schema。

### 残留风险（明确接受）

1. **同一节点的并发编辑**仍是「最后到达服务端者胜」——影响面从整块画板缩到那几个节点，但不会消失（字段级合并不在本次范围）。
2. **墓碑 GC 之后**的陈旧设备可能复活已删节点；30 天保留期远大于 sync-queue 的退避上限（`MAX_RETRIES=5`、`min(2^n·2s, 30s)`），实际不会触发。节点 id 由客户端生成，不可能与他人复用，故影响限于是「这台设备自己把老内容带回来」。
3. **无 schema 版本表**：旧语义（整板 `DELETE`）一旦停止，数据层面无法靠代码回滚还原；墓碑一旦 GC 同样不可逆。**上线与每次翻开关前必须有当日 `pg_dump`**。
4. **绝不能把服务端回滚到「不认识 `protocolVersion`」的构建**：那会把新客户端的差分载荷当整板，清掉设备没碰过的所有节点。发布顺序与回滚副作用见 `docs/部署与回退手册.md` §5.1。

### 明确不做

- **CRDT（Yjs / Automerge / Loro）**：单画板、小团队场景不需要，依赖与元数据开销不划算；
- **属性级 LWW**（Figma 那套）：比节点级更细，但需重构存储，成本高于当前收益，留作后续；
- **「客户端确认前不写本地库」**：与乐观 UI 冲突，会直接变成用户报的「卡」；
- **运行时数据库触发器**：与显式 `NOW()` 冗余，且会重新引入新旧库结构差异风险。`initDbSchema()` 不创建任何触发器，`trigger_set_timestamp()` 只存在于设计稿 `docs/数据库建表脚本.sql`。

## Pros and Cons of the Options

### Option A: 整板替换 + 更强乐观锁

- **Good**：零改动
- **Bad**：不解决删除不可表达；「打开未编辑」的设备被迫永远 409；payload 成本不减

### Option B: 服务端字段级 LWW 合并

- **Good**：客户端零改动
- **Bad**：服务端无法区分「没带 = 没改」与「没带 = 删了」，删除仍然解不出；传输成本不减

### Option C: CRDT / Yjs

- **Good**：自动合并；天然适合多人实时协作
- **Bad**：重型依赖 + 数据模型重写；当前产品是「个人多设备」而非「多人同时编辑」，收益不匹配成本

### Option D: 差分 + 节点级 upsert + 墓碑（已选）

- **Good**：精确解决机理；老客户端零中断；不引入依赖；删除稳定收敛
- **Bad**：两份写入实现并存；客户端多一份必须落盘的正确性状态；墓碑需 GC

## References

- 代码：`server/repositories/canvas.repository.ts`（`mergeWriteCanvas` / `saveCanvas` 分流 / `cleanupCanvasTombstones`）、`server/routes/canvases.ts`（zod schema 与观测日志）、`server/core/schema.ts`（`rev` / `deleted_at` 列）、`src/lib/board-ops.ts`（差分与基线）、`src/lib/storage.ts`（上行 payload）
- 开关：`.env.example` 的 `SAVE_LEGACY_REPLACE_ENABLED`、`CANVAS_TOMBSTONE_RETENTION_DAYS`
- 测试：`tests/h2-canvas-merge.test.ts`（内存分支合并/墓碑/GC）、`tests/pg/h2-merge-tombstone.pg.test.ts`（真库 rev 递增与墓碑守卫）、`tests/pg/s6-tombstone-gc.pg.test.ts`（真库保留期回收）
- 相关决策：`docs/adr/0008-sync-state-machine.md`（状态机与乐观锁，本 ADR 缩小其冲突面）、`docs/adr/0005-soft-delete-with-30d-cooldown.md`（墓碑保留期对齐）、`docs/adr/0013-frontend-node-id-truncation.md`（节点 id 由客户端生成——本 ADR「GC 后重传 = 真实重建」边界的前提）、`docs/adr/0018-default-board-private.md`（本 ADR 使共享默认板从「覆盖竞争」升级为「跨租户稳定混合」，是该 ADR 的动因）
- 需修订：`docs/adr/0008-sync-state-machine.md`（409/整板冲突的表述）
