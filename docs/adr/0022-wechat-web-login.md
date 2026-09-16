# ADR-0022: 接入微信开放平台「网站应用」登录

- **Status**: Accepted
- **Date**: 2026-09-16
- **Deciders**: 枝想架构组
- **Tags**: auth, oauth, wechat, rls, security

## Context and Problem Statement

邮箱 + 口令是当前唯一的登录方式（`users.email` 与 `users.password_hash` 均为 `NOT NULL`）。
需要接入微信开放平台的「网站应用」扫码登录（OAuth2 `authorization_code`，`scope=snsapi_login`），
让用户以微信身份直接进入工作台，而不是先注册一个邮箱账号。

三个约束决定了这不是「加一个登录按钮」那么简单：

1. **微信不返回邮箱，也不返回口令**。`sns/userinfo` 只给 `openid` / `unionid` / 昵称 / 头像
   （性别与地区自 2021-10-20 起已不再返回）。而现有账号体系要求邮箱与口令都非空。
2. **回调必然是浏览器顶层 GET 导航**：微信只支持 302 回跳，而 `same-origin.ts` 的
   `MUTATING_METHODS` 刻意只含 `POST/PUT/PATCH/DELETE`（ADR-0020），即回调端点**不受同源守卫保护**，
   而它偏偏要建账号、下发会话。
3. **鉴权机制属于强制写 ADR 的变更**（`docs/adr/0000-adr-template.md` §2）：本决策改变登录方式、
   新增一张表、并新增一处「改状态的 GET」。

## Decision Drivers

- 不破坏既有账号体系：邮箱登录、F4 注销、会话、配额、VIP 全部要自然复用；
- 用户回流要顺滑：微信用户首次授权即可进入，不强制先绑邮箱；
- 与既有防线一致：RLS 三清单、同源守卫、限流器独立性、双模持久化都不能被绕过；
- 少一个新变量/少一个新依赖，就少一次「错一个字母静默失效」；
- 一个微信用户**不能因为重复授权而被建出第二个账号**。

## Considered Options

- **Option A: 给 `users` 加 `wechat_openid`/`wechat_unionid` 两列** — 改动最小，但把凭据混进画像表。
- **Option B: 新建 `oauth_identities` 表承载身份绑定**（已选）。
- **Option C: 不做微信注册，只允许已登录用户绑定微信** — 最保守，但拿不到微信的拉新价值。
- 交互形态：**整页跳转** vs **弹窗内嵌二维码**（引入 `res.wx.qq.com` 的 `wxLogin.js`）。
- 账号构造：**占位邮箱 + 不可满足的口令** vs 把两列改成可空。

## Decision Outcome

**Chosen option: "B" + 整页跳转 + 占位邮箱。**

### 一、身份表 `oauth_identities`（不改 `users` 结构）

```sql
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
provider VARCHAR(32) NOT NULL,          -- 'wechat'
openid  VARCHAR(128) NOT NULL,          -- 应用维度唯一标识 = 身份键
unionid VARCHAR(128),                   -- 开放平台主体维度标识（同人跨应用相同）
UNIQUE (provider, openid)
```

- **`unionid` 上只有普通索引，刻意不是唯一索引**。它标识的是「同一个人」，而一个人在小程序与
  网站应用下各有一个 openid = **两行**，两行 unionid 相同。把它建成唯一索引会直接**堵死**
  「另一个应用的 openid 挂到同一账号」这条路径（实现过程中被 `tests/wechat-login.test.ts`
  的同人收敛用例当场抓出）。同人收敛改为建号前**显式查询**一次。
- 表归入 `RLS_DIRECT_USER_TABLES`（有 `user_id`），策略由 `schema.ts` 的循环自动生成；
  登录前的按 openid 查询走 `runWithSystem`（与 `findUserByEmail`/`findSession` 同构）。
- 无 `deleted_at`：身份是**凭据映射**而非用户数据。注销（软删）时不动它，F4 语义由
  「JOIN 出的 `user.deleted_at`」判定；30 天硬删时由 FK `ON DELETE CASCADE` 清理
  （内存分支由 `purgeUserDataMemory` 对齐）。
- 建号与建身份在**同一事务**内完成（`db.withTransaction`，先例 `settlePaidOrder`）：
  拆两段会留下「有账号、无任何登录方式」的孤儿，每次重试再泄漏一个。

### 二、占位账号

