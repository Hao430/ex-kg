# ADR-0019: 数据库角色分离 + 行级安全（RLS）+ 请求级作用域

- **Status**: Accepted
- **Date**: 2026-09-12
- **Deciders**: 枝想架构组
- **Tags**: security, multi-tenancy, persistence, deployment

> **治理注记**：本 ADR 追认的实现落在提交 `e1cf005`（三池 + 作用域句柄）与后续 RLS 策略提交。
> 两者都在用户批准的实施方案（`技术债 #0014 / #0013 收口`）下先行落地，此处补齐 ADR 以符合
> 「安全/鉴权机制变更须 ADR 先行」的约定。

## Context and Problem Statement

技术债 #0014（标 P0）的处方是「给租户表加 `ENABLE ROW LEVEL SECURITY` + 一段
`current_setting('app.user_id')` 策略」。逐条核对代码后，该处方**三个前提全部不成立**：

1. **属主绕过 RLS**。生产库属主是 `syf_minapp`，而应用用的就是这个连接串（`pool.ts` 是
   `DATABASE_URL` 的唯一读取点）。表属主默认绕过 `ENABLE ROW LEVEL SECURITY`，
   策略加上去对应用**毫无作用**——典型的「以为上了锁」。
2. **策略判据恒为空**。策略里的 `app.user_id` 需要有人 `set_config`，而全仓
   0 命中 `AsyncLocalStorage` / `SET LOCAL` / `set_config`：71 个仓储导出函数、126 处
   `.query(` 全是 `pool.query` 无作用域直连。策略一旦生效，结果是把**所有人**拦成零行。
3. **迁移内嵌 DML/破坏性 DDL**。`initDbSchema()` 里有 `UPDATE nodes SET parent_id = NULL`、
   每次启动无条件 `UPDATE users SET email_verified = TRUE`，以及 `DROP COLUMN credits_balance`、
   `DROP TABLE credit_transactions`；且失败路径只 `console.error` 后 `return false`。
   换成受限角色后这些会**静默失败**。

诉求：让「数据库里存的东西，即使应用层漏写属主过滤也读不到」成为一条**由数据库强制**的性质，
同时不改变任何既有 API 契约。

## Decision Drivers

- 纵深防御必须落在**数据库**上：应用层的属主过滤（ADR-0004/0016）已完备，但它是纯约定，
  漏一处没有任何东西会变红；
- 不能引入过渡态（产品未上线），不做「先加策略再慢慢补作用域」的分步；
- 凭据边界要按**最小权限**分档：DDL 权限不该和运行期进程共存；
- 既有契约（403/404 的具体分布）由既有 PG 冒烟用例锁定，**不得漂移**；
- 每条不变式都要有守护测试或真库用例，否则等于没有。

## Considered Options

- **Option A: 单角色 + `FORCE ROW LEVEL SECURITY`** — 让属主也受策略约束，不必建新角色。
  但迁移本身需要全表 DML（上面的 `UPDATE`/`DROP`），`FORCE` 会把迁移一起挡掉，
  只能给迁移开 `BYPASSRLS` 旁路——等于把「属主绕过」换个名字，且 `FORCE` 会连带
  影响未来所有运维 SQL。
- **Option B: 应用层加密 / 每租户独立 schema** — 隔离最强，但租户数增长后 schema 数量
  与管理成本不可控，且要重写全部 SQL 与迁移。
- **Option C: 三角色分离（DDL / 跨租户 DML / 租户内 DML）+ `ENABLE`（不用 `FORCE`）RLS + 请求级作用域**（已选）。

## Decision Outcome

**Chosen option: "C"**。

### 一、三个数据库角色，owner 凭据不进运行期

| 角色 | 权限 | 用途 | 连接串 |
| :--- | :--- | :--- | :--- |
| `syf_minapp`（现有 owner） | 全部 + DDL | **仅**部署期 `npm run migrate` | `DATABASE_ADMIN_URL` |
| `arborize_system` | DML + `BYPASSRLS` | 跨租户路径：按 token 查会话、登录查邮箱、匿名分享、日清任务、admin 聚合、可观测写入 | `DATABASE_SYSTEM_URL` |
| `arborize_app` | DML，**受 RLS** | 运行期主体，全部租户内请求 | `DATABASE_URL` |

