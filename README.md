# 枝想 - 无限画布式 AI 深度思维与分支探索工作台

> **枝想** 是一款面向研究员、架构师、深度自学者与创作者的**生产级二维拓扑 AI 思考工作台**。它打破了传统 AI 聊天单一线性滚屏的限制，让每一次思维发散、深度追问与多方案对比都能在无限画布上自由流淌与沉淀。

---

## 🌟 核心特性与创新价值

1. **二维无限画布与智能免拖拽布局 (Zero-Drag Auto-Layout)**
   - 基于 `@xyflow/react` (React Flow v12+) 与拓扑递归算法，系统自动计算分支节点最佳水平深度与垂直安全间距，保持全图整洁且绝不重叠。
   - 支持平移、20% ~ 200% 动态缩放、微缩全局导航小地图 (Minimap) 与平滑运镜自适应居中。

2. **划词深入探索 (Go Down The Rabbit Hole)**
   - 在任意 AI 回答中选中特定概念或词句，即刻触发悬浮追问菜单，在右侧衍生出带有引用来源标签的有向分支节点。

3. **超大画布性能保障与分支剥离导出 (150+ Nodes Subtree Export)**
   - 内置图谱节点容量智能检测。当节点超过 150 个时，自动提示引导用户将任意子树分支与其关联边一键**“导出为独立画板 (Branch Off to StoredBoard)”**，并从主画布剪切精简，释放 DOM 内存开销。

4. **极简防挤压卡片设计 (Clean Ergonomic Node Header)**
   - 彻底优化节点头部交互，移除冗余的深度数字标签，统一采用紧凑单行操作区，避免小尺寸卡片上的按钮换行挤压。
   - 支持一键卡片折叠/展开、便签笔记撰写、多色分类标记与 Markdown/公式排版。

5. **全要素持久化与企业级生产数据库架构**
   - 采用 **PostgreSQL 14+** 关系型数据库底座，配套 **内存双模自动容灾 (In-Memory Fallback)**。
   - 严格保证数据零丢失：完整保留节点标题、正文、便签、多轮对话序列 (`messages` JSONB)、卡片折叠状态、主题色、自定义数据以及 React Flow 连线锚点 (`source_handle`, `target_handle`, `animated`)。
   - 具备 GIN 全文检索索引，毫秒级检索海量节点知识。

6. **全链路商业化体系与安全审计**
   - **强制登录 + 多租户 RBAC 权限**：体验版 (User)、VIP 会员 (VIP)、系统管理员 (Admin)。
   - **服务端强制配额**：体验版最多 3 个画板、每画板 10 个 AI 推理节点；VIP 画板与节点无限，独享高优先级队列与 `is_vip_only` 高级模型。四类权益限制全部由后端中间件校验，直连 API 无法绕过。
   - **订阅与订单审计 (`orders`)**：周度 Pro 会员（周卡）¥9.9 / 月度 Pro 会员（月卡）¥24.9 / 年度 Pro 会员（年卡）¥199。一期不接真实支付，通过 `PaymentProvider` 抽象 + `MockProvider` 跑通订单全生命周期，VIP 由 Admin 后台赠送。
   - **模型推演审计 (`ai_request_logs`)**：审计端到端推演延迟 (ms)、Token 明细、联网 Grounding 引用与异常错误栈。
   - **安全审计**：角色阶梯限流（体验版 25 / VIP 60 / Admin 120 次每分钟）、登录防爆破锁定、`user_audit_logs` 操作留痕。

---

## 🛠 技术栈与架构全景

- **前端架构**：React 19 + TypeScript + Tailwind CSS v4 + @xyflow/react (React Flow)
- **后端架构**：Node.js + Express (Port 3000) + Vite Middleware + Server-Sent Events (SSE) + Nodemailer（邮箱验证/找回密码事务邮件，开发环境对接 Mailpit）
- **AI 推演代理**：`@google/genai` (`gemini-3.8-flash`，容灾链 `gemini-3.1-flash-lite` → `gemini-flash-latest`) + OpenAI 协议模型热备容灾 + Google Search Grounding 联网检索
- **数据与安全**：PostgreSQL (pg) + Node Crypto (scrypt N=2^16/r=8/p=1，版本头哈希格式) + IP/UserAgent 会话风控 + 角色阶梯限流

---

## 📁 目录工程结构

