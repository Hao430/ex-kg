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
| [0004](./0004-strict-tenant-ownership.md) | 多租户严格属主制 | Accepted | 2026-09-09 | 画布读/写/删只允许属主本人；唯一放行是 `default-board` 共享画板（admin 例外由 ADR-0016 移除，共享放行由 ADR-0018 收口） |
| [0005](./0005-soft-delete-with-30d-cooldown.md) | 软删除 + 30 天冷却期 | Accepted | 2026-09-09 | users/canvases 软删 + Admin 恢复窗口；30 天后硬删级联 |
| [0012](./0012-default-canvas-no-delete.md) | 默认画板禁删 | Accepted | 2026-09-09 | 公开 id（`default-board`/`default-canvas`）被客户端硬编码引用，软删即让引用永久 404；禁删与授权解耦（2026-09-12 修订） |
| [0013](./0013-frontend-node-id-truncation.md) | 节点 ID 前端生成 + 截断前缀 24 字符 | Accepted | 2026-09-09 | 避免深层级画布触发 PG `varchar(64)` 22001 |
| [0015](./0015-canvas-library-single-level-folders.md) | 画板管理采用「检索 + 收藏/归档 + 单层分组」 | Accepted | 2026-09-10 | 复用已建 `is_favorite`/`is_archived`；新增 `folders` + `canvases.folder_id`（无 parent_id、删组不删板）；拒绝任意层级树；标签仍按二期共存 |
| [0016](./0016-admin-strict-canvas-tenancy.md) | 画布数据严格属主制收口——移除 admin 例外 | Accepted | 2026-09-11 | 删除画布读/写/删/meta/分享/chat 归因/配额的 admin 放行；admin 只保留运营台聚合统计与日志及配额额度；顺带收紧 auto-title 归属 |
| [0018](./0018-default-board-private.md) | 默认画板私有化——移除最后一个跨租户放行 | Accepted | 2026-09-12 | `default-board` 从全局共享单行收口为「首个认领者的普通画板」：授权路径零放行（`SAVE_DEFAULT_BOARD_MODE=private`），禁删与授权解耦；客户端改用新 id 并带走本地存量；客户端先行 + soak ≥7 天再翻开关 |
| [0019](./0019-db-role-separation-and-rls.md) | 数据库角色分离 + 行级安全（RLS）+ 请求级作用域 | Accepted | 2026-09-12 | 三角色（owner 仅迁移 / system 跨租户 `BYPASSRLS` / app 受 RLS），owner 凭据不进运行期；迁移移出应用进程；`getDb()` 为唯一句柄，无作用域即 `DB_SCOPE_MISSING`；`ENABLE`（不用 `FORCE`）RLS + 显式豁免清单；`canvas_probe` 特权探针保住既有 403/404 契约 |

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
| [0020](./0020-same-origin-guard.md) | 变更方法同源守卫 + 会话 cookie 属性单一事实源 | Accepted | 2026-09-12 | 只对 `POST/PUT/PATCH/DELETE` 的显式来源校验（`Sec-Fetch-Site`/`Origin`/`Referer`），**无 `Origin` 一律放行**（锁定非浏览器客户端契约）；cookie 属性收敛为单一事实源；`urlencoded` 收窄到支付宝通知单端点；两个改状态的 GET 记录为已接受 |

### 同步与并发

| # | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [0008](./0008-sync-state-machine.md) | 同步状态机 + 乐观锁 | Accepted | 2026-09-09 | `pending/saved/conflict/error` 四态，指数退避重试，冲突不重试；画布保存的冲突面已由 ADR-0017 收窄到节点（2026-09-12 修订） |
| [0017](./0017-node-level-merge-and-tombstones.md) | 节点级合并与墓碑语义 | Accepted | 2026-09-12 | `protocolVersion:2` 差分协议：客户端只发本次改动，服务端节点级 upsert（"没带 = 不动"），删除即 `deleted_at` 墓碑且稳定胜出；`SAVE_LEGACY_REPLACE_ENABLED` 熔断旧整板路径，墓碑按 `CANVAS_TOMBSTONE_RETENTION_DAYS`（默认 30）回收 |
| [0021](./0021-server-authoritative-sync.md) | 采用服务端权威同步，本地降级为未确认缓冲 | Accepted | 2026-09-11 | 409 不再「本地胜出」（阶段 1）→ 节点级合并（ADR-0017，前置条件）→ 本地降级为未确认缓冲；长连接只解决「服务端主动推」不解决冲突，明确不做；**无网不可编辑是已接受的产品代价**；2026-09-14 补记——决策当时未写成 ADR，导致排查线上事故时无从查证 |

## 已废弃 / 取代 (Deprecated / Superseded)

| # | 标题 | 状态 | 取代为 |
| :--- | :--- | :--- | :--- |
| [0006](./0006-mock-payment-phase1.md) | 一期不接真实支付（PaymentProvider 抽象 + Mock） | Superseded | [ADR-0014](./0014-alipay-page-pay.md)（2026-09-10 接入支付宝；其中 PaymentProvider 抽象与 mock 开发链路仍沿用） |

## 待提议 (Proposed)

| # | 标题 | 状态 | 提议人 |
| :--- | :--- | :--- | :--- |
| _(暂无)_ | | | |

## 按主题浏览

- **部署 / 运维**：[0001](./0001-single-port-fullstack.md) · [0019](./0019-db-role-separation-and-rls.md)
- **持久化 / 数据**：[0002](./0002-dual-mode-persistence.md) · [0004](./0004-strict-tenant-ownership.md) · [0005](./0005-soft-delete-with-30d-cooldown.md) · [0012](./0012-default-canvas-no-delete.md) · [0013](./0013-frontend-node-id-truncation.md) · [0015](./0015-canvas-library-single-level-folders.md) · [0016](./0016-admin-strict-canvas-tenancy.md) · [0019](./0019-db-role-separation-and-rls.md)
- **AI 集成**：[0003](./0003-multi-model-failover.md) · [0009](./0009-150-node-subtree-split.md)
- **业务与安全**：[0007](./0007-independent-rate-limiters.md) · [0010](./0010-scrypt-hardening.md) · [0011](./0011-email-verification-code-first.md) · [0014](./0014-alipay-page-pay.md) · [0020](./0020-same-origin-guard.md)
- **同步与并发**：[0008](./0008-sync-state-machine.md) · [0017](./0017-node-level-merge-and-tombstones.md) · [0021](./0021-server-authoritative-sync.md)

> 索引本身由 ADR 维护者更新；新增 ADR 时把行加到对应主题段，并按编号升序排列。
