# 商业级思维图谱 AI SaaS：技术规格说明书与验收清单 (Spec Checklist)

> **版本**：v1.0.0  
> **适用技术栈**：Node.js + Express + TypeScript + PostgreSQL + Google GenAI SDK  
> **文档状态**：待实施基准 (Approved Baseline)

---

## 目录
1. [技术架构总览与选型标准](#一-技术架构总览与选型标准)
2. [模块一：认证体系与 RBAC 权限控制规范](#二-模块一认证体系与-rbac-权限控制规范)
3. [模块二：后端运营管理后台规范 (Admin Spec)](#三-模块二后端运营管理后台规范-admin-spec)
4. [模块三：数据库建模与深度优化规范 (Database Spec)](#四-模块三数据库建模与深度优化规范-database-spec)
5. [模块四：商业风控与 AI 计量拦截规范](#五-模块四商业风控与-ai-计量拦截规范)
6. [模块五：全流程工程验收清单 (Acceptance Checklist)](#六-模块五全流程工程验收清单-acceptance-checklist)
7. [分阶段实施里程碑计划](#七-分阶段实施里程碑计划)

---

## 一、 技术架构总览与选型标准

### 1.1 选型准则
* **拒绝重复造轮子**：严格选用采用宽松开源协议（**Apache 2.0 / MIT**）的业界成熟工业级库，杜绝侵权与版权法务风险。
* **数据与服务完全私有**：不依赖 Google、WeChat 等第三方 OAuth 账号托管，数据资产 100% 掌握在自建 PostgreSQL 中。
* **端到端类型安全**：前后端统一采用 TypeScript，共享实体类型与 DTO 契约。

### 1.2 开源商用依赖矩阵
| 模块 | 开源库 | 协议 | 职能说明 |
| :--- | :--- | :---: | :--- |
| **认证引擎** | `Better-Auth` / 原生安全 Session | **Apache 2.0 / MIT** | 邮箱密码认证、会话维护、密码哈希与防撞库防刷 |
| **参数校验** | `zod` | **MIT** | 运行时请求体强类型白名单拦截，杜绝恶意畸形 Payload |
| **限流防刷** | `express-rate-limit` | **MIT** | 登录接口防暴力破解，AI 接口防恶意高频调用 |
| **安全头增强** | `helmet` | **MIT** | 注入防 XSS、HSTS、防点击劫持等 HTTP 安全响应头 |
| **数据持久** | `pg (node-postgres)` | **MIT** | 高性能连接池，全面采用 `$1, $2` 参数化查询防 SQL 注入 |

---

## 二、 模块一：认证体系与 RBAC 权限控制规范

### 2.1 认证与密码安全标准
* **密码哈希**：使用 `scrypt` 或 `argon2id`（带随机 Salt，计算时间消耗 $\ge 200\text{ms}$，内存消耗 $\ge 64\text{MB}$）。
* **会话管理**：
  * 服务端生成加密强随机 `session_token`，存入 `sessions` 表。
  * 客户端通过 Cookie 传输：`HttpOnly; Secure; SameSite=Lax; Path=/`，彻底免疫 XSS 攻击窃取凭证。
* **暴力破解防御**：单账号连续输错 5 次密码即触发锁定 15 分钟；单 IP 登录请求限制为 15 次/分钟。

### 2.2 RBAC 角色权限模型
| 角色编码 (`role`) | 权限描述 | 访问边界 |
| :--- | :--- | :--- |
| `user` | 普通注册用户 | 只能查看/增删改自己名下的画布与节点；默认分配基础 AI 点数 |
| `vip` | 高级付费用户 | 享有更高的并发调用限制与更大的单次推理上下文配额 |
| `admin` | 运营管理员 | 可访问 `/api/admin/*` 管理端点，拥有全局用户管理与调账权限 |

### 2.3 认证 API 接口契约
* `POST /api/auth/sign-up`：注册新用户（自动创建并写入初始赠送点数，下发会话 Cookie）。
* `POST /api/auth/sign-in`：邮箱密码登录（带连续错误计数重置或锁定校验）。
* `POST /api/auth/sign-out`：登出（物理删除数据库会话记录，清除客户端 Cookie）。
* `GET /api/auth/me`：获取当前登录用户的核心资料、权限角色与点数余额。

---

## 三、 模块二：后端运营管理后台规范 (Admin Spec)

针对商业化上线后的运营维护诉求，构建专用管理接口与审计能力。

### 3.1 用户全生命周期管理
* **用户检索**：支持按邮箱前缀、注册时间区间、当前状态、角色分页查询。
* **账号冻结/解冻**：
  * 冻结用户（`is_active = false`）：中间件拦截该用户的所有后续请求（返回 403 Forbidden）。
  * 强制踢下线：物理清理该用户在 `sessions` 表中的所有活跃会话。
* **人工调账与审计**：
  * 支持管理员手动给用户充值或扣减点数。
  * 任何人工调账必须生成一条 `action_type = 'admin_adjustment'` 的流水账，记录操作员 ID、变动原因、变动前后余额。

### 3.2 商业看板与用量监控 (Telemetry & Metrics)
* **用户指标**：总注册用户数、近 7 日活跃用户 (WAU)、付费用户比例。
* **AI 成本与调用核算**：
  * 当日 / 当月全局消耗的总 Token 数量统计。
  * 各大模型调用量分布（如 `gemini-3.8-flash` vs `gemini-3.1-flash-lite`）。
  * 错误率与容灾监控（统计 429 配额触顶与 503 降级频率）。
* **资源总览**：全站画布总量、活跃节点总数、数据库连接池活跃度。

### 3.3 管理端 API 接口契约
| 端点 | 请求方式 | 职能说明 |
| :--- | :---: | :--- |
| `/api/admin/overview` | `GET` | 运营核心看板数据（用户量、今日消耗 Token、活跃画布） |
| `/api/admin/users` | `GET` | 分页条件检索用户列表（带点数余额与画布数） |
| `/api/admin/users/:id/status` | `PUT` | 启停用户账号状态（冻结/解封） |
| `/api/admin/users/:id/credits` | `POST` | 人工增减用户 AI 点数并留存审计日志 |
| `/api/admin/transactions` | `GET` | 分页拉取全局商业对账流水 |

---

## 四、 模块三：数据库建模与深度优化规范 (Database Spec)

### 4.1 生产级完整 DDL 定义 (PostgreSQL)

```sql
-- 1. 用户核心表 (含商业点数与防爆破锁)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) DEFAULT '' NOT NULL,
    role VARCHAR(20) DEFAULT 'user' NOT NULL CHECK (role IN ('user', 'vip', 'admin')),
    credits_balance BIGINT DEFAULT 50000 NOT NULL CHECK (credits_balance >= 0),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    failed_attempts INT DEFAULT 0 NOT NULL,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2. 安全会话表
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 3. 画布主表（绑定用户多租户隔离）
CREATE TABLE IF NOT EXISTS canvases (
    id VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) DEFAULT '新建思维画布' NOT NULL,
    description TEXT DEFAULT '',
    default_model VARCHAR(64) DEFAULT 'gemini-3.8-flash' NOT NULL,
    viewport_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
    viewport_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
    viewport_zoom DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 4. 节点表
CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(64) PRIMARY KEY,
    canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    type VARCHAR(32) DEFAULT 'question' NOT NULL,
    question TEXT DEFAULT '' NOT NULL,
    answer TEXT DEFAULT '' NOT NULL,
    note TEXT DEFAULT '' NOT NULL,
    pos_x DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
    pos_y DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
    depth INT DEFAULT 0 NOT NULL,
    parent_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
    model_used VARCHAR(64) DEFAULT 'gemini-3.8-flash',
    grounding JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 5. 拓扑连线表
CREATE TABLE IF NOT EXISTS edges (
    id VARCHAR(64) PRIMARY KEY,
    canvas_id VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    source_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type VARCHAR(32) DEFAULT 'smoothstep',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 6. 商业消费记账流水表
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canvas_id VARCHAR(64) REFERENCES canvases(id) ON DELETE SET NULL,
    model_name VARCHAR(64) NOT NULL,
    tokens_consumed INT NOT NULL,
    balance_after BIGINT NOT NULL,
    action_type VARCHAR(32) DEFAULT 'ai_chat',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

### 4.2 索引与性能优化规则
1. **多租户覆盖索引 (Covering Index)**：
   * `CREATE INDEX idx_canvases_user_updated ON canvases(user_id, updated_at DESC);`  
     *优化场景*：用户主页拉取个人画布列表，毫秒级直接走 Index-Scan 消除 Filesort。
   * `CREATE INDEX idx_nodes_canvas_id ON nodes(canvas_id);`
   * `CREATE INDEX idx_edges_canvas_id ON edges(canvas_id);`  
     *优化场景*：打开单张画布时，并发毫秒级加载所有节点与关联线。
2. **全文检索与 JSONB 倒排索引 (GIN Index)**：
   * `CREATE INDEX idx_nodes_fulltext ON nodes USING GIN (to_tsvector('simple', question || ' ' || answer || ' ' || note));`
   * `CREATE INDEX idx_nodes_grounding ON nodes USING GIN (grounding);`
3. **连接池健康调优**：
   * `max: 20`（适度限制最大连接，避免争抢 Postgres 进程资源）。
   * `idleTimeoutMillis: 30000`（空闲连接 30 秒回收）。
   * `connectionTimeoutMillis: 3000`（3 秒快速熔断报错，防止全站挂起）。
   * `statement_timeout: 5000`（单次查询 5 秒强制超时，杜绝慢 SQL 拖垮整库）。
4. **批量保存原子优化**：
   * 画布包含几十上百个节点时，保存请求使用事务包裹批量参数化入库，杜绝网络多次往返。

---

## 五、 模块四：商业风控与 AI 计量拦截规范

### 5.1 预检与原子扣费时序
```
[ 客户端发出问答请求 (POST /api/chat) ]
                  │
                  ▼
[ 1. authMiddleware ] ──> 校验 Session Cookie，提取 user_id 与 role
                  │
                  ▼
[ 2. quotaMiddleware ] ─> 预检: credits_balance >= 100 点？
                  │         ├─ 否 ──> 拦截返回 HTTP 402 (Payment Required)
                  ▼         └─ 是 ──> 放行
[ 3. 调用 Gemini 流式推理 ] ─> 通过 SSE 实时打字机吐字给客户端
                  │
                  ▼
[ 4. 推理完成接收 usageMetadata ] ─> 获取实际 totalTokenCount
                  │
                  ▼
[ 5. DB 事务执行扣点记账 ] ─> UPDATE users SET credits_balance = credits_balance - $tokens WHERE id = $user_id
                           INSERT INTO credit_transactions (...)
```

### 5.2 恶意滥用与账单风控
* **输入字符硬截断**：单次问题文本限制在 4,000 字符内，历史关联节点上下文限制在 16,000 字符内，超出在入口直接返回 400。
* **分级并发速率限制**：
  * 普通用户：10 次请求 / 分钟。
  * VIP 用户：30 次请求 / 分钟。
  * 单 IP 访问频次硬拦截：超出直接触发 HTTP 429 Too Many Requests。

---

## 六、 模块五：全流程工程验收清单 (Acceptance Checklist)

### 阶段 1：基础认证与租户隔离验收
- [x] **注册流程验证**：使用新邮箱与密码完成注册，密码在数据库中以不可逆哈希形式落库，自动获赠 50,000 初始点数。
- [x] **登录鉴权验证**：登录成功后下发 `HttpOnly` 签名 Cookie，刷新浏览器页面能保持登录态。
- [x] **暴力破解防御验证**：人为连续输错 5 次密码，触发账户锁定，提示“请在 15 分钟后重试”。
- [x] **安全退出验证**：登出后服务端会话被物理销毁，再次调用 `/api/auth/me` 返回 401。
- [x] **水平越权防御 (IDOR)**：登录用户 A，手工调用接口请求用户 B 的 `canvas_id`，服务端强制返回 404 或 403，绝不泄露他人数据。

### 阶段 2：商业风控与 AI 扣费验收
- [x] **零点数拦截验证**：将测试用户的 `credits_balance` 改为 0，发起 AI 提问，服务端在调用 Google API 前直接拦截，提示余额不足。
- [x] **Token 精准扣除验证**：发起一次完整问答，对比 Gemini 返回的 `usageMetadata.totalTokenCount`，用户余额准确扣减对应数值，并在 `credit_transactions` 表新增一条流水。
- [x] **超长 Payload 拦截**：构造超过 4000 字符的畸形提问体，入口中间件直接拦截报错，不产生模型账单。

### 阶段 3：管理后台 (Admin) 验收
- [x] **越权访问拦截**：以普通 `user` 身份访问 `/api/admin/*` 接口，一律返回 403 Forbidden。
- [x] **全局监控加载**：以 `admin` 账号登录，仪表盘成功展示注册用户总数、今日消耗 Token 总量、画布总量。
- [x] **用户启停操作**：管理员冻结某违规用户后，该用户的所有后续请求立即被拒并强制退登。
- [x] **手动调账审计**：管理员在后台给指定用户充值点数，用户前端刷新可见，且生成一条带操作员标识的审计流水。

### 阶段 4：数据库与系统健壮性验收
- [x] **SQL 注入扫描**：检查全站所有增删改查 SQL，100% 杜绝文本拼接，全量走参数化绑定。
- [x] **索引命中验证**：通过 `EXPLAIN ANALYZE` 验证多租户核心查询 `WHERE user_id = $1` 命中索引，无全表扫描。
- [x] **连接池健康度**：高频并发请求下，连接池无 unreleased client 挂死现象。

---

## 七、 分阶段实施里程碑计划

1. **里程碑一（核心地基）**：
   * 执行数据库迁移（新增 `users`、`sessions`、`credit_transactions`，为 `canvases` 绑定 `user_id`）。
   * 编写认证中间件与用户注册/登录/退出/个人信息接口。
   * 为现有画布 CRUD 全面注入 `WHERE user_id = $1` 租户隔离。
2. **里程碑二（AI 商业化闭环）**：
   * 在 `/api/chat` 中接入点数预检、使用量记账与原子扣点。
   * 前端顶部栏接入登录/注册弹窗，实时显示用户头像与剩余 AI 点数。
3. **里程碑三（管理后台与优化）**：
   * 编写 `/api/admin/*` 管理端点与 RBAC 鉴权拦截。
   * 挂载系统监控指标、用户启停与调账界面。
   * 完成生产索引调优与最终联调整体测试。
