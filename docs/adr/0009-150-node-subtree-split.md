# ADR-0009: 150+ 节点子树剥离

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: frontend, performance, ux

## Context and Problem Statement

枝想画布是"无限画布"——理论上节点数无上限。但实际：

- DOM 节点超 150 时**重绘开销指数级上升**（React Flow SVG 连线计算 + DOM 节点布局）；
- 单画板节点数 > 150 时，浏览器主线程被画布占据，AI 推演输入卡顿；
- 用户视角：画布"越用越卡"，不知道是浏览器问题还是产品问题。

## Decision Drivers

- 不硬性限制画布大小（违反"无限画布"产品定位）；
- 提示用户主动拆分（不替用户做主）；
- 拆分要**保留子图**——子图应能独立成新画板继续探索；
- 算法要稳定（环检测、不漏节点）。

## Considered Options

- **Option A: 硬性限制 150 节点**（超出禁止保存）
- **Option B: 自动拆分**（不提示）
- **Option C: 阈值提示 + 手动拆分**（已选）
- **Option D: 虚拟化渲染**（只渲染视口内节点）

## Decision Outcome

**Chosen option: C**, because 它在保留"无限画布"定位的同时，**给用户可见的降级路径**。150 是经验值，待性能回归测试后可能调整。

### 核心算法（`extractSubtree`）

```typescript
function extractSubtree(rootNodeId, nodes, edges) {
  const descendantIds = new Set([rootNodeId]);
  let added = true;
  while (added) {
    added = false;
    for (const edge of edges) {
      if (descendantIds.has(edge.source) && !descendantIds.has(edge.target)) {
        descendantIds.add(edge.target);
        added = true;
      }
    }
  }
  // ...节点 + 边两端都在子树的归入新画板
}
```

### 复杂度

- 最坏 `O(N×E)`，最好 `O(N+E)`；
- 当前 N≤150、E≤N×2 场景约 30k 次比较，可接受。

### Positive Consequences

- 用户主动拆分，保留探索上下文；
- 算法稳定（环检测见 follow-up）；
- 子图导出为独立画板后，主画布 DOM 内存立即释放。

### Negative Consequences

- **150 是经验值**，没有正式 benchmark（见技术债清单 §前端可改进）；
- 算法无环检测：PG `nodes.parent_id` 无 CHECK 约束、代码无 visited set，**理论可自指成环导致死循环**（已记入 P0，见技术债清单）；
- 拆分是**手动触发**，用户可能忽略提示。

### Follow-up / Mitigation

- 加 `nodes.parent_id CHECK (id != parent_id)`；
- `extractSubtree` 维护 visited set 防环；
- 性能基线 benchmark（150 节点剥离耗时 < 100ms）；
- 拆分引导横幅加 A/B 测试，找到最合适的触发阈值。

## Pros and Cons of the Options

### Option A: 硬性限制

- **Good**: 强制
- **Bad**: 违反产品定位；用户挫败

### Option B: 自动拆分

- **Good**: 透明
- **Bad**: 用户失去上下文；算法不透明

### Option C: 阈值提示 + 手动拆分（已选）

- **Good**: 用户决策；保留上下文
- **Bad**: 阈值经验值；可能忽略

### Option D: 虚拟化渲染

- **Good**: 极致性能
- **Bad**: 实现复杂；React Flow 支持有限

## References

- 代码：`src/components/canvas/DeepDiveCanvas.tsx:78-90`、算法实现位于 `src/lib/layout.ts`
- 文档：`docs/技术架构文档.md` §4.1、`README.md` §3
