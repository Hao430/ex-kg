# 安全发布 Checklist（发布门禁项）

> **建立**：2026-09-07（Spec J4 / 跟踪清单 E3）
> **来源**：一期收官后 H 组（4 处缺陷，含水平越权）与 I 组（8 处缺陷，含配额绕过）两批安全补丁的逐条反推——把已付过学费的缺陷模式固化为例行动作，防止同一模式三犯。
> **使用方式**：每次里程碑收官 / 安全相关改动合入前逐项勾选；**全部勾选 + `tsc --noEmit` 通过 + 全测试绿 + PG 冒烟绿，四项门禁全绿方可标记里程碑完成**。

## 1. 越权矩阵（读 / 写 / 删 × 属主 / 他人 / admin / 匿名）

每个资源型端点（canvas/user/order/log…）合入前必须过一遍：

- [ ] **读**：非属主读他人资源 → 404（不泄露存在性，严格属主制）；**admin 不例外（同 404）**；匿名 401
- [ ] **写/改**：非属主写 → 403（带独立错误码，如 CANVAS_FORBIDDEN）；**admin 不例外（同 403）**
- [ ] **删**：非属主删 → 403；**admin 不例外（同 403）**；已删资源幂等语义明确（404 或 `{success:false}` 二选一并测试锁定）
- [ ] **admin 不放行资源数据**（ADR-0016）：admin 仅保留运营台聚合统计与日志；若某资源确需 admin 特权，必须写 ADR 说明并同步本矩阵

- [ ] **批量/列表接口**：过滤条件带属主（`user_id`/`deleted_at IS NULL`），无跨租户泄漏
- [ ] **计数/统计类只读端点**（如 quota、overview）：归属校验与资源端点同级——不因「只是读个数字」而放行
- [ ] **检索/查询类端点**：属主参数（`userId`）**必填**，禁止 `$n::uuid IS NULL OR c.user_id = $n` 这类「省略即全站」的放行分支（`searchNodes` 曾如此，2026-09-11 收紧）
- [ ] **凭据类字段不出日志出口**：分享码 / 邀请码 / 重置 token 等**只读访问凭据**不得写入审计或运营日志详情，`/api/admin/*` 日志端点也不得回显（否则 admin 可据此绕过属主制读取资源，2026-09-11 修复）
- [ ] 新端点使用 `tests/authz-matrix.template.ts` 填空生成矩阵测试（tests/ 豁免需用户显式授权，豁免记录写提交信息）
- [ ] **RLS 是兜底，不是替代**（ADR-0019）：应用层的属主过滤仍必须写——RLS 的价值是「漏写时返回零行而不是他人数据」，不是「可以不写」。二者都到位才叫纵深防御（应用层写错时 RLS 会以 `42501` + `row-level security policy` 响亮失败，见 `server/core/db-guard.ts`）

> 来源：H1 越权（`isClaimableCanvas` 前缀放行）、J2 设计期审查（quota 端点归属校验）、2026-09-11 审计日志 `shareCode` 间接读取通道 + `searchNodes` 可选 `userId` 旁路。

## 2. 降级与假成功（双模持久化）

- [ ] **业务错误（AppError 子类）在 PG 分支 catch 之前 rethrow**，禁止被 catch 吞掉后落内存返回 200
- [ ] catch 块统一首行 `handlePgError(e)`（Spec J1）：生产 + 已配 `DATABASE_URL` 时 PG 故障 → 503 `DB_UNAVAILABLE`，禁落内存
- [ ] 内存分支输出与 PG 分支归一化对齐（`normalizeMemoryNode` 默认值清单双向同步）
- [ ] 过期/属主过滤双分支一致（`> NOW()`、`deleted_at IS NULL`）

> 来源：H1 缺陷 3（deleteCanvas 吞 ForbiddenError 假成功）、I 组缺陷 8（归一化不一致）。

## 3. 删除 / 复活 / 软删一致性

