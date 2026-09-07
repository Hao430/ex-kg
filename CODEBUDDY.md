# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

枝想 Arborize：生产级二维拓扑 AI 思考工作台。React 19 + Vite 前端与 Express 后端**单端口**运行（Port 3000），PostgreSQL + 内存双模持久化。文档权威口径见 `docs/`（需求说明/技术架构/里程碑与分期规划/数据库建表脚本.sql）。

## 常用命令

```bash
npm run dev        # 开发：tsx server.ts（Express + Vite HMR，http://localhost:3000）
npm run lint       # 类型检查：tsc --noEmit（验收必过项）
npm test           # 全量测试：PAYMENT_ENABLED=true tsx --test 'tests/*.test.ts'
npx tsx --test tests/d3-email-verification.test.ts   # 跑单个测试文件
npm run build      # vite build + esbuild 打包后端为 dist/server.cjs
npm start          # 生产运行
```

**测试框架是 node:test（`tsx --test`），不是 vitest**——用 vitest 跑会全部报「No test suite found」。测试套件只跑 memory 模式；PG 分支无测试覆盖，上线前需连真库冒烟。

## 架构大图

### 双模持久化（贯穿全后端的核心模式）

- `server/core/schema.ts` 是**建表唯一事实源**（20 张表，启动自动增量迁移 `initDbSchema()`），`docs/数据库建表脚本.sql` 为同步设计稿，两者出入以 schema.ts 为准。
- 未配 `DATABASE_URL` 或 PG 访问失败时自动降级 `server/core/memory-store.ts`（单例 Map/数组，启动时播种 3 个种子账号，email_verified=true）。
- `server/repositories/*` 每个函数固定双模写法：PG try → 成功 return；catch 或无 pool → 落内存；**业务错误（AppError 子类如 ForbiddenError/NotFoundError）必须在落内存前 rethrow，禁止 catch 吞掉造成 200 假成功**（参考 `canvas.repository.ts` 的 `deleteCanvas`）。新增数据访问必须照此模板（参考 `user.repository.ts` 的 `setVerificationToken`）。过期判断用 `> NOW()`；用户与画布查询均带 `deleted_at IS NULL`（F4 注销 / H1 画布软删口径）。
- **内存分支输出必须与 PG 分支归一化对齐**：内存 getCanvas 经 `normalizeMemoryNode()` 重建 node.data（与 PG 分支同款默认值清单），改任一分支时两路同步；grounding 直通不补默认值（a3 测试锁定）。

### 后端分层

`routes`（zod schema 定义在路由文件顶部，经 `validate()` 校验）→ `services`（业务编排）→ `repositories`（双模）→ `core`（pool/schema/memory-store/records）。错误统一抛 `lib/errors.ts`（`ValidationError`/`ConflictError`/`AppError(status, code, message)` 等），由 `errorHandler` 序列化为 `{error, code}` JSON。

- 鉴权：cookie 会话（`session_token`，7 天）；`middleware/auth.ts` 提供 `authMiddleware`/`requireAdmin` 与全部限流器（新端点必须独立 limiter 实例）。
- 未验证邮箱拦截：`middleware/quota.ts` 对非 admin 的 chat 请求返回 403 `EMAIL_NOT_VERIFIED`；登录不拦截。
- 注册（2026-09 重设计）：**验证码先行**——`POST /api/auth/send-register-code` 发 6 位码（10 分钟、每邮箱 60s 冷却、每 IP 5/h，存 `email_verification_codes` 表）→ `sign-up` 携码原子消费（连错 5 次作废）才建号，出生即 `email_verified=true`。链接式 `/verify-email` 与 `/resend-verification` 保留，**仅服务 admin 换绑邮箱后的二次验证**。
- 邮件：`server/lib/mailer.ts` 双模式——SMTP 四个环境变量齐备走真发；否则 jsonTransport 干跑进内存 outbox（测试经 `getOutboxForTest()` 断言，上限 50 条）。链接依赖 `APP_URL`。
- 模型配置语义：推理模型唯一来源是管理后台 `ai_model_config`（`getSavedAiModelConfig()` **不合并默认值**）；管理员未选模型时 chat 返回 400 `MODEL_NOT_CONFIGURED`。`DEFAULT_AI_MODEL_CONFIG.gemini_model` 保留为白名单 bootstrap，不可清空（测试锁定）。
- **画布访问权限（H1，跨 getCanvas/saveCanvas/deleteCanvas 的核心口径）**：严格属主制——读/写/删一律属主本人或 admin；唯一放行是 `isSharedDefaultCanvas()`（`default-board`/`default-canvas` 全局共享同一行）且**默认板禁删**（软删会锁死全局默认板）。画布删除是软删（`UPDATE SET deleted_at=NOW()`，子表 nodes/edges 即时物理清），saveCanvas 对已软删 id 抛 404 且 upsert 带 `WHERE deleted_at IS NULL` 防复活。前端画板 id 为 `board-${Date.now()}` 可枚举，勿再引入任何前缀/属主放行。
- **chat 链路（I 组）**：前端 `/api/chat` 请求体必须带 `canvasId`+`nodeId`（审计归因 + 配额）；`chatQuotaMiddleware` 对体验版按画布数 chat 节点（**含 suggested 占位**）≥10 拦 403 `NODE_LIMIT_REACHED`。联网为**静默恒开**（web_search 工具无条件附加，`enableWebSearch` 字段被 zod 剥离是预期行为）；来源提取走 `collectSources` 防御式三源回退，上限 30 源/10 询；正文 `[n]` 角标与来源列表编号一一对应（system 指令 + 前端 `linkifyCitations` 上标徽章）。
- 支付：一期 `PAYMENT_ENABLED` 关闭在线充值（订阅接口 503），`PaymentProvider` 抽象 + `MockProvider`；VIP 由 Admin 赠送。