| 字段 | 取值 | 理由 |
| :--- | :--- | :--- |
| `email` | `wx_<sha256(openid)[0:32]>@wechat.invalid` | 确定性（并发回调自然收敛）；`.invalid` 是 RFC 2606 保留 TLD，永不可达；取哈希而非拼 openid，因为 openid 大小写敏感而邮箱会被 lower-case 归一，直接拼会让两个 openid 撞成同一邮箱 |
| `password_hash` | `OAUTH_UNSET_PASSWORD_HASH = '!wechat-oauth-no-password!'` | **不含冒号** → `parseAndVerify` 在 `rest.split(':')` 后立即返回 `false`，零 scrypt 开销且永不通过。比「随机密钥的哈希」更好：后者每次建号烧 64MB/≥200ms，安全性却等价 |
| `email_verified` | `true` | 否则 `middleware/quota.ts` 对所有 chat 请求返 403 `EMAIL_NOT_VERIFIED`，账号出生即废 |
| `name` | 昵称清洗后按**码点**截断到 50，空则 `微信用户` | 与 `SignUpSchema` 的 `max(50)` 口径一致；按码点截断避免切断 emoji 代理对 |

注册口必须拒 `@wechat.invalid`（`signUp`/`sendRegisterCode` 均拦，400 `EMAIL_DOMAIN_RESERVED`）：
否则攻击者可抢先用 `wx_<受害者openid哈希>@wechat.invalid` 占位，让受害者的微信首登撞
`users.email` 唯一索引且无身份行可回退 —— 一个定向拒绝服务。

### 三、state 双提交 cookie（回调用它代替同源守卫）

`GET /api/auth/wechat/authorize` 生成随机 state 写入
`wechat_oauth_state`（`httpOnly` + `sameSite:'lax'` + `path:/api/auth/wechat` + 10 分钟，
与 code 的 10 分钟生命对齐），微信原样回传，回调恒定时间比对。写入点仍在
`server/lib/session-cookie.ts`（cookie 单一事实源，`arch-tests/csrf-guard.test.mjs` 锁定）。

- `SameSite=Lax` 必需且充分：回调是**跨站顶层 GET 导航**，Lax 会带上 cookie；
- 回跳目标硬编码为 `/?wechat=ok` / `/?wechat_error=<码>`，**不接受任何用户提供的 returnUrl**，
  开放重定向面为零；
- state 不匹配时**在任何外呼之前 return**（否则跨站诱导的回调能白耗微信调用额度），
  该性质由「stub fetch 计数为 0」的用例锁定。

### 四、`GET /api/auth/wechat/callback` 是**改状态的 GET**——记为已接受

不改 `MUTATING_METHODS`（`arch-tests/csrf-guard.test.mjs` 把它钉死为恰好四个），
也不加任何 allowlist（该 arch-test 里**不存在** GET 白名单数组）。理由与 ADR-0020 中
`verify-email`/`share` 两例一致：微信只支持 302 回跳，改成 POST 会直接让功能不可用；
本端点的 CSRF 防护由 state 双提交承担。本 ADR 将其记为第三例。

### 五、限流：不豁免（与支付宝 `/notify` 相反）

支付宝异步通知是**服务器对服务器**、验签即鉴权、且限流会毁掉重试风暴的自愈；
微信回调是**浏览器驱动**、可被廉价刷、唯一鉴权就是 state cookie，因此挂 per-IP 限流是真实防线。
回调限流器的 `handler` 刻意不返回 JSON 429（浏览器顶层导航看到一坨 JSON 会以为站坏了），
而是 302 回 `/?wechat_error=RATE_LIMITED`。

### 六、不引入微信 SDK，不落 token

整条链路只有两个只读 GET，用内置 `fetch` 直调。新 runtime 依赖会牵动 esbuild
`--packages=external` 与服务端 `npm install --omit=dev`（漏装即重启后 `Cannot find module`）。
`access_token`/`refresh_token` **不落库**：登录只需要 openid，而 refresh_token 无法续期（30 天），
存下来只多一份可泄漏的凭据。代价见下。

### 七、取资料失败**不阻断**登录

`/sns/userinfo` 失败（`errcode`）时降级为「仅 openid」登录：openid 已从换 token 的响应里拿到，
账号照样建得起来，只是昵称/头像回落默认值。反过来「因为取不到显示名就把已授权的用户挡在门外」
是更差的取舍。降级会打 `console.warn`，不至于无声。

### Positive Consequences

- 邮箱登录、会话、配额、VIP、F4 注销全部**零改动**复用；微信账号与邮箱账号在数据面上完全同构；
- 身份与画像分离：将来接小程序/公众号是**加一行**而不是加一列，且同人收敛逻辑已就位；
- `unionid` 的语义（同人、非唯一）在 schema 注释、仓储注释与本文档三处写明，
  不会被后人「顺手加个唯一索引」；
- 并发授权（两个标签页）靠确定性占位邮箱 + `23505` 重查收敛，不产生重复账号。

### Negative Consequences

