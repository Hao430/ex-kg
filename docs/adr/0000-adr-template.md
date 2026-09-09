# ADR-0000: 架构决策记录（ADR）模板与约定

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: governance, process

> 本文档是所有 ADR 的元文档：定义模板、命名规范、状态机与生命周期。新增 ADR 时复制本文件并填写正文，删除本元数据块。

---

## 1. 什么是 ADR

**ADR (Architecture Decision Record)** 是一份短小的、面向未来的文档，记录一次**重要的**架构决策：

- 它**为什么**被做出；
- 它**评估过哪些**替代方案；
- 它**带来什么**正面/负面影响。

ADR 的核心价值不是"记录结果"，而是"**记录思考过程**"——半年后回看，能立即明白当时为什么这样选，而不是凭直觉推翻重做。

## 2. 何时写 ADR

**强制**：当决策涉及以下任一项时，必须先写 ADR 再实现：

- 引入 / 替换一项**核心依赖**（数据库、Web 框架、ORM、状态管理）；
- 改变**模块边界 / 分层规则**；
- 改变**数据模型**（新增表、改变外键关系、改软删策略）；
- 改变**安全 / 鉴权 / 限流**机制；
- 改变**部署 / 构建**方式；
- 引入**新协议**（WebSocket、gRPC、GraphQL）。

**不强制**：纯代码风格、命名约定、bug 修复、内部重构。

## 3. 文件命名与编号

- 路径：`docs/adr/NNNN-<kebab-case-title>.md`
- 编号：四位顺序数字（`0001`, `0002`, ...），**永不重用**（废弃决策的编号保留）
- 标题：用动词开头（`use-`, `adopt-`, `enforce-`, `split-` 等）
- 文件名例：`0001-single-port-fullstack.md`

## 4. 状态机

| 状态 | 含义 |
| :--- | :--- |
| `Proposed` | 提议中，尚未实现 |
| `Accepted` | 已接受，已实现（或将实现） |
| `Deprecated` | 已废弃，**不要在新代码中使用** |
| `Superseded by ADR-NNNN` | 被新 ADR 取代，链接到新 ADR |

**规则**：

- 状态变更只能 `Proposed → Accepted / Deprecated`，或 `Accepted → Deprecated / Superseded`。
- 不允许 `Accepted → Accepted`（即使 supersede，也要先 deprecated 自己再新立）。
- Deprecated / Superseded 的文件**保留不删**，仅改文件头 `Status`。

## 5. 模板（MADR 风格）

```markdown
# ADR-NNNN: <决策标题（动词开头）>

- **Status**: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- **Date**: YYYY-MM-DD
- **Deciders**: <人/团队>
- **Tags**: <comma-separated tags>

## Context and Problem Statement

<2-3 段。要解决什么问题？背景是什么？约束是什么？>

## Decision Drivers

- <驱动力 1>
- <驱动力 2>
- <驱动力 3>

## Considered Options

- **Option A: <名称>** — <一句话描述>
- **Option B: <名称>** — <一句话描述>
- **Option C: <名称>** — <一句话描述>

## Decision Outcome

**Chosen option: "<X>"**, because <一句话核心原因>.

### Positive Consequences

- <好处 1>
- <好处 2>

### Negative Consequences

- <代价 1>
- <代价 2>

### Follow-up / Mitigation

- <如何缓解上述代价>
- <配套机制>

## Pros and Cons of the Options

### Option A: <名称>

<good / bad 描述>

### Option B: <名称>

<good / bad 描述>

## References

- <代码引用：file_path:line>
- <文档引用：docs/xxx.md>
- <外部链接>
```

## 6. Review 流程

1. 提议者起草 ADR，状态 `Proposed`；
2. 提交 PR，标题 `docs(adr): ADR-NNNN <标题>`；
3. 至少 1 名架构组成员的 review；
4. 通过后状态改 `Accepted`，**实现必须紧跟**（不接受"先 ADR 后做"）；
5. 6 个月后做一次 ADR Audit，标记过期 / 错误决策。

## 7. 与现有文档的关系

| 文档 | 关系 |
| :--- | :--- |
| `docs/技术架构文档.md` | 系统总览与数据模型（与代码同步维护） |
| `docs/开发规范.md` | 编码约定、命名、提交规范 |
| `docs/里程碑与分期规划.md` | 产品决策与分期 |
| `docs/specs/<编号>-<主题>.md` | 单一变更的 spec（动代码前写） |
| **`docs/adr/NNNN-xxx.md`** | **架构决策**（动架构前写） |

> **ADR 永远是只读的**。决策被新 ADR 取代时，旧 ADR 改 Status 即可，不删内容。

## 8. ADR 索引

完整索引见 `docs/adr/README.md`。
