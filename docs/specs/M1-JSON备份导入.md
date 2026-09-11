# Spec M1 — JSON 备份导入（导出→导入闭环）

> 来源：工单「支持导出 json 备份岂不是也应该要支持 json 导入」；补齐 K 组导出的单向缺口
> 状态：已实施（2026-09-11）
> 关联：K1 PNG 导出、K6 分享克隆、B1 配额服务端化、H1 属主制、A5 重试队列、ADR-0013/0016

## 1. 目标与非目标

**目标**

1. 用户可把本产品导出的 `.deepdive.json` 备份文件重新导入，生成一块**新的可编辑画板**。
2. 导入不丢内容：节点/便签、连线样式、消息记录、来源索引、视口尽量原样还原。
3. 导入是纯客户端动作：复用 `saveBoard()` / 同步队列落服务端，**不新增端点、不新增限流面**。
4. 面对外部文件保持健壮：非法 JSON、畸形结构、超大体积、含环/悬挂引用一律被拦截或归一，不产生幽灵板。

**非目标（本期不做）**

- 覆盖/合并到已存在画板（导入一律新建画板，避免误覆盖资产）。
- 跨账号/跨产品互导（不承诺与竞品格式兼容，只保证自家导出可回灌）。
- 导入时保留原画板 id / 节点 id（见 §3.4，技术上不可行且不安全）。
- 服务端解析导入文件（无上传端点，文件始终在浏览器内解析）。
- 导出格式升版与版本协商（本期格式即 `StoredBoard`，向后兼容旧备份）。

## 2. 背景：为什么必须做 id 重映射

导出函数 `exportBoardToJson`（`src/lib/storage.ts:460`）序列化整个 `StoredBoard`，其中节点/边**携带其原始 id**。而服务端：

- `nodes.id` / `edges.id` 是**全局 `PRIMARY KEY`**（`server/core/schema.ts:108`、`:159`），不是 `(canvas_id, id)` 复合键。
- `saveCanvas` 先 `DELETE FROM nodes WHERE canvas_id = $1`（仅清当前画板），再按 id 批量 `INSERT`（`server/repositories/canvas.repository.ts:388`、`:489`）。

因此：把导出的 id 原样用于新画板，会与原画板仍在库里的行**撞主键**，整板保存失败。导入必须为 board / node / edge **全部重新生成 id**，并同步重写 `edge.source`、`edge.target`、`node.data.parentId`。

> **关联发现（建议单开缺陷工单）**：K6 分享克隆 `tryCloneSharedBoard`（`src/App.tsx:715`）直接透传快照里的 node id，未做重映射，PG 模式下很可能有同一主键冲突隐患；默认测试套件跑内存模式不校验 PK，故测不到。修复可复用本 spec 的 `remapBoardIds` 思路。

## 3. 设计

### 3.1 数据流

```
Topbar「画布与导出」菜单「导入 JSON 备份」
  → 隐藏 <input type=file accept=".json,application/json">
  → App.handleImportJson(file)
      ├─ file.size > MAX_IMPORT_BYTES        → toast 失败
      ├─ text = await file.text()
      ├─ parseBoardBackup(text)              → 纯函数：校验 + 归一 + id 重映射（本 spec 核心）
      ├─ !ok                                 → toast(result.error)
      ├─ quotaStore.canCreate(isVip)==='block' → 打开充值弹窗（保留文件，不落草稿）
      ├─ quotaStore.markPendingCreate(board.id)
      ├─ saveBoard(board)                    → 本地持久化 + 同步队列上传（配额由服务端硬拦）
      ├─ 切换到新画板（id/name/nodes/edges/nodeCount/viewMode）
      └─ toast「已导入画板《…》」
```

解析核心抽成纯函数模块 `src/lib/board-import.ts`，与 React/DOM 解耦，便于 node:test 直测（先例：`tests/l1-board-sections.test.ts`）。

### 3.2 模块 API

```ts
// src/lib/board-import.ts
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 MB，UI 读文件前预检
export const MAX_IMPORT_NODES = 300;
export const MAX_IMPORT_EDGES = 600;

export type ImportErrorCode =
  | 'FILE_TOO_LARGE'   // UI 预检（parseBoardBackup 不感知字节数）
  | 'INVALID_JSON'
  | 'INVALID_SHAPE'
  | 'EMPTY'
  | 'TOO_MANY_NODES'
  | 'TOO_MANY_EDGES';

export interface ImportOk {
  ok: true;
  board: StoredBoard; // id 全新；updatedAt = now()；不含 serverUpdatedAt
  stats: { nodes: number; edges: number; droppedEdges: number };
}
export interface ImportErr { ok: false; code: ImportErrorCode; error: string; }
export type ImportResult = ImportOk | ImportErr;

export interface ParseOptions {
  /** 注入 id 生成器（测试注入计数器；默认 uuidv7） */
  generateId?: () => string;
  /** 注入时钟（默认 Date.now） */
  now?: () => number;
}

/** 解析并归一化备份文本，成功返回可直接交给 saveBoard 的 StoredBoard */
export function parseBoardBackup(raw: string, opts?: ParseOptions): ImportResult;
```

