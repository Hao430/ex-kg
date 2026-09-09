# ADR-0008: 同步状态机 + 乐观锁

- **Status**: Accepted
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

- **不是 CRDT**：冲突时只能"留一份"，不能"自动合并"；
- 状态机与 `App.tsx` 耦合较紧，UI 状态散落（见技术债清单 §前端可改进）；
- 状态机本身无 vitest 单测（仅集成测试覆盖）。

### Follow-up / Mitigation

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

- 代码：`src/lib/sync-queue.ts:1-165`、`src/lib/storage.ts`、`src/components/canvas/DeepDiveCanvas.tsx:78-90`
- 文档：`docs/specs/A4-乐观锁冲突检测.md`、`docs/specs/A5-断网重试队列与同步状态.md`、`docs/specs/A6-冲突自愈与未登录草稿合并.md`
