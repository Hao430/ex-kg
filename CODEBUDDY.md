# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

枝想 Arborize：生产级二维拓扑 AI 思考工作台。React 19 + Vite 前端与 Express 后端**单端口**运行（Port 3000），PostgreSQL + 内存双模持久化。文档权威口径见 `docs/`（需求说明/技术架构/里程碑与分期规划/数据库建表脚本.sql）；**运维与部署口径见 `docs/部署与回退手册.md`**。

## 常用命令

```bash
npm run dev        # 开发：tsx server.ts（Express + Vite HMR，http://localhost:3000）
npm run lint       # 类型检查：tsc --noEmit（验收必过项）
npm test           # 全量测试：PAYMENT_ENABLED=true tsx --test 'tests/*.test.ts'（内存模式）
npx tsx --test tests/d3-email-verification.test.ts   # 跑单个测试文件
npx tsx --test 'arch-tests/*.test.mjs'   # 架构守护测试（双模/作用域/探针/RLS 覆盖/同源守卫，fail 必须修代码或按注释约定加豁免）
npm run build      # vite build + esbuild 打包后端为 dist/server.cjs 与 dist/migrate.cjs
npm run migrate:dev # 本地建表/迁移（ADR-0019；生产走部署期 migrate 步骤，见部署手册 Step 4.5）
npm start          # 生产运行
docker compose -f docker-compose.pg-smoke.yml up -d postgres && \
  PG_SMOKE=1 npx tsx --test --test-concurrency=1 'tests/pg/*.test.ts'   # PG 真库冒烟
# 双角色轮（CI 的第二遍，也是唯一能证明 RLS 策略放行得通的检验）：
#   PG_SMOKE=1 PG_TEST_URL=postgres://arborize_app:... DATABASE_SYSTEM_URL=... DATABASE_ADMIN_URL=... \
#     npx tsx --test --test-concurrency=1 'tests/pg/*.test.ts'
```

**测试框架是 node:test（`tsx --test`），不是 vitest**——用 vitest 跑会全部报「No test suite found」。默认套件（`tests/*.test.ts`）只跑 memory 模式且 **glob 不含 `tests/pg/`**；PG 真库覆盖在 `tests/pg/*.test.ts`（`PG_SMOKE=1` 门控，连不上即红不 skip），**6 个文件共用同一个库、各自在 `before()` 里跑迁移，故用 `--test-concurrency=1` 串行**。

## 架构大图

### 数据库角色、作用域与行级安全（ADR-0019 / 技术债 #0014，最高优先级的架构约束）

三个角色 → 三个池（`server/core/pool.ts`）：`DATABASE_URL` → `arborize_app`（DML-only，**受 RLS**，运行期主体）/ `DATABASE_SYSTEM_URL` → `arborize_system`（DML + `BYPASSRLS`，跨租户路径，缺省回落 `DATABASE_URL`）/ `DATABASE_ADMIN_URL` → `syf_minapp`（属主，**仅部署期 migrate**）。**owner 凭据不进运行期进程**：`checkRuntimeDbRoleInvariants()` 在生产检测到它就拒绝启动；配了 `DATABASE_URL` 却没配 `DATABASE_SYSTEM_URL` 同样拒绝启动（回落会让跨租户路径被 RLS 拦成零行 = 「所有人登录失效」）。