`parseBoardBackup` 不触碰 localStorage/网络，纯输入输出。

### 3.3 校验规则（输入为不可信文件）

| 检查 | 失败处理 |
| :--- | :--- |
| `JSON.parse` 抛错 | `INVALID_JSON`「文件不是合法的 JSON 备份」 |
| 顶层非对象 / 为数组 / null | `INVALID_SHAPE` |
| `nodes` 非数组 | `INVALID_SHAPE` |
| `edges` 存在但非数组 | `INVALID_SHAPE` |
| 单个 node 非对象或缺字符串 `id` | `INVALID_SHAPE` |
| `node.position` 存在但 `x`/`y` 非有限数 | `INVALID_SHAPE` |
| `node.data` 存在但非对象 | `INVALID_SHAPE` |
| 单个 edge 非对象或缺字符串 `id`/`source`/`target` | `INVALID_SHAPE` |
| 原始 `nodes.length > MAX_IMPORT_NODES` | `TOO_MANY_NODES` |
| 原始 `edges.length > MAX_IMPORT_EDGES` | `TOO_MANY_EDGES` |
| 归一化后 `nodes.length === 0` | `EMPTY`「备份中没有可导入的节点」 |
| `viewport` 存在但数值非法 | **不报错**，回落 `{x:0,y:0,zoom:1}` |
| `name` 非字符串/空白 | **不报错**，回落「导入的画板」 |

校验实现：**zod**（与项目「新增入参必须有 zod schema」的安全纪律一致），经动态 `import()` 懒加载为独立 chunk，主包零增长（见 §9）。

### 3.4 id 重映射

1. `board.id = generateId()`。
2. 遍历原始节点，建立 `oldNodeId → newNodeId` 映射；去重（同 id 保留首个，与 `normalizeCanvasPayload` 同口径）。
3. `node.id = 新 id`；若 `data.parentId` 在映射内则改写为新 id，否则删除该字段（断链不保留悬挂父指针）。
4. 遍历原始边，`edge.id = generateId()`；`source`/`target` 必须命中映射，否则**丢弃该边**并计入 `droppedEdges`（与 saveCanvas 丢弃悬挂边同口径）；重复 edge id 保留首个。
5. 父子环检测：改写后若存在 `id === parentId` 或 `parentId` 多节点成环 → `INVALID_SHAPE`「节点父子关系存在循环」（服务端 `assertAcyclicParentChain` 也会 400，前端提前拦截避免幽灵板）。

### 3.5 内容归一化

- **节点白名单重建**：只保留 `{ id, type, position, data }`，丢弃 `selected`/`dragging`/`measured`/`width`/`height` 等瞬时 UI 字段。
- `type` 仅认 `'chat' | 'note'`，未知值归一为 `'chat'`（向前兼容）。
- `position` 缺失回落 `{x:0,y:0}`。
- **瞬时生成态归一**：`data.status === 'generating'` → `'idle'` 并清除 `errorMessage`（避免导入后永久转圈，同 K6 克隆口径）；`status` 缺失或非法 → `'idle'`。
- **剥离只读标记**：删除 `data.readOnly`（导入画板必须可编辑）。
- `messages` 逐条清洗：保留 `content` 为字符串的条目，`role` 归一为 `'user' | 'assistant'`，补齐缺失的 `id`（生成）与 `timestamp`（now）。
- 便签 `title`/`content` 非字符串 → `''`。
- **边字段保留**：`type`（默认 `'smoothstep'`）、`animated`、`style`、`markerEnd`、`label`、`sourceHandle`、`targetHandle`。
- `board.name` 取 `name` 并 `slice(0,120)`；`updatedAt = now()`；**不写 `serverUpdatedAt`**（新画板无服务端版本，走乐观锁首建）。

### 3.6 配额与失败语义

- **新建画板配额**：前端 `quotaStore.canCreate(isVip)` 预检（与 K6 克隆同口径），服务端 `saveCanvas` 的 `quotaGate` 仍硬拦。被拦时打开充值弹窗，不落任何本地草稿/墓碑。
- **节点数上限**：免费版 10 chat 节点/画板的闸门在 `/api/chat`（`chatQuotaMiddleware`），不在 save。导入含 >10 chat 节点的画板可成功保存，但继续 AI 推理会被 403 `NODE_LIMIT_REACHED`。本期**不在导入时额外拦截**（避免误伤只读浏览），仅在超过 `MAX_IMPORT_NODES` 硬上限时拒绝。
- 导入全程不写审计日志（无新端点，且属用户对自身数据的操作）。

### 3.7 埋点（可选）

`trackEvent` 事件表为固定 10 项（K4）。新增 `import` 事件需同步 Umami 看板配置；本期**不新增事件**，避免口径漂移。

## 4. 前端接线点

