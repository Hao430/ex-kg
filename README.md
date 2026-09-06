# DeepDive - 无限画布式 AI 深度思维与分支探索工作台

> **DeepDive** 是一款面向研究员、架构师、深度自学者与创作者的**生产级二维拓扑 AI 思考工作台**。它打破了传统 AI 聊天单一线性滚屏的限制，让每一次思维发散、深度追问与多方案对比都能在无限画布上自由流淌与沉淀。

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
   - **多租户 RBAC 权限**：普通用户 (User)、VIP 深度会员 (VIP)、系统管理员 (Admin)。
   - **算力消费平账账本**：精确记录每次推理 Token 扣减与消费流水 (`credit_transactions`)。
   - **订单审计系统 (`orders`)**：VIP 体验周卡、深度月卡、尊享年卡订单生命周期管理与对账。
   - **模型推演审计 (`ai_request_logs`)**：审计端到端推演延迟 (ms)、Token 明细、联网 Grounding 引用与异常错误栈。

---

## 🛠 技术栈与架构全景

- **前端架构**：React 19 + TypeScript + Tailwind CSS v4 + @xyflow/react (React Flow)
- **后端架构**：Node.js + Express (Port 3000) + Vite Middleware + Server-Sent Events (SSE)
- **AI 推演代理**：`@google/genai` (Gemini 3.8 Flash / Gemini 2.5 Pro) + 多源 OpenAI 协议模型热备容灾 + Google Search Grounding 联网检索
- **数据与安全**：PostgreSQL (pg) + Node Crypto (scrypt / bcrypt) + IP/UserAgent 会话风控

---

## 📁 目录工程结构

```text
/
├── docs/
│   ├── 需求说明文档.md               # 业务需求、产品定位与交互规格 (PRD)
│   ├── 技术架构文档.md               # 架构选型、数据表模型与核心算法设计
│   └── 数据库建表脚本.sql            # PostgreSQL 14 张表完整建表与高性能索引 DDL
├── server/
│   ├── db.ts                       # 数据库连接池、双模持久化、自动迁移与业务逻辑
│   ├── middlewares.ts              # 鉴权中间件、阶梯限流、防爆破保护
│   └── routes/
│       ├── auth.ts                 # 登录、注册、会话与风控路由
│       ├── canvas.ts               # 画布全字段 CRUD、分享与快照
│       ├── chat.ts                 # SSE 流式模型推演与延迟日志审计
│       ├── user.ts                 # 用户资料、充值订阅与订单历史
│       └── admin.ts                # 管理员大盘、用户管理与全局配置
├── src/
│   ├── components/                 # 画布视口、节点卡片、工具栏、导航小地图等组件
│   ├── types.ts                    # 核心 TypeScript 类型契约
│   ├── App.tsx                     # 根应用主视图
│   └── main.tsx                    # React 19 应用入口
├── index.html                      # HTML5 网页主入口与 SEO 元信息
├── server.ts                       # 全栈后端启动入口 (Express + Vite)
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
DATABASE_URL=postgresql://postgres:password@localhost:5432/deepdive
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

---

## 📚 详细文档导航

- [📖 业务需求说明书 (PRD)](./docs/需求说明文档.md)
- [🏗 系统技术架构文档](./docs/技术架构文档.md)
- [💾 数据库初始化 SQL 脚本](./docs/数据库建表脚本.sql)