- **仓储唯一句柄是 `getDb()`**（`server/core/db.ts`），**不再有 `getPool()` 直连**。无作用域 → 抛 500 `DB_SCOPE_MISSING`（响亮失败，绝不静默降级）；内存模式不经过它，故默认套件不受影响。
- **作用域由组合层建立**（`server/core/db-context.ts`，AsyncLocalStorage）：`runWithUser(userId, fn)` 在显式事务内 `set_config('app.user_id', $1, true)`（**必须 BEGIN**——`SET LOCAL` 在事务外只发 warning 且不生效，症状是「数据凭空消失且日志干净」）；`runWithSystem('理由', fn)` 走 system 池且**不注入用户 GUC**（跨租户靠不设判据，不是伪造一个用户）。`authMiddleware` 先 `runWithSystem`（按 token 跨租户查会话）再 `runWithUser(user.id, () => next())`；**依赖 Express 4 的 `next()` 同步进入下游**，由 `tests/pg/db-scope.pg.test.ts` 独立锁定（含 12 路并发不串作用域）。
- **仓储不得自行升级作用域**：`server/repositories/**` 内不得出现 `runWithUser`/`runWithSystem`——「要不要跨租户读」是组合层的判断，散在数据访问代码里就无法一眼数清（`arch-tests/tenant-filter.test.mjs`）。
- **RLS 策略在 `schema.ts` 里生成**，清单即分类：`RLS_DIRECT_USER_TABLES`（有 `user_id`）/ `RLS_SELF_ID_TABLES`（`users`）/ `RLS_CANVAS_CHILD_TABLES`（`nodes`/`edges`/`canvas_shares`，按 `canvas_id` 间接归属）/ `RLS_EXEMPT_TABLES`（豁免必须写明理由）。谓词统一 `NULLIF(current_setting('app.user_id', true), '')::uuid`（防未设置时的空串 cast 报错），`USING` + `WITH CHECK` 同谓词。**新表必须归类**，`arch-tests/rls-coverage.test.mjs` 会核对「全部 `CREATE TABLE` 都被分类」。
- ⛔ **绝不用 `FORCE ROW LEVEL SECURITY`**：它让属主也受策略约束 → 归属探针失效 → 403 静默退化成 404。arch-test + 真库 `relforcerowsecurity` 断言两道盯着。
- **归属探针 `canvas_probe`**（`SECURITY DEFINER` + `STABLE` + 锁死 `search_path` + 只读 + 已收回 PUBLIC EXECUTE）：RLS 下 app 角色看不见他人的行，「存在但非属主」（403）与「不存在」（404）在查询结果上是同一个零行。`saveCanvas`/`deleteCanvas`/`updateCanvasMeta`/`getCanvasOwnerInfo` 四个归属判定点必须走它，否则 403 静默变 404、`saveCanvas` 还会误走新建路径；而 `getCanvas` **刻意不探针**（他人画板 = 404 是既有契约，加探针会变成 403）——两个方向都有守护测试锁死。新增探针使用点 = 新增一处策略旁路，须在 ADR-0019 论证并更新 allowlist。
- **`WITH CHECK` 把 NULL 视为 false**：app 作用域下写 `user_id` 为 NULL 的观测行会被拒；可空归因的写入（错误处理器、注册/找回、admin 聚合）必须在 system 作用域下。
- **迁移是部署期的独立步骤**（`server/core/migrate-cli.ts` → `dist/migrate.cjs`），生产进程零 DDL；`server/repositories/**` 不得出现 `initDbSchema(`（懒迁移已全部摘除，非生产保留启动兜底）。失败即中止发布且**不重启**，旧进程继续服务。

### 双模持久化（贯穿全后端的核心模式）

- `server/core/schema.ts` 是**建表唯一事实源**（22 张表，`initDbSchema()` 做幂等增量迁移），`docs/数据库建表脚本.sql` 为同步设计稿，两者出入以 schema.ts 为准。⚠️ **生产不在进程里跑它**：改由部署期 `npm run migrate` 以 owner 角色执行（ADR-0019，见下）；非生产保留启动兜底。
- 未配 `DATABASE_URL` 或 PG 访问失败时自动降级 `server/core/memory-store.ts`（单例 Map/数组，启动时播种 3 个种子账号，email_verified=true）。
- `server/repositories/*` 每个函数固定双模写法：PG try（经 `getDb()`）→ 成功 return；catch 或无 pool → 落内存；**业务错误（AppError 子类如 ForbiddenError/NotFoundError）必须在落内存前 rethrow，禁止 catch 吞掉造成 200 假成功**（参考 `canvas.repository.ts` 的 `deleteCanvas`）。新增数据访问必须照此模板（参考 `user.repository.ts` 的 `setVerificationToken`），且**必须同时含 `getDb(` 与 `inMemoryStore.`**（`arch-tests/repository-dual-mode.test.mjs` 的判据）。过期判断用 `> NOW()`；用户与画布查询均带 `deleted_at IS NULL`（F4 注销 / H1 画布软删口径）。
- **内存分支输出必须与 PG 分支归一化对齐**：内存 getCanvas 经 `normalizeMemoryNode()` 重建 node.data（与 PG 分支同款默认值清单），改任一分支时两路同步；grounding 直通不补默认值（a3 测试锁定）。
- **节点 parent 链两层防环（技术债 #0006）**：PG `nodes_parent_id_no_self` CHECK（防自指）+ `saveCanvas` 入口 `assertAcyclicParentChain()`（防多节点环 a→b→a，命中 400 `NODE_PARENT_CYCLE`）。改 nodes 写路径不得绕过此校验。

### 后端分层

`routes`（zod schema 定义在路由文件顶部，经 `validate()` 校验）→ `services`（业务编排）→ `repositories`（双模）→ `core`（pool/schema/memory-store/records）。错误统一抛 `lib/errors.ts`（`ValidationError`/`ConflictError`/`AppError(status, code, message)` 等），由 `errorHandler` 序列化为 `{error, code}` JSON。