- [ ] 删除为软删（`UPDATE SET deleted_at=NOW()`），子表清理语义明确并测试锁定
- [ ] upsert 带 `WHERE deleted_at IS NULL` 防复活；已软删 id 的 save → 404
- [ ] 前端删除确认制：仅 2xx/404 清本地 + `sync-queue.dequeue`；403/5xx/断网保留本地
- [ ] 公开 id 画板（`default-board`/`default-canvas`）禁删且有测试——禁删按**公开 id 集合**判定（`isDefaultCanvasPublicId`，与授权开关无关），`SAVE_DEFAULT_BOARD_MODE=private` 下同样禁删
- [ ] 默认画板私有化切换遵守发布顺序（ADR-0018）：**客户端先行 + soak ≥7 天**再翻 `SAVE_DEFAULT_BOARD_MODE=private`；翻之前有当日 `pg_dump`
- [ ] 翻转 `SAVE_LEGACY_REPLACE_ENABLED=false` 前，`[canvas-save]` 日志里 `mode=replace` 已归零（否则旧客户端会集体 409 `CLIENT_OUTDATED`），且有当日 `pg_dump`

> 来源：H1 缺陷 1/2/4（前缀放行、删除竞态复活、软删口径不统一）。

## 4. 配额与计费语义（服务端唯一裁判）

- [ ] 前端不承担配额判定——展示数据一律来自 `/api/quota`（Spec J2），本地预检已删除
- [ ] 后端计数口径测试锁定（**排除 suggested 灵感占位**、排除 note，与 chatQuotaMiddleware 同源；2026-09-14 由「含 suggested」翻转）
- [ ] **配额口径改一处必须改全部镜像点**：服务端 `countCanvasNodes`（PG + 内存两分支语义必须等价）与前端 `DeepDiveCanvas.localUsed`。只改一边 = 重演 D2「前端说还能问、后端 403」的错位
- [ ] ⚠️ **已知边界（2026-09-14 接受，记入技术债 #0090）**：`nodes.status` 由客户端在 `saveCanvas` 里提供，而节点额度按 `status <> 'suggested'` 计——即「算不算一个节点」可被构造的客户端影响（把节点一律存成 suggested 即可绕过节点墙）。**本项即上方「直连 API 绕过前端无法获得任何配额放宽」的一个显式例外**，需在产品层面接受；兜底是 chat 路径独立的每日 token 配额（服务端判定）。
- [ ] 直连 API 绕过前端无法获得任何配额放宽（每条权益一条直连 403 测试）
- [ ] **开通 VIP 的来源清单是封闭的**：只有订单结算与 admin 赠送能改 `role`/`vip_expires_at`。新增任何「直接开通」端点前先问「它凭什么证明收到钱了」
- [ ] **开 `PAYMENT_ENABLED=true` 之前**：确认 `POST /api/auth/subscribe` 返回 404、且生效渠道下 `mock-pay` 返回 404（这两个都是开关一翻就敞口的无支付开通通道）
- [ ] **自助类端点的可达性判据是「渠道/环境本身」**，不是「不是生产」——`NODE_ENV` 漏设、预发/灰度都会让 `!== 'production'` 式判据失效
- [ ] **结算与发货在同一事务**：订单转 paid 与 VIP 叠期不得分两段提交；并发结算同一用户多单不得丢天数
- [ ] **轮询/读端点不与写端点共限流器实例**（阈值耦合会打死轮询，连带废掉对账兜底）
- [ ] **Spec R1 练习闸门**：出题端点挂**独立的 24h 窗口限流器**（体验版 20 次/天、VIP/Admin 不限）——⛔ 不得挂在 `assertCanInfer` 旁（该函数在 `!canvasId` 时直接 return 放行，而练习不带 canvasId，挂了等于空转）；`BOARD_LIMIT`/`NODE_LIMIT` 是空间维度计数、无时间窗口，同样复用不了
- [ ] **非流式 AI 调用必须自建 token 闸门**：`AI_DAILY_TOKEN_QUOTA` 的判定写死在 `chat-orchestrator.streamChat` **内部**，非流式路径（出题、自动命名）不经过它。新增非流式 AI 端点须自行 `sumUserTokensSince` 复刻该检查，否则每日 token 上限被绕过
- [ ] **⛔ 每日次数闸门不得挂在 `ai_request_logs` 上计数**——该表按 90 天留存滚动清理，计数会自行衰减（技术债清单已明文禁止）

