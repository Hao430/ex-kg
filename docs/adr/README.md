# 枝想 ADR 索引

> 本目录收录枝想（Arborize）所有**架构决策记录**。新增决策请复制 `0000-adr-template.md` 并按规范填写。

## 元文档

- [ADR-0000: ADR 模板与约定](./0000-adr-template.md)

## 已接受决策 (Accepted)

### 部署与运行

| # | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [0001](./0001-single-port-fullstack.md) | 单端口全栈（Express + Vite middleware 同跑 3000） | Accepted | 2026-09-09 | 统一端口消除 CORS、便于集成测试；Vite middlewareMode 复用生产与开发同一份 Express |

### 持久化

| # | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [0002](./0002-dual-mode-persistence.md) | PostgreSQL + 内存双模自动容灾 | Accepted | 2026-09-09 | 未配 `DATABASE_URL` 或 PG 失败时降级内存；每个 repository 函数固定双模写法 |
| [0004](./0004-strict-tenant-ownership.md) | 多租户严格属主制 | Accepted | 2026-09-09 | 画布读/写/删只允许属主本人或 admin；唯一放行是 `default-board` 共享画板 |
| [0005](./0005-soft-delete-with-30d-cooldown.md) | 软删除 + 30 天冷却期 | Accepted | 2026-09-09 | users/canvases 软删 + Admin 恢复窗口；30 天后硬删级联 |
| [0012](./0012-default-canvas-no-delete.md) | 默认画板禁删 | Accepted | 2026-09-09 | 全局共享画板删除会锁死所有用户，物理禁删 |
| [0013](./0013-frontend-node-id-truncation.md) | 节点 ID 前端生成 + 截断前缀 24 字符 | Accepted | 2026-09-09 | 避免深层级画布触发 PG `varchar(64)` 22001 |

### AI 集成

| # | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [0003](./0003-multi-model-failover.md) | 多模型容灾链（Gemini → OpenAI 兼容） | Accepted | 2026-09-09 | 默认 `gemini-3.8-flash`，容灾链 `gemini-3.1-flash-lite` → `gemini-flash-latest` + OpenAI 协议热备 |
| [0009](./0009-150-node-subtree-split.md) | 150+ 节点子树剥离 | Accepted | 2026-09-09 | 节点超 150 时引导用户把子树导出为独立画板，释放 DOM 内存 |

### 业务与安全

| # | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [0006](./0006-mock-payment-phase1.md) | ~~一期不接真实支付（PaymentProvider 抽象 + Mock）~~ | **Superseded by 0014** | 2026-09-09 | `PAYMENT_ENABLED=false` 关闭在线充值；VIP 由 Admin 赠送 |
| [0007](./0007-independent-rate-limiters.md) | 12 个独立限流器 | Accepted | 2026-09-09 | 每个限流器独立实例 + 独立计数 key，避免一端点耗尽名额拖垮其他 |
| [0010](./0010-scrypt-hardening.md) | scrypt 加固参数（N=2^16 / r=8 / p=1） | Accepted | 2026-09-09 | 单次校验 ≥200ms 抗 GPU 暴力；版本头 `scrypt$N$r$p$salt:key` 支持存量升级 |
| [0011](./0011-email-verification-code-first.md) | 邮箱验证（验证码先行） | Accepted | 2026-09-09 | 注册先发 6 位码（10 分钟、连错 5 次作废），账号出生即 `email_verified=true` |
| [0014](./0014-alipay-page-pay.md) | 支付宝电脑网站支付（alipay.trade.page.pay） | Accepted | 2026-09-10 | 官方 alipay-sdk v4；三要素齐备走支付宝、否则回落 mock；notify 验签+金额+app_id 三重校验、幂等激活、查单兜底 |

### 同步与并发

| # | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [0008](./0008-sync-state-machine.md) | 同步状态机 + 乐观锁 | Accepted | 2026-09-09 | `pending/saved/conflict/error` 四态，指数退避重试，冲突不重试 |

## 已废弃 / 取代 (Deprecated / Superseded)

| # | 标题 | 状态 | 取代为 |
| :--- | :--- | :--- | :--- |
| [0006](./0006-mock-payment-phase1.md) | 一期不接真实支付（PaymentProvider 抽象 + Mock） | Superseded | [ADR-0014](./0014-alipay-page-pay.md)（2026-09-10 接入支付宝；其中 PaymentProvider 抽象与 mock 开发链路仍沿用） |

## 待提议 (Proposed)

| # | 标题 | 状态 | 提议人 |
| :--- | :--- | :--- | :--- |
| _(暂无)_ | | | |

## 按主题浏览

- **部署 / 运维**：[0001](./0001-single-port-fullstack.md)
- **持久化 / 数据**：[0002](./0002-dual-mode-persistence.md) · [0004](./0004-strict-tenant-ownership.md) · [0005](./0005-soft-delete-with-30d-cooldown.md) · [0012](./0012-default-canvas-no-delete.md) · [0013](./0013-frontend-node-id-truncation.md)
- **AI 集成**：[0003](./0003-multi-model-failover.md) · [0009](./0009-150-node-subtree-split.md)
- **业务与安全**：[0007](./0007-independent-rate-limiters.md) · [0010](./0010-scrypt-hardening.md) · [0011](./0011-email-verification-code-first.md) · [0014](./0014-alipay-page-pay.md)
- **同步与并发**：[0008](./0008-sync-state-machine.md)

> 索引本身由 ADR 维护者更新；新增 ADR 时把行加到对应主题段，并按编号升序排列。