- 鉴权：cookie 会话（`session_token`，7 天）；`middleware/auth.ts` 提供 `authMiddleware`/`requireAdmin` 与全部限流器（新端点必须独立 limiter 实例）。`trust proxy` 固定为 `'loopback, linklocal, uniquelocal'`（技术债 #0010）——禁止改回数字跳数或 true，公网前端挂 CDN 时需显式枚举出口段。
- **变更方法同源守卫（ADR-0020 / 技术债 #0013）**：`server/middleware/same-origin.ts` 全局挂在 body parser 之后、所有路由之前——`POST/PUT/PATCH/DELETE` 上 `Sec-Fetch-Site: cross-site` → 403 `CSRF_ORIGIN_REJECTED`；带 `Origin`（或可从 `Referer` 推导）且非同源 → 403；**不带 `Origin` 一律放行**（curl / 服务端调用 / 支付宝回调 / 全部测试都不带，而浏览器跨站变更请求必带，故不放松防线）。**新路由不得挂到 guard 之上**。会话 cookie 只经 `server/lib/session-cookie.ts` 写入（`httpOnly` + `sameSite:'lax'` + 无 `domain`）；全局 `express.urlencoded()` 已收窄到支付宝通知单端点，新端点需要表单编码就自己挂。
- 未验证邮箱拦截：`middleware/quota.ts` 对非 admin 的 chat 请求返回 403 `EMAIL_NOT_VERIFIED`；登录不拦截。
- 注册（2026-09 重设计）：**验证码先行**——`POST /api/auth/send-register-code` 发 6 位码（10 分钟、每邮箱 60s 冷却、每 IP 5/h，存 `email_verification_codes` 表）→ `sign-up` 携码原子消费（连错 5 次作废）才建号，出生即 `email_verified=true`。链接式 `/verify-email` 与 `/resend-verification` 保留，**仅服务 admin 换绑邮箱后的二次验证**。
- 邮件：`server/lib/mailer.ts` 双模式——SMTP 四个环境变量齐备走真发；否则 jsonTransport 干跑进内存 outbox（测试经 `getOutboxForTest()` 断言，上限 50 条）。链接依赖 `APP_URL`。
- **微信登录（ADR-0022，`server/routes/wechat.ts` 挂 `/api/auth/wechat`）**：网站应用 OAuth2 整页跳转扫码，`WECHAT_APP_ID`/`WECHAT_APP_SECRET` 齐备才启用（缺任一 → 前端不渲染入口 + `/authorize` 302 回 `NOT_CONFIGURED`）。身份落 `oauth_identities`（`UNIQUE(provider, openid)`；**`unionid` 只建普通索引，绝不能加唯一约束**——同一个人的多个应用 openid 必然多行同 unionid，加唯一键会堵死跨应用同人收敛）；表归 `RLS_DIRECT_USER_TABLES`，登录前按 openid 查走 `runWithSystem`。微信账号在 `users` 里是**确定性占位邮箱** `wx_<sha256(openid)[0:32]>@wechat.invalid` + 口令哨兵 `OAUTH_UNSET_PASSWORD_HASH`（不含冒号 → `parseAndVerify` 立即返 false，永不通过）+ `email_verified=true`（否则 chat 被 `EMAIL_NOT_VERIFIED` 拦死）；**注册口必须继续拒 `@wechat.invalid`**（否则可抢注造成定向 DoS）。⚠️ `GET /callback` 是**改状态的 GET**（第三例，见 ADR-0020/0022）：不改 `MUTATING_METHODS`，其 CSRF 防护是 state 双提交 cookie，且 **state 不匹配必须在任何外呼之前 return**；与支付宝 `/notify` 不同，这里**不豁免限流**。服务端派生 `email_placeholder`/`has_password` 两个标记供前端降级展示（无数据库列），改这两个标记要同步 `UserProfileModal`。回调结束后端只回可枚举原因码，**绝不透出微信原始 `errmsg`**。
- **账号绑定（ADR-0023，`server/services/account-binding.service.ts`）**：微信 ↔ 邮箱**单向、不可自助解除**；误绑的退路是运营台 `DELETE /api/admin/users/:id/oauth/:provider`。回调**有有效会话即按绑定处理**（`resolveSessionUser`）——绑定分支**绝不建账号、绝不动会话 cookie**；失败走**独立参数 `wechat_bind_error`**，不能挤进 `wechat_error`（后者在前端会弹登录框）。补绑邮箱只绑邮箱**不设密码**，因此**绝不能复用 admin 的 `updateUserEmail`**（它会把 `email_verified` 置 false → `quota.ts` 把全部 chat 403 打挂），要用 `bindVerifiedEmail`；且**新增凭据不踢会话**，与「换凭据才踢（`changeOwnPassword`/`resetPassword`）」是两条并列规则，勿合并。⚠️ 全站邮箱唯一性预检**必须包 `runWithSystem`**：`users` 的 RLS 谓词是 `id = app.user_id`，在已登录作用域下查他人邮箱在 PG 里恒返 null（内存模式却能查到）= 只有测试能通过的双模分叉。绑定状态（`wechat_bound`/`wechat_nickname`）**只在 `/me` 查**，不进 `publicUser()`。
- 模型配置语义：推理模型唯一来源是管理后台 `ai_model_config`（`getSavedAiModelConfig()` **不合并默认值**）；管理员未选模型时 chat 返回 400 `MODEL_NOT_CONFIGURED`。`DEFAULT_AI_MODEL_CONFIG.gemini_model` 保留为白名单 bootstrap，不可清空（测试锁定）。
- **画布访问权限（H1，跨 getCanvas/saveCanvas/deleteCanvas 的核心口径）**：严格属主制——读/写/删一律**属主本人**（admin 不例外，ADR-0016；admin 仅保留运营台聚合统计与日志、以及自身配额额度）；放行点已**归零**：`isSharedDefaultCanvas()` 现在是**随开关切换的授权放行**（`SAVE_DEFAULT_BOARD_MODE`，默认 `legacy` 保留历史共享行为，`private` 后 `default-board` 退化为「首个认领者的普通画板」、未认领即行不存在——ADR-0018；发布顺序**必须客户端先行 + soak ≥7 天**，窗口期内非属主旧标签页会在保存时才 403）。**禁删与授权解耦**：`isDefaultCanvasPublicId()`（`default-board`/`default-canvas`）判定禁删与 id 归属，**与模式无关，两种模式下都禁删**——公开 id 被客户端硬编码引用，软删即让这些引用永久 404（ADR-0012 已按此改写）。客户端同理有两套判据，**不可合并**：前端隐藏删除按钮用公开 id 集合（`SHARED_BOARD_IDS`，禁删、与模式无关），收藏/归档/分组入口用**服务端列表回传的 `isShared`**（授权、随模式切换；`board-store` 在叠加本地未确认缓冲后强制回服务端值）——拿 id 集合判授权会在 private 模式下把认领者自己的默认板锁成共享板。画布删除是软删（`UPDATE SET deleted_at=NOW()`，子表 nodes/edges 即时物理清），saveCanvas 对已软删 id 抛 404 且 upsert 带 `WHERE deleted_at IS NULL` 防复活。前端画板/节点 id 已统一 UUIDv7（`src/lib/uuid.ts`，不可枚举、时间前缀 B-tree 友好，存量行保留原 id 混存兼容）且**新画板一律生成新 id，不得再硬编码 `default-board`**（`src/lib/board-scope.ts` 的 `LEGACY_DEFAULT_BOARD_ID`/`SHARED_BOARD_IDS` 是唯一出处，前端隐藏删除按钮也按它判定）；存量本地 `default-board` 内容在服务端明确拒绝（404/403）时由 `src/lib/board-migrate.ts` 整份搬成一块自己的新板（按账号一次性幂等标记，**必须换新 id**；服务端仍可读时是空操作，离线/5xx 不打标记下次重试）。属主制仍是唯一安全边界，勿再引入任何前缀/属主放行。节点检索 `searchNodes(queryText, userId, canvasId?)` 的 `userId` 为**必填**（2026-09-11 收紧，此前可选会在省略时退化为全站检索）；审计/运营日志详情不得落分享码等只读凭据。
- **chat 链路（I 组）**：前端 `/api/chat` 请求体必须带 `canvasId`+`nodeId`（审计归因 + 配额）；`chatQuotaMiddleware` 对体验版按画布内**已消耗过推理**的 chat 节点（排除 note，**排除 suggested 灵感占位**）≥10 拦 403 `NODE_LIMIT_REACHED`。⚠️ 口径 2026-09-14 由「含 suggested」翻转：占位是每条回答附带的「下一步可问什么」候选，尚未提问、未消耗推理，不应占额度（原口径下每条回答产生 1 回答 + 3 占位 = 4 节点，所谓「10 个节点」实际只够问 2~3 次）。**改这一处必须同时改前端 `DeepDiveCanvas` 的 `localUsed`**（乐观余量镜像口径），否则回到 D2 那种「前端说还能问、后端 403」的错位。已知边界见技术债 #0090（`status` 由客户端 save 提供 → 节点墙可被构造的客户端绕过；兜底是下面那道服务端 token 配额）。另有 per-user 每日 token 配额闸门（技术债 #0021，`AI_DAILY_TOKEN_QUOTA` 默认 20 万 tokens/天/用户、0=不限，超限 429 `DAILY_TOKEN_QUOTA_EXCEEDED`）。联网为**静默恒开**（web_search 工具无条件附加，`enableWebSearch` 字段被 zod 剥离是预期行为）；来源提取走 `collectSources` 防御式三源回退，上限 30 源/10 询；正文 `[n]` 角标与来源列表编号一一对应（system 指令 + 前端 `linkifyCitations` 上标徽章）。Gemini 容灾链由 `ai_model_config.gemini_fallback_models` 配置（字符白名单过滤，技术债 #0020），未配置回落代码内 bootstrap 三档。
- **SSE 写入纪律（技术债 #0023）**：chat 的所有 SSE 帧必须经 `sseWrite()`（缓冲满时等 drain 的背压写入 + 断连丢弃），**禁止裸 `res.write`**——新增 SSE 帧一律用它。
- **支付（ADR-0014）**：`PAYMENT_ENABLED` 是总开关（false → 下单一律 503 `PAYMENT_DISABLED`）。渠道选择 `getPaymentProvider()`：`ALIPAY_APP_ID/ALIPAY_PRIVATE_KEY/ALIPAY_ALIPAY_PUBLIC_KEY` 三要素齐备 → `alipay-provider.ts`（官方 alipay-sdk v4，`alipay.trade.page.pay`）；缺任一 → `mockProvider`（开发/测试全链路）。**开通 VIP 只有两条来源：订单结算与 admin 后台赠送**——旧 `POST /api/auth/subscribe`「一步开通」已于 2026-09-14 整条移除（它只挡 `PAYMENT_ENABLED` 就建单并激活 = 无支付白拿 VIP，可无限叠加，且**恰好在「上线支付」改开关那一步打开**），勿复活；`subscribeUserPlan` 一并删除。`mock-pay` 的判据是**当前生效渠道就是 mock**（`isMockPaymentChannel()`），不是「非 production」——只看 `NODE_ENV` 会漏掉预发/灰度/忘了设 `NODE_ENV=production` 的线上，那里用户对自己的 pending 单 POST 一次就自助开通。异步通知 `POST /api/subscriptions/notify` **免 auth/免限流**（支付宝服务器回调，验签即鉴权——对限流器纪律的显式豁免，理由在端点注释+ADR）：验签（`checkNotifySign`→V2 兜底）+ app_id 归属 + 金额字符串精确比对 → `settlePaidOrder()` 把**条件更新 pending→paid 与 VIP 叠期放进同一事务**（`withTransaction`）；失败整体回滚、订单退回 pending，支付宝重试即可自愈——拆成两段会留下「订单已 paid、VIP 没叠期」且**永久不自愈**（重试走「已是 paid」分支应答 success 停止重发，查单兜底与幂等分支都因非 pending 进不去）。叠期是**单条 UPDATE**（`GREATEST(COALESCE(vip_expires_at, NOW()), NOW()) + make_interval(days => $2::int)`，admin 不降级）：读-改-写在一句内完成，同一用户两单并发结算不会丢天数（原先是读到期时间再写，后写覆盖先写）。非成功态回 `success` 不激活。查单对账兜底：查单接口对 pending 单主动 `alipay.trade.query` 同步（5s 节流），防 notify 丢失；该 GET 挂**独立**限流器 `orderStatusReadRateLimiter`（40/min per user），**不得**与下单的 `subscriptionRateLimiter`（10/min）共桶——前端每 3s 轮询 = 20 req/min，共桶会在约 27 秒后把轮询打死，连带废掉查单兜底。**套餐只有 weekly/monthly**——yearly 已下架（2026-09-10，支付宝渠道单笔限额 ¥50），服务端 zod 硬拒，勿在 schema/前端重新引入。`return_url` 不做到账判定，只信 notify+查单。