`checkRuntimeDbRoleInvariants()` 在 `server.ts` 启动期断言：生产环境下若出现
`DATABASE_ADMIN_URL`，或配了 `DATABASE_URL` 却缺 `DATABASE_SYSTEM_URL`，
打印后 `process.exit(1)`——**响亮拒绝启动，不静默降级**。

### 二、迁移移出应用进程

新增 `server/core/migrate-cli.ts`（读 `DATABASE_ADMIN_URL`），`package.json` 加
`migrate` / `migrate:dev`，`build` 产出 `dist/migrate.cjs`。CD 顺序改为
备份 → rsync → `npm install` → 依赖预检 → **migrate（失败即中止，不重启）** → 重启 → 验收；
owner 凭据经 mode-600 临时 env 文件注入并即用即删，**不写入运行期 `.env`**。
`server.ts` 仅在 `NODE_ENV !== 'production'` 时保留启动期兜底迁移（保住 `npm run dev`
与既有 PG 冒烟套件的现状），生产进程零 DDL。新不变式：`server/repositories/**` 不得出现
`initDbSchema(`（arch-test 锁定）。

### 三、请求级作用域：`getDb()` 是仓储唯一句柄

`server/core/db-context.ts`（AsyncLocalStorage）承载
`{ kind: 'user'; userId } | { kind: 'system'; reason }`，`reason` 必填且进审计文本。
`server/core/db.ts` 的 `getDb()` 取代 `getPool()`：

- **无作用域 → 500 `DB_SCOPE_MISSING`**，不静默降级（静默降级会让策略失效变成零行读取，
  比报错危险得多）；
- `system` → system 池直连（`BYPASSRLS`），无事务包装；
- `user` → app 池，每条查询自带 `BEGIN` + `set_config('app.user_id', $1, true)` + `COMMIT`。
  ⚠️ **必须显式 BEGIN**：事务外 `set_config(..., is_local => true)` 只发一条 warning 就失效，
  查询会以「无 `app.user_id`」执行并被策略拦成零行。写路径走 `withTransaction` 只 BEGIN 一次。
- 连接池不可用单独给 `DB_POOL_UNAVAILABLE`，与「调用方忘包作用域」区分，避免排障方向指反。

作用域建立点共 25 处，全部可在 grep 里数清：`authMiddleware`（先 system 查 token，
确认后 `runWithUser` 进下游）、admin 路由在 `requireAdmin` **之后**整台切 system
（作用域是「已确认管理员」才授予的通行证，不是路由自带属性）、匿名路由逐条显式包裹、
日清任务、错误埋点。

### 四、RLS 策略：`ENABLE` 而非 `FORCE`，豁免显式化

用 `ENABLE ROW LEVEL SECURITY`：owner 是迁移角色必须能正常 DML，`arborize_app` 非属主，
`ENABLE` 即对其生效。

```sql
-- 直接 user_id：canvases / folders / sessions / orders / tags / user_api_keys
USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (同上)
-- users
USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid) + WITH CHECK
-- 间接归属（无 user_id 列）：nodes / edges / canvas_shares
USING (canvas_id IN (SELECT id FROM canvases WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid))
WITH CHECK (同上)
-- 可空 user_id 的观测表：ai_request_logs / user_audit_logs / event_logs / feedbacks / notifications
USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
```

`NULLIF(...,'')` 防空串 cast 报错（SQLSTATE 22P02）。

**显式豁免**（不启用 RLS，由 arch-test 锁定清单）：`system_settings`（全局配置，非租户数据）、
`email_verification_codes`（账号建立前按 email 寻址）、以及待评估删除的空壳表
（`canvas_snapshots` / `canvas_tags` / `node_attachments` / `canvas_templates` / `ai_models_config`）。

### 五、跨租户归属探针（`canvas_probe`）——RLS 与「报对错误」的冲突

RLS 让 app 角色**看不见**他人的行，而这恰恰是两处既有契约的前提：

