# ADR-0008: 同步状态机 + 乐观锁

- **Status**: Accepted（2026-09-12 修订：画布保存冲突面收窄，见下）
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: frontend, sync, conflict-resolution, optimistic-lock

## Context and Problem Statement

画布是用户高频编辑的对象，**保存冲突**不可避免：

- 同一画布双标签页同时编辑；
- 移动端 + 桌面端同时改；
- 断网期间编辑后恢复网络；
- 浏览器崩溃后重新打开。

旧实现（`localStorage` 直存）会让**最后一次保存覆盖前面的所有改动**——这是用户视角的"数据丢失"。

> **2026-09-12 修订（ADR-0017/0018）**：本 ADR 描述的**状态机本身仍然有效**——`pending/saved/conflict/fail` 四态、指数退避、`online` 事件驱动、删除确认制全部沿用。变的是**冲突的来源**：
>
> - 画布保存已改为**节点级合并**（ADR-0017）。合并路径下服务端**刻意不校验画板级乐观锁**，`CANVAS_SAVE_CONFLICT` 只在旧协议的整板替换路径上出现（老客户端），并随 `SAVE_LEGACY_REPLACE_ENABLED=false` 一起退场。冲突面从「整块画板」缩到「同一个节点」，用户看到的 409「请刷新后重试」因此大幅减少——那正是本 ADR 记为 Negative 的「冲突时只能留一份」在实际使用中的主要痛点。
> - 用户投诉的「改完被云端覆盖」不是本状态机的 bug：状态机正确地把本地改动送了上去，是服务端的**整板替换**语义把没碰过的节点一起回写了。修在协议层，不在状态机层（ADR-0017）。
> - `default-board` 私有化（ADR-0018）后，保存可能因**非属主**而 403（`CANVAS_FORBIDDEN`）。客户端把它归入**永久失败**（`conflict`，不进指数退避），并按「不可访问」处理——迁移本地存量到自己的新画板并改绑，见 `src/lib/board-migrate.ts`。这类失败重试永远不会成功，塞进队列只会变成重试风暴。

## Decision Drivers

- 保存失败/冲突必须有**显式状态**让前端知道；
- 断网期间编辑不能丢，恢复后自动补传；
- 冲突不静默覆盖，要让用户决策；
- 状态机要**框架无关**（便于单测）；
- 重试策略：失败可重试，冲突不重试（冲突由 UI 处理）。

## Considered Options

- **Option A: 简单定时保存**（last-write-wins）
- **Option B: 版本号乐观锁**（`updated_at` 比较）
- **Option C: 同步状态机 + 乐观锁**（已选）
- **Option D: CRDT / Yjs**（操作合并）

## Decision Outcome

**Chosen option: C**, because 状态机 + 乐观锁的组合在不引入 CRDT 重型依赖的前提下，**解决了 90% 的保存冲突场景**（断网重连 + 双标签页），CRDT 是更进一步的演进方向。

### 状态机

```
pending  ── flush ok ──▶  saved
   │                       (3s 后回退 idle)
   │
   ├── flush conflict ──▶  conflict  (派发 deepdive:canvas-save-conflict)
   │                                （ADR-0017 后仅旧协议整板路径会出现；冲突不重试）
   │
   ├── flush 403/404 ──▶  conflict（永久失败，不重试）
   │                      403 = 配额/权限（提示升级，保留草稿）；404 = 幽灵板收敛，停重试风暴
   │
   └── flush fail ──▶  fail  (指数退避重试 min(2^n × 2s, 30s))
                          超过 MAX_RETRIES=5 → error
```

### Discipline

- `inFlight` Set 防止并发双跑；
- `window 'online'` 事件触发立即 flush；
- 删除是**确认制**：仅 2xx/404 才清本地 + `dequeue(boardId)`，**防止被自动保存写回复活**；
- 403/断网保留本地并返回 `{ok:false}`，由 App 提示。

### Positive Consequences

- 状态机框架无关，可单测；
- 指数退避 + online 事件驱动，自动恢复；
- 冲突派发事件，UI 有机会决策（合并 / 覆盖 / 放弃）；
- 乐观锁靠 `updated_at` 比较，无须额外字段。

### Negative Consequences

- **不是 CRDT**：冲突时只能"留一份"，不能"自动合并"——ADR-0017 把这个"一份"的单位从整块画板缩小到一个节点，但同一节点的并发编辑仍是有一次写入被覆盖（无字段级合并、无 `rev` 参与的 CAS）；
- 状态机与 `App.tsx` 耦合较紧，UI 状态散落（见技术债清单 §前端可改进）；
- 状态机本身无 vitest 单测（仅集成测试覆盖）。

### Follow-up / Mitigation

- 同一节点的并发编辑若要"不丢"，需要在协议里带上 `baseRev` 做节点级 CAS——`nodes.rev` / `edges.rev` 两个列已经存在且严格递增（ADR-0017），届时不必再改 schema；
- 二期"团队协作"场景应升级到 CRDT（Yjs / Automerge）；
- 增加 `sync-queue` 的 vitest 单测；
- 暴露状态机事件给 `useCanvasUIState` 集中管理。

## Pros and Cons of the Options

### Option A: 简单定时保存

- **Good**: 极简
- **Bad**: 冲突静默覆盖；断网即丢

### Option B: 乐观锁

- **Good**: 防覆盖
- **Bad**: 冲突无 UI 引导

### Option C: 状态机 + 乐观锁（已选）

- **Good**: 状态显式；自动重连；冲突有 UI
- **Bad**: 不是 CRDT；前端耦合

### Option D: CRDT

- **Good**: 自动合并；适合协作
- **Bad**: 引入 Yjs；模型复杂度上升；学习成本

## References

- 代码：`src/lib/sync-queue.ts`、`src/lib/storage.ts`、`src/lib/board-ops.ts`（差分与基线，ADR-0017）、`src/components/canvas/DeepDiveCanvas.tsx`
- 相关决策：`docs/adr/0017-node-level-merge-and-tombstones.md`（冲突面收窄到节点，本 ADR 的上游变更）、`docs/adr/0018-default-board-private.md`（403/404 终态）
- 文档：`docs/specs/A4-乐观锁冲突检测.md`、`docs/specs/A5-断网重试队列与同步状态.md`、`docs/specs/A6-冲突自愈与未登录草稿合并.md`