### 部署与 CI/CD（权威口径：`docs/部署与回退手册.md`）

- GitHub Actions（`.github/workflows/ci.yml`，名称 CI/CD）三 job：**ci**（tsc→全量测试→arch-tests→build→PG 冒烟**两遍**，push/PR 自动）→ **deploy**（仅手动 Run workflow 触发：备份快照→rsync dist→服务端 `npm install --omit=dev`+依赖预检→**部署期迁移**→重启→验收，失败即停不自动回退）→ **rollback**（Run workflow 填快照 TS，执行手册 §5）。私有仓库 Free 套餐无 Environment 审批，**人工放行 = 手动 Run workflow**，push main 不会自动发版。
- **PG 冒烟两遍**（ADR-0019）：第一遍 owner 单角色（库 `arborize_test`，覆盖既有行为），第二遍先建 `arborize_app`/`arborize_system` 并授权、再以 `arborize_app` 为主角色跑（库 `arborize_rls_test`，`PG_TEST_URL` + `DATABASE_SYSTEM_URL` + `DATABASE_ADMIN_URL`）——后者是唯一能证明「每个 PG 路径都带上了作用域、每条策略都放行得通」的检验，也是生产翻 `DATABASE_URL` 开关的唯一依据。⚠️ **两遍必须各用一个空库**：用例注册固定邮箱（`j3-*`/`p-pg-*`），复用第一遍写过的库会撞 `EMAIL_EXISTS`(409)，且失败信息会指向「没发验证码邮件」而非真因；角色是集群级的，但 `GRANT`/`ALTER DEFAULT PRIVILEGES` **按库**存储，新库要重新授权。注意 `tests/pg/pg-smoke.test.ts` 会用 `PG_TEST_URL` 覆盖 `DATABASE_URL`，双角色轮必须传它。
- **迁移在重启之前**，owner 凭据经 ssh **stdin** 落到远端 mode-600 临时文件、`trap` 即用即删（不进 argv，远端 `ps` 看不到，也**不得**写进运行期 `.env`）；失败即中止且不重启。手工兜底流程见部署手册 Step 4.5。⚠️ 生产启动日志里**不再有** schema 行——不要在启动日志里 grep `verified and initialized`（迁移输出里才有）。
- **发布物 = CI 测试通过的 dist 构建物**（artifact 传递，不在本地二次构建）；生产拓扑：pg-host（SSH 1542）站点 `/www/wwwroot/ex-kg/` 只有 dist/node_modules/.env/package.json，宝塔 Node 管理器管进程，**运行期 `.env` 只在服务器上、CD 永不触碰**（改完必须重启）。
- **esbuild `--packages=external`**：新 runtime 依赖必须服务端 `npm install --omit=dev`（CD 已内置+启动前依赖预检），否则重启即 `Cannot find module`。
- ⚠️ **dotenv 时序坑**：`dotenv.config()` 在 `server.ts` 里执行，晚于所有 import——**模块级读 `process.env` 恒为 undefined**，必须封装为函数运行时读取（已踩三次：alipay-provider 的 `APP_URL`、mailer dry-run、memory-store 的 `EVENT_LOGS_MEM_MAX`）。