> 来源：I 组缺陷 2（前端不传 canvasId 导致配额永不触发）；资金安全复核 2026-09-14（一步开通白拿 VIP / `mock-pay` 判据错位 / 结算非原子 / 轮询被下单限流器打死）。

## 5. 输入与参数

- [ ] 新端点入参 100% zod（`validate()`），query/params/body 全覆盖
- [ ] 剥离型字段（zod 未声明即剥离）是有意行为时需注明——禁止「UI 开关被静默剥离成摆设」（I 组缺陷 1 教训）
- [ ] 外部内容渲染协议白名单（如来源链接 `^https?://`）
- [ ] **用户可控文本不得作为 system prompt 入口**：`chat.ts` 的 `systemInstruction` 是客户端可传字段，且优先级在管理员配置之后、内置提示词之前（`custom_system_prompt || systemInstruction || 内置`）——**任何 AI 生成类端点都不得提供该入参**，system prompt 只由服务端常量决定（Spec R1 出题端点已按此实现）
- [ ] **「正确答案/敏感数据不下发」必须是构造式保证，不靠 zod 默认剥离**——本仓既有 schema 均为裸 `z.object`、从未显式写 `.strip()`；出题响应由投影 DTO 逐字段挑选，新增字段不会自动泄漏

## 6. 限流与审计

- [ ] 新端点挂**独立 limiter 实例**（不复用他人实例，避免阈值耦合）
- [ ] 写操作写审计日志（`user_audit_logs` 11 类之外的增量动作需补类目）
- [ ] middleware 层拒绝（限流/配额）不写审计的行为边界经确认
- [ ] **Spec R1 练习限流**：`quizGenerateRateLimiter`（20/min）、`quizAttemptRateLimiter`（60/min）、`quizDailyAttemptLimiter`（24h）三个实例互不共桶；`route-rate-limiter` 判据应自动覆盖 `server/routes/quiz.ts`（判据自 2026-10-03 起动态发现 router 变量名，日志「限流判据覆盖」应出现 `quiz.ts`）
- [ ] **翻 `QUIZ_ENABLED=true` 之前**：确认 ① 部署期 `npm run migrate` 的日志里出现 `quiz_attempts`（建表成功）；② 后台「模型配置」已选好模型（未配置时出题端点全失败）；③ `.env.example` 与部署手册 §环境变量表已登记该键。回滚只需改回 `false` 并重启，**练习记录留在表里不删**，卷回来仍在

## 6.5 AI 生成内容（Spec R1 补充）

- [ ] **AI 生成的题目/文本可能有知识性错误**：产品**不承诺正确性**，靠解析可见 + 引导去画布深挖兜底；**对外文案不得暗示经过人工校验**（不要写「经校对」「权威题库」）
- [ ] **统计口径不得被「猜对」污染**：判断题猜对概率 50%，秒答必须单独标记 `lowConfidence` 并在展示时单列，不混入「已掌握」。⛔ 该阈值（3s）的数学依据**只对判断题成立**，不可套用到单选（猜对率 25%，结论不成立）
- [ ] **用户可自证的字段用服务端数据兜底**：作答耗时用于上述判定，故须校验「总耗时 ≤ 练习存续时长 + 合理答题窗口」——写成「≤ 练习存续时长」会把**正常作答也拦死**（出题返回后用户才开始答）
- [ ] **位置偏置**：模型出题正解高频落在固定字母，服务端须洗牌后**按新位置重新编号标签并同步更新答案**——只洗牌不重编号等于没洗（正确项会连同原标签移动，答案分布恒定不变）

## 7. 数据存活性（上线专项）