| 文件 | 改动 |
| :--- | :--- |
| `src/lib/board-import.ts` | **新增**：`parseBoardBackup` 纯函数 |
| `src/App.tsx` | 新增 `handleImportJson(file: File)`，镜像 `tryCloneSharedBoard` 的落库/切板/toast 链路 |
| `src/components/ui/Topbar.tsx` | `TopbarProps` 增 `onImportJson: (file: File) => void`；「画布与导出」菜单在「导出 JSON 备份」下方加「导入 JSON 备份」；组件内维护隐藏 `<input type="file">` ref（`accept=".json,application/json"`，onChange 取首个文件后重置 `value` 允许重复选同一文件） |
| 图标 | 复用/新增 lucide 图标（候选 `FileUp`/`Upload`），与既有 `FileJson` 并列 |

无服务端改动、无 schema 改动、无新依赖（zod 已在依赖内）。

## 5. 测试先行

新增 `tests/m1-json-import.test.ts`（纯函数直测，注入计数器 id 生成器保证确定性）：

| # | 用例 | 期望 |
| :-- | :--- | :--- |
| 1 | 合法备份正常导入 | `ok`，nodes/edges 数量正确 |
| 2 | id 全部重映射 | board/node/edge id 均与原值不同且唯一 |
| 3 | 引用重写 | `edge.source/target`、`node.data.parentId` 指向新节点 id |
| 4 | 内容保留 | name、title/answer、position、edge `style`/`markerEnd` 原样 |
| 5 | 瞬时态归一 | `generating`→`idle` 且清 `errorMessage`；`readOnly` 被剥离 |
| 6 | 悬挂边丢弃 | 端点缺失的边被丢，`droppedEdges` 计数正确 |
| 7 | 重复 id 去重 | 重复 node/edge id 保留首个 |
| 8 | 未知节点 type | 归一为 `chat` |
| 9 | 非法 JSON | `INVALID_JSON` |
| 10 | 形状非法（nodes 非数组、position 非数） | `INVALID_SHAPE` |
| 11 | 空节点 | `EMPTY` |
| 12 | 超限 | `TOO_MANY_NODES` / `TOO_MANY_EDGES` |
| 13 | 父子环 | `INVALID_SHAPE` |
| 14 | 非法 viewport / 缺失 name | 不报错，回落默认值 |
| 15 | messages 清洗 | 非字符串 content 条目被剔除，缺失 id/timestamp 被补齐 |

UI 链路（配额预检、saveBoard、切板、toast）无 DOM 测试环境，列入手工验收（§7）。

## 6. 验收标准

- [ ] 由本产品导出的 JSON 备份可原样导入为一块新画板，节点/连线/便签/消息完整。
- [ ] 导入后两块画板的节点 id 无交叉；服务端保存成功（PG 真库无主键冲突）。
- [ ] 非法/畸形/超大/含环文件均被拦截并给出中文可读提示，不产生幽灵板。
- [ ] 免费版撞画板配额时走同一充值引导，不落草稿。
- [ ] `npx tsc --noEmit`、`npm test` 全绿；既有用例不回归。
- [ ] 若同时修 K6 克隆 id 重映射，PG 冒烟覆盖「原画板存在时克隆」用例。

## 7. 手工验收清单

- [ ] 导出 A 画板 → 导入 → 新画板内容一致，可继续编辑/AI 推理。
- [ ] 同一文件连续导入两次 → 得到两块独立画板，均保存成功。
- [ ] 导入时选择非 JSON 文件 / 损坏文件 → 提示友好，不新建画板。
- [ ] 免费版已有 3 块画板时导入 → 充值引导弹窗，画板数不变。
- [ ] 只读分享页/移动端不出现导入入口。

## 8. 风险

- **主键冲突**（高）：见 §2。必须全量重映射，且补 PG 冒烟验证。
- **不可信输入**（中）：文件来自用户本地，可能被手改。zod + 白名单重建 + 环检测 + 体积/数量上限覆盖。
- **与留存策略张力**（中，产品）：`docs/产品问题跟踪清单.md` A2 记录「JSON 导出迁移成本近乎为零、无资产锁定」为短板；导入进一步降低迁移成本。建议对外叙事为「恢复你自己的备份」，不做「开放互导」宣传。
- **前端包体**（已缓解）：zod 经懒加载为独立 chunk（gzip ≈26KB），主包不受影响。见 §9。

## 9. 落地决策与遗留

**已定（2026-09-11 实施）**

1. 校验实现：**zod**，经动态 `import()` 懒加载为独立 chunk（构建产物 `board-import-*.js`，gzip ≈26KB），主包零增长。
2. 上限：`MAX_IMPORT_NODES = 300` / `MAX_IMPORT_EDGES = 600` / `MAX_IMPORT_BYTES = 2MB` 照案落地。
3. 导入一律新建画板；配额前端预检 + 服务端硬拦，被拦时开充值弹窗、不落草稿。

**验收**：`tests/m1-json-import.test.ts` 18/18 绿；`npm test` 321/321；`npx tsc --noEmit` 干净；`npm run build` 成功。

**遗留（未纳入本次）**

1. 「chat 节点 > 10」导入提示未加（§3.6 定为不拦截，提示属可选增强）。
2. K6 分享克隆的 node id 重映射隐患未修——建议单开工单，复用本模块 remap 逻辑。
3. PG 真库冒烟暂未覆盖「导入后服务端保存无主键冲突」，建议补 `tests/pg/*`。