### 前端结构

- `src/main.tsx` 按 pathname 分流：`/reset-password`、`/verify-email` 独立落地页（无 AuthProvider，裸 fetch）；其余走 `App.tsx`（AuthProvider 包裹的画布应用）。
- **画布列表真相（技术债 #0082；2026-09-12 云优先收口）**：列表唯一来源是 `src/lib/board-store.ts` = **服务端快照**（真相 + 顺序基准）叠加「未确认缓冲」（内容 dirty / meta dirty / 纯本地草稿），按 id 去重，`useSyncExternalStore` 稳定快照。服务端确认过的字段只能由服务端回包推进（`confirmServerSave` 收 save 回包的 title/nodeCount/updatedAt，**不得拿本地 meta 顶替**）；`upsertServerMeta` = 采用服务端内容后落盘，`upsertLocal` = 本地未确认改动，两者不可混用。localStorage 索引已降级为**绘制缓存**（冷启动出画面 + 游客认领判定，不参与裁决），服务端列表一到整体替换，曾同步过却不在新快照里的条目按他端删除收敛。`App.tsx` 不得再用 `setBoards(loadBoardList())` 以本地索引覆盖合并态；`loadBoardList()` 现为 board-store 视图。localStorage 按 scope 隔离（`src/lib/board-scope.ts`，guest/userId），旧无作用域索引首次绑定时迁移；游客登录自动认领纯本地草稿。`src/lib/quota-store.ts` 以 `/api/quota` 为权威 + pendingCreates 驱动顶栏「画板 X/3」与新建闸门（不再用本地索引硬拦）。
- **画布保存协议分流（ADR-0017，2026-09-12 节点级合并上线）**：`POST /api/canvases/:id/save` 靠请求体的 `protocolVersion` **显式分流**——缺失/`1` = 旧客户端整板替换（`DELETE` 后重插 + 画板级乐观锁，行为逐字不变）；`>= 2` = 节点级合并（只 upsert 本次带来的节点/边，**「没带 = 不动」**，`deletedNodeIds`/`deletedEdgeIds` 显式墓碑，`title`/`viewport` 缺省即保留原值）。**不能猜结构**：空数组在旧客户端是「清空」、在新客户端是「无删除」，语义相反。合并路径**刻意不校验画板级乐观锁**（挂机设备改一个节点不该被 409 挡下），冲突面缩到节点，靠 `nodes.rev`/`edges.rev`（写入即 `rev+1`，行锁下严格递增）记定序。删除即 `deleted_at` 墓碑且**稳定胜出**：upsert 带 `WHERE ... AND deleted_at IS NULL`，被守卫拒绝的 id 进 `ignoredNodeIds` 回执。`SAVE_LEGACY_REPLACE_ENABLED=false` 熔断旧路径（409 `CLIENT_OUTDATED`，**刻意不带 `latest_updated_at`** 否则旧客户端刷新版本号后重发死循环）。客户端差分在 `src/lib/board-ops.ts`：基线（id→投影哈希，**必须落盘**，只从「保存成功」与「从服务端取回」两处推进）缺失时**绝不退化成整板 upsert**；投影只覆盖会被持久化的字段（React Flow 的 `selected`/`dragging`/`measured`/`dimensions` 不进哈希，否则打开画板即整板标脏）。墓碑按 `CANVAS_TOMBSTONE_RETENTION_DAYS`（默认 30 天，对齐 ADR-0005）每日回收，**先删边再删节点**；内存分支显式空操作（墓碑随进程消亡）。观测：`[canvas-save] mode= protocolVersion= bytes= ops={} ignored= repaired=`，只记计数与画板 id，节点内容不进日志。
- 画布保存与删除：`src/lib/storage.ts` 本地 + `sync-queue`（状态机 `pending/saved/conflict/error`；saved 3 秒后回退 idle）。队列**持久化**（绑 scope 后写 localStorage，`hydrateQueue` 刷新续跑 + `recoverDirtyDrafts` 兜底）。乐观锁冲突派发 `deepdive:canvas-save-conflict`（detail 带 `code`：`BOARD_LIMIT_REACHED`/`VIP_EXPIRED`/`NOT_FOUND`/`UNAUTHORIZED`）。删除是**乐观 + 墓碑**：`deleteBoardLocally` 立即隐藏并入删除队列，2xx/404 确认清理、403/401 回滚、断网保留墓碑待重试；游客/纯本地草稿直接本地删（无需服务端）；远端已删（save 404）派发 `deepdive:board-remote-deleted` 并收敛幽灵板。
- **画板库与单层分组（Spec L1 / ADR-0015）**：`DeepDiveBoardMeta` 增 `isFavorite`/`isArchived`/`folderId`。`board-store` 用独立 `metaDirty`（区别于内容 `dirty`）跟踪偏好变更，故收藏/归档/移组**不触发整板上传**；`sync-queue` 任务升级为一板多操作 `ops: ('upload'|'delete'|'meta')[]`（delete 独占压制、执行序 delete→meta→upload、旧持久化格式 `{type}` 在 `hydrateQueue` 归一）。偏好同步走轻量 `PATCH /api/canvases/:id/meta`（响应回传新 `updatedAt` 供乐观锁推进，不接收 nodes/edges）；分组 CRUD 走 `/api/folders`（`folderActionRateLimiter`），分组为个人资产仅属主可管理，`folderId` 由服务端校验归属**画板属主**（防跨租户串联）。删除分组只 `folder_id=NULL`，绝不级联删画板。UI 为 `BoardLibraryModal`（搜索/收藏/归档/分组侧栏），`folder-store` 在线优先且按 scope 缓存离线可见。
- 新用户引导：空白初始画布（新账号/画板全删空/新建画板）统一经 `App.tsx` 的 `createStarterRootNode()` 注入「新探索主题」待填根节点，不允许出现纯空白画布。
- **错误边界纪律（技术债 #0032）**：ReactFlow 自定义节点必须经 `withErrorBoundary()` 包裹（见 `nodeTypes`），画布子树有 canvas 级 `ErrorBoundary` 兜底——新增节点类型同样要包，否则单节点抛错会拖垮整画布。
- 品牌与文案（面向用户的文案一律不出现内部术语）：模型品牌/型号、Google 字样、开源库名（KaTeX 等）、「商业级/多租户/RBAC/沙箱/鉴权/IDOR」这类架构自述词一律不用（如需提及用「前沿大模型」「实时联网检索」「数据按用户严格隔离」）。推荐探索课题为可深挖的学习型议题（哲学概念、AI 概念等），不用遥远的前沿论文题。