- 占位邮箱进入了 `users.email`：需由服务端派生 `email_placeholder` / `has_password` 两个标记，
  前端据此把「邮箱」显示为「微信登录」（`UserProfileModal`），否则用户会看到 `wx_xxx@wechat.invalid`；
- 纯微信账号**无法设置密码**（`change-password` 要旧密码；`forgot-password` 的地址不可达）；
- 微信头像 URL 会失效（官方明说用户改头像后旧 URL 失效）——一期直存原始 URL，失败时前端降级首字母头像；
- 不保存 refresh_token ⇒ 昵称/头像只取首次授权时的快照，不会随微信侧变化刷新；
- 两个授权标签页会互相覆盖唯一的 state cookie，先开的那个回调判 `STATE` 失败（重试即可）；
- 管理员恢复一个已软删的微信账号，会得到一个**无任何登录方式**的账号
  （该 openid 已被重指到注销后新建的账号）；
- 身份键是 per-app 的 `openid`：同一微信在第二个应用下登录依赖 unionid 收敛，
  一期只有一个 appid，该路径只能靠直接预置数据来测。

### Follow-up / Mitigation

- 头像转存 `oss.hao430.cn`（消除 URL 失效）列为后续项，本期不做；
- 解绑/绑定邮箱流程未做，`email_placeholder` 标记已就位 —— **已由 [ADR-0023](./0023-account-binding.md) 补上**（个人中心双向绑定 + 运营台解绑逃生舱）；
- 新增 `tests/wechat-login.test.ts`（20 例）覆盖上述每一条边界；
  `arch-tests/{rls-coverage,repository-dual-mode,db-scope-discipline,tenant-filter,csrf-guard}`
  自动守住新表分类、双模写法、作用域纪律与 cookie 单一事实源；
- `arch-tests/route-rate-limiter.test.mjs` 的 router 变量名白名单加入 `wechatRouter`
  （不加则该文件被静默跳过、限流器纪律零覆盖）。

## Pros and Cons of the Options

### Option A: 给 `users` 加两列

good：改动最小，不需要新表、新仓储、新内存集合。
bad：`openid` 是凭据不是画像；第二/第三个 provider 会让 `users` 列数继续膨胀；
无法表达「同一账号可绑多个第三方身份」这一本就成立的事实。

### Option B: 新建 `oauth_identities` 表

good：唯一约束落在 `(provider, openid)` 上语义清晰；provider 可扩展；同上。
bad：要归类 RLS、写双模仓储、加内存集合、写一张新的 PG 冒烟表清单。

### Option C: 仅作为已有账号的绑定入口

good：不引入占位账号这一整类特殊数据，账号唯一性最强。
bad：放弃微信登录的主要价值（降低注册门槛），且仍要建同一张身份表。

### 交互：整页跳转 vs 弹窗内嵌二维码

good（整页跳转）：无第三方脚本、无 iframe、无 `res.wx.qq.com` 依赖，前端改动只有两个文件。
bad：用户会离开本站页面再回来（Lax 顶层导航下体验无损）；
弹窗内嵌需要引入外部 JS 并处理 iframe 与回调（`self_redirect`）两种模式，收益不成比例。

### 账号构造：占位邮箱 vs 把 `email`/`password_hash` 改成可空

good（占位邮箱）：`NOT NULL` 不动，`findUserByEmail`、登录、F4 同邮箱重注册、
partial 唯一索引等**全部既有路径零改动**。
bad：需要 `email_placeholder`/`has_password` 两个派生标记把这类账号在 UI 上区分出来，
且占位地址本身是一份「脏数据」。改可空则会波及以上每一条读路径的分支，风险高得多。

## References

- 代码：
  - `server/core/schema.ts`（`oauth_identities` 建表 + `RLS_DIRECT_USER_TABLES`）
  - `server/repositories/oauth.repository.ts`、`server/core/records.ts`、`server/core/memory-store.ts`
  - `server/services/wechat-provider.ts`、`server/services/wechat.service.ts`
  - `server/routes/wechat.ts`、`server/app.ts`
  - `server/lib/crypto.ts`（`OAUTH_UNSET_PASSWORD_HASH`）、`server/lib/session-cookie.ts`（state cookie）
  - `server/middleware/auth.ts`（三个独立限流器）
  - `src/components/auth/AuthModal.tsx`、`src/context/AuthContext.tsx`、`src/components/ui/UserProfileModal.tsx`
- 测试：`tests/wechat-login.test.ts`（20 例）、`arch-tests/route-rate-limiter.test.mjs`
- 关联：ADR-0019（角色分离与 RLS）、ADR-0020（同源守卫与 cookie 单一事实源）、
  ADR-0014（支付宝回调的对照：为何那里豁免限流而这里不豁免）、ADR-0005 / Spec F4（软删与 30 天冷却）
- 外部：<https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html>
