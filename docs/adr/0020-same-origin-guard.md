# ADR-0020: 变更方法同源守卫 + 会话 cookie 属性单一事实源

- **Status**: Accepted
- **Date**: 2026-09-12
- **Deciders**: 枝想架构组
- **Tags**: security, csrf, session

> **治理注记**：本 ADR 追认的实现落在提交 `aba4126`，在用户批准的实施方案
> （`技术债 #0014 / #0013 收口`）下先行落地，此处补齐 ADR。

## Context and Problem Statement

技术债 #0013（中）原写「CSRF 防护不完整」，其处方是「给 SSE 端点加 `X-Requested-With`」。
核对实现后，真实缺口与处方不符——实际暴露面**比清单写的小**，但防线的性质更糟：

- cookie 已是 `httpOnly` + `sameSite: 'lax'` 且**无 domain**，全仓无 CORS 中间件，
  经典 CSRF（跨站表单/跨站 fetch 携带凭据）已被 `SameSite=Lax` 挡住；
- 处方点名的 SSE 端点不受影响：`EventSource` 不能自定义头，但那些端点**不改状态**；
- 真正的问题是整条防线**完全隐式**：没有任何测试锁住 cookie 属性，
  谁把它改成 `sameSite: 'none'` **不会有任何东西变红**；
- 且 `express.urlencoded()` 是**全局**挂载的，表单编码面暴露在所有端点上；
- 另有两个**改状态的 GET**（`GET /api/auth/verify-email`、`GET /api/shares/:shareCode`），
  靠不可猜 token/code 自保。

## Decision Drivers

- 已建立的防线必须**显式化**：属性/来源校验要有会变红的契约；
- 不误伤非浏览器客户端：curl、服务端调用、支付宝异步通知、既有 51 个测试文件
  **都不带 `Origin`**（`tests/` 全树 0 命中）；
- 浏览器跨站变更请求**必带** `Origin`，因此「无 `Origin` 放行」不放松浏览器侧防线；
- 最小侵入：不改任何既有 API 契约。

## Considered Options

- **Option A: 全局 CSRF Token（csurf 一类）** — 最强，但要改全部前端调用点与
  全部测试，且对纯 API 客户端引入新契约。
- **Option B: 加 `X-Requested-With` 白名单**（原处方）— 对 SSE 无意义，
  且同样是隐式约定。
- **Option C: 变更方法同源守卫 + cookie 属性单一事实源 + 收窄表单编码面**（已选）。

## Decision Outcome

**Chosen option: "C"**。

### 一、同源守卫（`server/middleware/same-origin.ts`）

挂在 `app.ts` 的 body parser 之后、所有路由之前，只作用于 `POST/PUT/PATCH/DELETE`：

- `Sec-Fetch-Site: cross-site` → 403 `CSRF_ORIGIN_REJECTED`；
- 带 `Origin`（或可从 `Referer` 推导）且不等于 `APP_URL` 的 origin 或
  `req.protocol://req.get('host')` → 403。`Origin` 优先于 `Referer`；
- **不带 `Origin` 一律放行**——这是与非浏览器客户端的显式契约，由测试锁定。

### 二、会话 cookie 属性单一事实源（`server/lib/session-cookie.ts`）

下发与清除共用 `sessionCookieOptions()`：`httpOnly` / `sameSite: 'lax'` / `path: '/'` /
无 `domain` / `secure` 仅生产。**属性在调用时求值**，规避 dotenv 时序坑
（模块级读 `NODE_ENV` 恒 `undefined`）。此前清除侧有 `{ path: '/' }` 的弱化写法
（属性弱于下发），现已归一。

### 三、收窄表单编码面

`express.urlencoded()` 由全局挂载收窄到 `POST /api/subscriptions/notify` 单端点
（全仓唯一表单编码消费方，ADR-0014）。

### 两个改状态的 GET：**保持现状，记为已接受**

`GET /api/auth/verify-email` 与 `GET /api/shares/:shareCode` 靠不可猜 token/code 自保，
不改。理由：它们的令牌不可枚举、且有一次性/幂等语义，改成 POST 会破坏邮件链接与
分享链接的可用性，收益不成比例。

### Positive Consequences

- 隐式防线变成显式契约：cookie 属性与同源规则各有测试锁定，改动会变红；
- 去掉了全局表单编码面；
- 非浏览器客户端契约被**明写并锁定**（无 `Origin` 放行），不会日后被误改成「一律拒绝」。

### Negative Consequences

- 「无 `Origin` 放行」意味着**非浏览器**客户端不受该守卫保护——这是刻意的取舍，
  其可信边界是「不携带用户 cookie 的服务端调用」；
- 同源判定依赖 `APP_URL` 与反代传递的 `Host`/`X-Forwarded-*` 正确；
- 不覆盖两个改状态的 GET（已在上文记为接受）。

## References

- 代码：`server/middleware/same-origin.ts`、`server/lib/session-cookie.ts`、`server/app.ts`、
  `server/routes/auth.ts`、`server/middleware/auth.ts`
- 测试：`tests/csrf-same-origin.test.ts`（14 例）、`tests/cookie-attributes.test.ts`（4 例）、
  `arch-tests/csrf-guard.test.mjs`
- 关联：技术债 #0013；`docs/adr/0014-alipay-page-pay.md`（表单编码唯一消费方）
