# ADR-0001: 单端口全栈（Express + Vite middleware 同跑 3000）

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: deployment, dev-experience, testing

## Context and Problem Statement

枝想前端（React 19 + Vite）与后端（Express + SSE）需要一套**部署与开发同源**的运行模式。传统方案是前端 5173 + 后端 3000，但会带来：

- 跨域 Cookie 需 `SameSite=Lax` + `withCredentials`，登录态复杂；
- SSE 长连接需自定义 CORS 头；
- 反代配置维护成本（`/api` → 3000，`/` → 5173）；
- 集成测试需要 mock 两个端口。

## Decision Drivers

- 消除 CORS / Cookie 跨域问题；
- SSE 同端口天然长连接；
- 集成测试可直接 `createApp()` + 随机端口；
- 一份 Express 工厂覆盖开发与生产。

## Considered Options

- **Option A: 前后端分离双端口**（Vite 5173 + Express 3000，反代统一）
- **Option B: 单端口 + Vite middlewareMode**（生产 `express.static(dist)`，开发 `vite.middlewares`）
- **Option C: 纯静态站点 + 独立 API**（前端 SSG，CDN 托管）

## Decision Outcome

**Chosen option: B**, because 它同时满足开发体验（SSE/Cookie/热更）与生产部署（同进程、低延迟），且让 `createApp()` 成为唯一可被测试实例化的工厂。

### Positive Consequences

- 零 CORS 配置，SSE 走同源；
- `server/app.ts:createApp()` 工厂让集成测试**零 HTTP mock**；
- 生产构建（`npm run build`）输出 `dist/server.cjs` + `dist/` 静态资源，单一 Node 进程跑全栈。

### Negative Consequences

- Vite 与 Express 共用进程，Vite 中间件的开发期错误可能掩盖 Express 错误；
- 端口被抢占时需手动切换（生产用 `PORT` 环境变量）；
- 水平扩展时仍需反代做负载均衡（单端口不解决 L4 问题）。

### Follow-up / Mitigation

- 反代配置文档化在 `docs/部署指南.md`（待建）；
- `app.set('trust proxy', 1)` 配合 `X-Forwarded-For` 取真实 IP（见 ADR-0007 风险）。

## Pros and Cons of the Options

### Option A: 前后端分离双端口

- **Good**: 各进程独立重启、隔离；CDN 友好；前端可独立部署到 Vercel/Netlify
- **Bad**: CORS 配置；Cookie 跨域；集成测试双端口；反代配置维护

### Option B: 单端口 + Vite middlewareMode（已选）

- **Good**: 零 CORS；零反代配置；测试工厂化；SSE 同源
- **Bad**: Vite 与 Express 共享进程；水平扩展需反代

### Option C: 纯静态 + 独立 API

- **Good**: 极致 CDN 友好；首屏极快
- **Bad**: 失去画布实时保存（要轮询）；与本项目"SSE 流式推演"的核心交互冲突

## References

- 代码：`server.ts:18-45`、`server/app.ts:19-78`、`vite.config.ts:6-21`
- 文档：`README.md` §快速启动、`docs/技术架构文档.md` §1.1