## 测试约定

- 每个测试文件独立进程：`createApp()` + `http.createServer` 随机端口 + `waitSeeds()` 轮询 `/api/db/status`（userCount ≥ 3）。
- 文件内多次注册/发码会顶满 5/h 的 IP 限流，重号用例前用 `limiter.resetKey(ipKeyGenerator('127.0.0.1'))` 复位（express-rate-limit v8 无公开 store）；订阅端点同理，先例 `tests/e1-payment.test.ts` 的 `resetSubLimiter()`（subscriptionRateLimiter 10/min）。
- 注册辅助走验证码流程：`send-register-code` → 从 outbox 提取 6 位码 → `sign-up`（参考各文件的 `registerViaCode`）。
- 测试内拦外部 API 用 fetch 分发器：保存 `origFetch`，按 URL 分发 stub（如 chat.ts 调千问 `/responses` 返回构造的 SSE Response），其余透传，`after` 钩子恢复（先例 `tests/h2-grounding-chain.test.ts`）。
- 断言审计日志用 `getAiRequestLogsForTest()`（`ai.repository.ts`，读内存单例，**newest-first/unshift**）；middleware 层拒绝（如 NODE_LIMIT_REACHED）不写审计，只能行为断言。
- PG 真库测试（`tests/pg/*.test.ts`）：`PG_SMOKE=1` 门控 + `PG_TEST_URL` 可覆盖默认连接串，容器 tmpfs 库用完即抛；pg-smoke 用例注册固定邮箱复用旧库会撞 409/冷却，**必须空库跑**。⚠️ PG SQL 禁止把同一占位符用在两种类型上下文（varchar 列 + text 比较 → `42P08`，内存分支测不到，曾致生产下单全败——写 PG 参数一律独立占位符）。
- **RLS 相关的两种跑法都要绿**（ADR-0019）：`tests/pg/rls-isolation.pg.test.ts` 与 `tests/pg/db-scope.pg.test.ts` 里，「策略装到位没有」那组断言在任何角色下都跑（查 `pg_class`/`pg_proc`，与角色无关）；「隔离真的生效吗」那组只在 `PG_TEST_URL` 指向受 RLS 约束的角色时有判别力，否则**带理由跳过**——但若 `PG_TEST_URL` 已配置却不受 RLS 约束，判定为接线错误并**报错而不是跳过**（少传一个变量不能让唯一的证据无声消失）。判据优先用 **GUC 的值**（`current_setting('app.user_id')`）而不是行数：行数只在受限角色下有判别力，GUC 在任何角色下都看得见，且同时钉死「ALS 传到了 db.ts」与「`set_config` 在事务内真的生效」。
- 验收标准：新测试全绿 + 既有用例不回归 + `tsc --noEmit` 通过。