- [ ] 生产环境模拟 PG 宕机：写请求 503 而非 200；`/api/db/status` degraded=true（j1 测试）
- [ ] `npm test` 全绿 + PG 冒烟**两遍**全绿（ADR-0019）：第一遍 owner 单角色、第二遍以 `arborize_app` 为主角色（`docker compose -f docker-compose.pg-smoke.yml up -d postgres`；CI 已内建，命令见部署手册 §6）
- [ ] `tsc --noEmit` 通过

## 8. 变更方法与同源（ADR-0020，#0013）

- [ ] 新增**变更类端点**（`POST/PUT/PATCH/DELETE`）自动受 `sameOriginGuard` 保护——它全局挂在 body parser 之后、所有路由之前；**新路由不得挂到 guard 之上**（`arch-tests/csrf-guard.test.mjs` 会按挂载顺序判定）
- [ ] **「不带 `Origin` 一律放行」是刻意契约**（curl / 服务端调用 / 支付宝回调都不带），不得改成「无 `Origin` 即拒」——那会打掉全部非浏览器客户端
- [ ] 会话 cookie 只经 `server/lib/session-cookie.ts` 写入（`httpOnly` + `sameSite:'lax'` + 无 `domain`，`secure` 仅生产）；**别处不得 `res.cookie` / `Set-Cookie`**
- [ ] 新增需要表单编码的端点必须**显式**挂 `express.urlencoded()`——全局那一份已收窄到支付宝通知单端点
- [ ] 新增改状态的 GET 需说明为何不改（现有两个：`verify-email`、`shares/:shareCode`，靠不可猜 token/code 自保，记为已接受）

> 来源：#0013 复核（防线全隐式：谁把 cookie 改成 `sameSite:'none'` 不会有任何东西变红）。

## 9. 数据库角色与行级安全（ADR-0019，#0014）

- [ ] **新表必须分类**进 `server/core/schema.ts` 的 RLS 清单：`RLS_DIRECT_USER_TABLES`（有 `user_id`）/ `RLS_SELF_ID_TABLES`（`users`）/ `RLS_CANVAS_CHILD_TABLES`（画板子表，间接归属）/ `RLS_EXEMPT_TABLES`（豁免**必须写明理由**）。四个清单互斥且须覆盖全部 `CREATE TABLE`，由 `arch-tests/rls-coverage.test.mjs` 锁定
- [ ] **新仓储函数用 `getDb()`**（`server/core/db.ts`），不得用 `getPool()`/`pool.query` 直连——无作用域时 `getDb()` 抛 500 `DB_SCOPE_MISSING`（响亮失败），直连则静默零行
- [ ] **跨租户读必须显式 `runWithSystem('理由')`**，且只写在组合层（service/route/job）；`server/repositories/**` 内不得出现 `runWithUser`/`runWithSystem`
- [ ] **归属预读走 `canvas_probe`**（「存在但非属主」= 403 与「不存在」= 404 必须分得开）；新增探针使用点 = 新增一处策略旁路，需在 ADR-0019 论证并更新 allowlist
- [ ] ⛔ **禁 `FORCE ROW LEVEL SECURITY`**：会让探针失效，403 静默退化成 404（arch-test + 真库 `relforcerowsecurity` 断言两道盯着）
- [ ] 运行期 `.env` **不含** `DATABASE_ADMIN_URL`（含则进程拒绝启动）；配了 `DATABASE_URL` 就必须显式配 `DATABASE_SYSTEM_URL`（缺则跨租户路径被 RLS 拦成零行 = 「所有人登录失效」，启动断言同样拒绝）
- [ ] **scope 断言与行断言分开想**：能证明「作用域真的注入了」的判据是 GUC 的值（`current_setting('app.user_id')`），不是行数——行数只在受限角色下有判别力，属主/`BYPASSRLS` 角色下恒为全量

> 来源：#0014 复核（原处方三个前提全不成立：属主正是应用连接串、`app.user_id` 恒为空、`initDbSchema` 内嵌 DML/破坏性 DDL）。