```text
/
├── docs/
│   ├── 需求说明文档.md               # 业务需求、产品定位与交互规格 (PRD)
│   ├── 技术架构文档.md               # 架构选型、数据表模型与核心算法设计
│   ├── 数据库建表脚本.sql            # PostgreSQL 19 张表完整建表与高性能索引 DDL
│   ├── 开发规范.md                   # 分层架构与编码约定
│   ├── specs/                        # 各轮变更 Spec（历史变更记录，A1-F6/G）
│   └── 里程碑与分期规划.md           # 锁定的产品决策、一期/二期分期与验收标准
├── server/
│   ├── core/                       # 基础设施：连接池(pool)、建表迁移(schema)、内存兜底存储(memory-store)、记录类型(records)、状态诊断(db-status)
│   ├── repositories/               # 数据访问层：PG 优先 + 内存兜底的双模读写（user/session/billing/ai/feedback/canvas/admin）
│   ├── services/                   # 业务编排层：注册登录、订阅充值、画布规则、Admin 掩码与调账、反馈
│   │   └── payment/                # PaymentProvider 抽象 + MockProvider（一期不接真实支付）
│   ├── middleware/                 # 鉴权中间件、阶梯限流、防爆破保护、配额校验(quota)、统一错误处理
│   ├── jobs/                       # 后台任务：日志留存清理（ai_request_logs 90 天 / user_audit_logs 180 天）
│   ├── lib/                        # 纯工具：scrypt 密码散列(crypto)、统一错误类型(errors)、asyncHandler、zod 校验(validate)、邮件发送(mailer)
│   └── routes/
│       ├── auth.ts                 # 注册、登录、邮箱验证/重发、找回密码、账号注销、会话与风控路由
│       ├── canvases.ts             # 画布全字段 CRUD、批量保存与服务端持久化
│       ├── chat.ts                 # SSE 流式模型推演、多模型容灾与延迟日志审计
│       ├── subscriptions.ts        # 订单创建、模拟支付回调与订单列表（Mock 全生命周期）
│       └── admin.ts                # 管理员大盘、用户管理、VIP 赠送、订单管理、审计日志查询与全局配置
├── src/
│   ├── components/                 # 画布视口、节点卡片、工具栏、导航小地图等组件
│   ├── context/                    # 全局状态 Context（鉴权等）
│   ├── hooks/                      # 画布与节点相关自定义 Hooks
│   ├── lib/                        # 前端工具与 API 客户端
│   ├── types.ts                    # 核心 TypeScript 类型契约
│   ├── App.tsx                     # 根应用主视图
│   └── main.tsx                    # React 19 应用入口
├── tests/                          # 各 Spec 回归测试（a1-guest-removal 等）
├── index.html                      # HTML5 网页主入口与 SEO 元信息
├── server.ts                       # 全栈后端启动入口 (Express + Vite，含日志清理任务启动)
├── package.json
└── README.md                       # 本说明文档
```

---

## 🚀 快速启动与开发指南

### 1. 环境变量配置
在根目录新建或配置 `.env` 文件（参考 `.env.example`）：
```bash
# 必填：Gemini 模型 API 密钥
GEMINI_API_KEY=your_gemini_api_key_here

# 可选：PostgreSQL 数据库连接串（若未配置将自动平滑降级为内存持久化）
DATABASE_URL=postgresql://postgres:password@localhost:5432/arborize
```

### 2. 启动开发服务器
```bash
npm run dev
```
服务将启动在 `http://localhost:3000`，支持 Express API 与前端 Vite 热重载。

### 3. 生产打包与运行
```bash
# 构建前端静态文件并使用 esbuild 打包后端
npm run build

# 启动生产服务
npm start
```

### 4. 首次启动必须配置模型（Bootstrap 必做）
模型的唯一来源是管理后台配置（代码内不预置模型）。**首次启动后必须以管理员账号
登录 → 管理后台 →「模型配置」选择模型并保存**，否则全站 AI 推理将返回
`400 MODEL_NOT_CONFIGURED`。未配置时，Admin 总览页顶部会展示醒目的红色告警横幅
（E4：模型配置单点依赖告警）。

---

## 📚 详细文档导航

- [📖 业务需求说明书 (PRD)](./docs/需求说明文档.md)
- [🏗 系统技术架构文档](./docs/技术架构文档.md)
- [🗺 里程碑与分期规划](./docs/里程碑与分期规划.md)
- [📏 开发规范](./docs/开发规范.md)
- [📋 变更 Spec 清单（历史变更记录）](./docs/specs/)
- [💾 数据库初始化 SQL 脚本](./docs/数据库建表脚本.sql)