### 前端结构

- `src/main.tsx` 按 pathname 分流：`/reset-password`、`/verify-email` 独立落地页（无 AuthProvider，裸 fetch）；其余走 `App.tsx`（AuthProvider 包裹的画布应用）。
- 画布保存与删除：`src/lib/storage.ts` 本地 + `sync-queue`（状态机 `pending/saved/conflict/error`；saved 3 秒后回退 idle）。乐观锁冲突派发 `deepdive:canvas-save-conflict` 事件。`deleteBoard` 是**确认制**：仅服务端 2xx/404 才清本地并 `sync-queue.dequeue(boardId)`（防删除后被自动保存写回复活），403/断网保留本地并返回 `{ok:false}` 由 App 提示。
- 新用户引导：空白初始画布（新账号/画板全删空/新建画板）统一经 `App.tsx` 的 `createStarterRootNode()` 注入「新探索主题」待填根节点，不允许出现纯空白画布。
- 品牌与文案（面向用户的文案一律不出现内部术语）：模型品牌/型号、Google 字样、开源库名（KaTeX 等）、「商业级/多租户/RBAC/沙箱/鉴权/IDOR」这类架构自述词一律不用（如需提及用「前沿大模型」「实时联网检索」「数据按用户严格隔离」）。推荐探索课题为可深挖的学习型议题（哲学概念、AI 概念等），不用遥远的前沿论文题。

## 测试约定

- 每个测试文件独立进程：`createApp()` + `http.createServer` 随机端口 + `waitSeeds()` 轮询 `/api/db/status`（userCount ≥ 3）。
- 文件内多次注册/发码会顶满 5/h 的 IP 限流，重号用例前用 `limiter.resetKey(ipKeyGenerator('127.0.0.1'))` 复位（express-rate-limit v8 无公开 store）。
- 注册辅助走验证码流程：`send-register-code` → 从 outbox 提取 6 位码 → `sign-up`（参考各文件的 `registerViaCode`）。
- 测试内拦外部 API 用 fetch 分发器：保存 `origFetch`，按 URL 分发 stub（如 chat.ts 调千问 `/responses` 返回构造的 SSE Response），其余透传，`after` 钩子恢复（先例 `tests/h2-grounding-chain.test.ts`）。
- 断言审计日志用 `getAiRequestLogsForTest()`（`ai.repository.ts`，读内存单例，**newest-first/unshift**）；middleware 层拒绝（如 NODE_LIMIT_REACHED）不写审计，只能行为断言。
- 验收标准：新测试全绿 + 既有用例不回归 + `tsc --noEmit` 通过。

## 工作约定（本项目强制）

- **import 一律带 `.js` 后缀**（ESM node16 解析），包括类型导入。
- `docs/specs/` 始终只读（历史 Spec 不改，重设计决策记入里程碑文档）；`docs/` 其他文档更新需用户确认；`tests/` 目录只读，例外需用户显式授权（历次豁免已记录在提交信息中）。
- 完成实施后按惯例报告：修改文件清单、验收结果、边界决策。