| 位置 | 现状依赖 | 仅靠 RLS 会怎样 |
| :--- | :--- | :--- |
| `saveCanvas` 归属预读 | 非属主写 → **403 `CANVAS_FORBIDDEN`** | 预读 0 行 → 误判为新建 → `INSERT … ON CONFLICT` 撞上不可见行 → PG 策略错误 → `handlePgError` 在生产**直接抛 503** |
| `assertCanvasAttributableByUser` | 他人画板 → **404** | `exists` 变 false → 校验**静默放行** → 可对他人画板伪造 `ai_request_logs` 归因并刷 LLM 开销 |

解法：给 app 角色一个**极窄的** `SECURITY DEFINER` 函数（属主所有，参数化，只回
`user_id/updated_at/deleted_at`，需知道 id 才能问，不泄露任何租户数据），在同一事务内
替代两处预读。应用契约逐字不变，RLS 对全部真实数据路径仍然生效，且无 TOCTOU。

⚠️ **该函数之所以可行，正是因为不用 `FORCE ROW LEVEL SECURITY`**——`SECURITY DEFINER`
以属主身份执行，而属主仅在 `ENABLE` 级下绕过策略。**日后若有人给这些表加 `FORCE`，
探针会静默返回 NULL**，跨租户保存会退化为 404/403 误判。加 `FORCE` 前必须同步改造探针。

配套：`handlePgError` 不得把 RLS 拒绝归类为基础设施故障。RLS 拒绝在 app 角色下是
**常态**（任何越权尝试都会触发），而现有实现会在生产把它抛成 `503 DB_UNAVAILABLE`，
把「无权」误报成「数据库不可用」。

### Positive Consequences

- 纵深防御落到实处：应用层漏写属主过滤时，数据库返回**零行**而不是他人数据；
- 凭据分档：拿到 `DATABASE_URL` 的攻击者受 RLS 约束且无 DDL；
- 迁移与运行期解耦：应用进程零 DDL 权限，破坏性 DDL 只在显式 migrate 步骤发生；
- 「这条查询代表谁」变成每条查询都必须回答的问题，`DB_SCOPE_MISSING` 让遗漏**响亮**。

### Negative Consequences

- **收益的诚实边界**：拿到 `DATABASE_SYSTEM_URL` 者可读全库（仍不能 DDL/DROP）。
  RLS 的真实价值是兜住应用层 bug，**不是**抵御已持有高权限凭据的攻击者；
- `BYPASSRLS` 需超级用户授予；若拿不到，退路是把 `arborize_system` 设为表属主
  （属主天然绕过 `ENABLE` 级 RLS），届时须同步修订本 ADR；
- 单条查询多包一层事务（单语句语义等价 autocommit），代价是每查询多几次本地往返；
- 25 处作用域建立点是新的**约定面**：漏一处就是 500，靠 arch-test + 双角色 PG 冒烟兜住；
- 多维护一个特权函数与一份 RLS 豁免清单。

## References

- 代码：`server/core/pool.ts`、`server/core/db.ts`、`server/core/db-context.ts`、
  `server/core/migrate-cli.ts`、`server/core/schema.ts`、`server.ts`、`server/repositories/*.ts`、
  `server/middleware/auth.ts`、`server/routes/{auth,admin,shares,subscriptions}.ts`、
  `server/jobs/log-cleanup.ts`、`server/middleware/error-handler.ts`
- 测试：`arch-tests/{db-scope-discipline,tenant-filter,rls-coverage}.test.mjs`、
  `tests/pg/{rls-isolation,db-scope}.pg.test.ts`、`arch-tests/repository-dual-mode.test.mjs`（判据收紧）
- 配置：`.env.example`（三连接串 + 「owner 串不得进运行期」警示）、`package.json`（`migrate` / `build`）、
  `.github/workflows/ci.yml`（migrate 步骤 + 双角色 PG 冒烟）
- 前置决策：`docs/adr/0002-dual-mode-persistence.md`（双模判据不变）、
  `docs/adr/0004-strict-tenant-ownership.md`、`docs/adr/0016-admin-strict-canvas-tenancy.md`
- 关联：`docs/adr/0018-default-board-private.md`（legacy 共享默认板是本 ADR 下唯一的
  显式 system 作用域升级点，随技术债 #0084 下线）、技术债 #0014
