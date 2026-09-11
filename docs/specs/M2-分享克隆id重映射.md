# Spec M2 — 分享克隆 id 重映射修复

> 来源：M1 实施中发现的隐患工单（分享克隆直通快照 node id）
> 状态：已实施（2026-09-11）
> 关联：M1 JSON 导入、K6 分享克隆、H1 属主制、ADR-0013

## 1. 问题

`tryCloneSharedBoard`（`src/App.tsx`）把分享快照的 `nodes` / `edges` **原样**交给
`saveBoard`，未重映射 id。而服务端：

- `nodes.id` / `edges.id` 是**全局 `PRIMARY KEY`**（`server/core/schema.ts`），非 `(canvas_id, id)` 复合键；
- `saveCanvas` 只 `DELETE FROM nodes WHERE canvas_id = <新画板>`，再按 id 批量 `INSERT`（`canvas.repository.ts`）。

因此当源画板仍存在时，克隆画板会复用源节点 id → 撞主键 → **整板保存失败**（PG 模式）。
默认测试套件跑内存模式、不校验 PK，故长期未被发现。

## 2. 目标与非目标

**目标**

1. 抽出与 zod/DOM 无关的纯函数 `remapBoardIds`，供 **JSON 导入（M1）** 与 **分享克隆（K6）** 共用。
2. 克隆路径对 board / node / edge id 全量重映射，改写 `edge.source`/`target` 与 `data.parentId`。
3. 不改变克隆的业务语义（配额预检、意图生命周期、切板、toast 均不变）。
4. 复用不得把 zod 拉进主包——remap 模块保持零依赖（仅 `uuid`）。

**非目标**

- 不改分享快照的生成/存储（快照仍存原始 id）。
- 不新增服务端端点/限流面。
- 不改 M1 导入的外部文件校验策略（仅共享 remap 步骤）。

## 3. 设计

### 3.1 公共模块 `src/lib/board-remap.ts`（新增，零 zod）

```ts
export interface RemapOptions { generateId?: () => string }
export interface RemapResult {
  boardId: string;
  nodes: Node[];
  edges: Edge[];
  droppedEdges: number;
}
export function remapBoardIds(nodes: Node[], edges: Edge[], opts?: RemapOptions): RemapResult;
```

行为（两遍扫描，支持 parentId 前向引用）：

1. `boardId = generateId()`（默认 `uuidv7`）。
2. **第一遍**：节点按 old id 去重（保留首个）并逐一分配新 id，建立完整 `old→new` 映射。
3. **第二遍**：构造新节点 `{ ...node, id: newId, data: { ...data, parentId: 映射值 } }`；
   `data.parentId` 非字符串或不在映射内则**删除**（不保留悬挂父指针）。节点其余字段（type/position/width…）原样保留。
4. 边按 old id 去重；`source`/`target` 不在映射内的**丢弃并计入 `droppedEdges`**；其余 `{ ...edge, id: 新 id, source, target }`，样式等字段原样保留。

纯函数：不修改入参、不触碰 localStorage/网络。环链校验仍由调用方负责（M1 导入会检查并拒绝，分享快照本身无环）。

### 3.2 M1 导入改为复用

`parseBoardBackup` 保留「原始文本 → 校验 + 内容归一化（剥 readOnly / generating→idle / 清洗 messages）」，
随后把归一化后的节点/边交给 `remapBoardIds` 完成 id 重映射与悬挂边统计；环链校验在 remap 之后执行。
M1 现有 18 条用例作为重构回归护栏。

### 3.3 K6 克隆改为复用

`tryCloneSharedBoard` 改为：

```ts
const snapshotNodes = (body.nodes || []).map(normalizeGenerating); // 保持既有 generating→idle 归一
const remap = remapBoardIds(snapshotNodes, body.edges || [], { generateId: uuidv7 });
const { nodes, edges, boardId } = remap;
if (nodes.length === 0) { /* 既有空快照提示 */ }
saveBoard({ id: boardId, name: boardName, updatedAt: Date.now(), nodes, edges });
```

`deduplicateNodes` / `deduplicateEdges` 不再需要（remap 内已去重），从 App 移除该 import。

## 4. 测试先行

新增 `tests/m2-clone-remap.test.ts`（注入计数器 id 生成器；纯函数直测）：

| # | 用例 | 期望 |
| :-- | :--- | :--- |
| 1 | 正常重映射 | boardId、每个 node/edge 新 id 唯一且与原值不同 |
| 2 | 端点改写 | `edge.source/target` 指向新节点 id |
| 3 | parentId 改写（含前向引用） | `data.parentId` 指向新 id，即使父节点在数组中靠后 |
| 4 | 悬挂父指针 | 不可达 `parentId` 被删除 |
| 5 | 边字段保真 | type/style/markerEnd/animated/label/handle 原样保留 |
| 6 | 去重 | 重复 node/edge 旧 id 保留首个 |
| 7 | 悬挂边 | 被丢弃并计入 `droppedEdges` |
| 8 | 不可变 | 入参数组/对象不被修改 |

M1 既有用例（`tests/m1-json-import.test.ts`）必须继续全绿。

## 5. 验收标准

- [x] `tests/m2-clone-remap.test.ts` 全绿；`tests/m1-json-import.test.ts` 不回归。
- [x] 克隆后的节点/边 id 与源画板无交集（PG 模式不再撞主键）。
- [x] `npx tsc --noEmit`、`npm test` 全绿。
- [x] remap 模块不含 zod/DOM 依赖；主包体积不因本次改动增加。

## 6. 风险

- **克隆行为回归**（中）：克隆是转化关键路径。缓解：只替换 id 生成/去重环节，配额/意图/切板逻辑不动；M1 用例 + 新增 M2 用例双护栏。
- **前向 parentId**（低）：两遍扫描已覆盖，专门用例锁定。
- PG 真库冒烟仍建议补「源画板存在时克隆」端到端用例（沿用 M1 遗留项）。