## 工作约定（本项目强制）

- **import 一律带 `.js` 后缀**（ESM node16 解析），包括类型导入。
- `docs/specs/` 始终只读（历史 Spec 不改，重设计决策记入里程碑文档）；`docs/` 其他文档更新需用户确认；`tests/` 目录只读，例外需用户显式授权（历次豁免已记录在提交信息中）。
- **技术债流程**：`docs/技术债清单.md` 按状态机维护（Open / In Progress / Done / Won't Fix），修债务的 commit message 必须引用对应 `#NNNN`；Won't Fix 必须写明评估理由与复开条件（先例：#0003、#0016）。
- `arch-tests/` 是治理工具（非只读）：dual-mode 判据要求函数体含 `getDb(` 与 `inMemoryStore.`（2026-09-12 起由 `getPool` 收紧为 `getDb`，不得回退到直连连接池），函数体提取按签名配对（勿回退"第一个 `{`"逻辑）；限流器判据按文件级 ALLOWLIST，豁免必须写明理由——⚠️ 但它的路由正则还**硬编码了 router 变量名白名单**（`router|chatRouter|authRouter|…`）：新增 `server/routes/*.ts` 若用别的变量名，该文件会因匹配不到任何路由而被**静默跳过**（判据对它零覆盖），必须把变量名补进正则。另有 rls-coverage（策略分类/探针形状/无 FORCE）、tenant-filter（探针不扩散、仓储不升级作用域、`getCanvas` 刻意不探针）、db-scope-discipline（作用域纪律）、csrf-guard（同源守卫的**接线**，而非行为——行为测试打的是 `createApp()`，守卫挂错位置它们照样绿）四套。
- **改安全/鉴权机制的必须先写 ADR**（ADR-0019 角色分离与 RLS、ADR-0020 同源守卫即先例），ADR 状态只能 `Proposed → Accepted/Deprecated` 或 `Accepted → Deprecated/Superseded`；`docs/adr/README.md` 的索引表要同步。
- 完成实施后按惯例报告：修改文件清单、验收结果、边界决策。
