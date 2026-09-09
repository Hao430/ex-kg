# ADR-0013: 节点 ID 前端生成 + 截断前缀 24 字符

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: persistence, data-contract, frontend

## Context and Problem Statement

画布节点 ID 需**全局唯一**且**长度受限**：

- PG `nodes.id` / `edges.id` / `canvases.id` 都是 `VARCHAR(64)`；
- 前端节点 ID 当前格式：`node-${parentId}-${time}-${counter}-${rand}`；
- 深层级画布（深度 > 5）：`parentId` 是完整节点 ID 拼进前缀，**总长度超 64 触发 PG 22001 错误**；
- 实测：深度 10 的画布保存时，PG 报 `value too long for type character varying(64)`。

## Decision Drivers

- 前端生成 ID 体验更好（无须等服务器响应）；
- 唯一性靠 `time + counter + rand` 保证（已实测无碰撞）；
- 长度约束在客户端做兜底（在 ID 生成函数截断）；
- 业务字段（`title / question`）不受影响。

## Considered Options

- **Option A: 后端生成 ID**（每次创建调 API）
- **Option B: 前端生成 + 截断前缀**（已选）
- **Option C: 改 PG 列宽**（如 `VARCHAR(255)`）
- **Option D: 改用 UUID**（统一后端风格）

## Decision Outcome

**Chosen option: B**, because 截断前缀**只损失语义、不影响唯一性**（`time+counter+rand` 已保证唯一），且改动最小、向后兼容已有数据。

### 实现

```typescript
// src/components/canvas/DeepDiveCanvas.tsx:41-50
export const generateUniqueId = (prefix: string = 'node'): string => {
  globalIdCounter += 1;
  const time = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  // 截断前缀到 24 字符（PG VARCHAR(64) 兜底）
  const safePrefix = prefix.length > 24 ? prefix.slice(0, 24) : prefix;
  return `${safePrefix}-${time}-${globalIdCounter}-${rand}`;
};
```

### Positive Consequences

- 前端无须等服务器生成 ID，画布拖拽/创建即时响应；
- 截断后**总长度 < 64 字符**（`24 + 1 + 13 + 1 + 10 + 1 + 6 = 56`）；
- 唯一性不损失（`time + counter + rand` 已足够）；
- 向后兼容（已有数据 ID 不变）。

### Negative Consequences

- ID 的前缀**部分丢失语义**（深度信息被截断）；
- 调试时 ID 不如 UUID 直观；
- 整个项目 ID 风格不统一（users=UUID，canvases/nodes/edges=VARCHAR(64)）—— 见技术债清单 §P0 ID 风格不统一。

### Follow-up / Mitigation

- 二期可统一为 UUID（后端生成 + 前端短引用）；
- 截断逻辑应有单测（边界 24/25/100 字符）；
- 监控保存失败的 22001 错误率（应 0）。

## Pros and Cons of the Options

### Option A: 后端生成

- **Good**: UUID 统一；语义清晰
- **Bad**: 拖拽/创建需等服务器；失去即时性

### Option B: 前端生成 + 截断（已选）

- **Good**: 即时；改动小；向后兼容
- **Bad**: 调试不直观；ID 风格不统一

### Option C: 改 PG 列宽

- **Good**: 简单
- **Bad**: 治标不治本；深层级仍可能超

### Option D: 改用 UUID

- **Good**: 标准
- **Bad**: 二期工作量大

## References

- 代码：`src/components/canvas/DeepDiveCanvas.tsx:41-50`
- 文档：`docs/specs/2026-09-节点ID前缀截断.md`
