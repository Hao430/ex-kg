# ADR-0023: 账号绑定（微信 ↔ 邮箱，单向）

- **Status**: Accepted
- **Date**: 2026-09-16
- **Deciders**: 枝想架构组
- **Tags**: auth, account-linking, wechat, rls, security

## Context and Problem Statement

ADR-0022 上线了微信扫码登录，首次微信登录会**自动建号**。这留下一个真实的缺口：

> **既有邮箱账号的用户点了微信登录，会静默建出第二个账号。**

微信 `snsapi_login` 不返回邮箱也不返回手机号，服务端**没有任何办法**自动认出「这个微信号就是
alice@example.com」——任何基于邮箱/手机的自动合并都做不到。用户看到的是「登录进去了，
但我的画板全没了」。

同一批遗留问题还有两个：

1. 纯微信账号的邮箱是占位地址（`wx_<hash>@wechat.invalid`）、`password_hash` 是不可满足的哨兵，
   因此**永远无法用邮箱登录、也无法自助找回**；
2. 已登录的浏览器若经书签/旧标签页直接访问 `/api/auth/wechat/authorize`，
   ADR-0022 的实现会**建出第二个账号并覆盖会话 cookie**——用户在自己没察觉的情况下换了账号。

**决策范围**：把「先邮箱登录 → 再绑微信」这条唯一可行的路径真正打通（个人中心双向绑定），
并让绑定成为回调的**默认语义**（有会话即绑定），从而顺带堵掉第 2 条。

## Decision Drivers

- 用户分流必须可见、可恢复：不能让人不知不觉多出一个空账号；
- 不引入「自动合并」这种做不到的事，也不引入「必须重新注册」这种劝退设计；
- 与既有防线一致：RLS 作用域、限流器独立性、双模持久化、cookie 单一事实源都不能被绕过；
- **单向绑定必须配一条退路**，否则误绑即永久；
- 少一个新表/新变量就少一处失效面。

## Considered Options

- **Option A: 只做「诚实告知」** — 回调后若新建了账号就提示用户「请改用邮箱登录」。
  最小改动，但数据割裂没解决，等于把问题推给用户。
- **Option B: 双向绑定 + 运营台解绑逃生舱**（已选）。
- **Option C: 微信账号强制先绑邮箱再建号** — 转化掉一层，且无法解决「已注册用户想绑微信」。
- **Option D: 按 unionid / 昵称自动合并到已有账号** — 做不到（微信不给邮箱/手机），
  且即使做得到也极其危险（错误合并 = 数据泄漏）。

## Decision Outcome

**Chosen option: "B"。**

### 一、回调的默认语义：**有有效会话 = 绑定**

`GET /api/auth/wechat/callback` 在 state 校验之后按会话分流：

| 情形 | 行为 |
| :--- | :--- |
| 有效会话，该微信未绑任何账号 | `linkOAuthIdentity` 到当前账号 → 审计 `wechat_bind` → 302 `/?wechat=bound` |
| 有效会话，该微信已绑**本账号** | 幂等：302 `/?wechat=bound`（不重复插行、不重复审计） |
| 有效会话，该微信已绑**别的账号** | 302 `/?wechat_bind_error=WECHAT_ALREADY_BOUND`，不改绑、不换会话 |
| 有效会话，本账号已绑**另一个**微信号 | 同上（一账号一微信身份） |
| 无会话 / 会话已失效 / 账号被冻结 | 走 ADR-0022 的登录路径，回跳**仍是 `/?wechat=ok`** |

**绑定分支绝不建账号、绝不动会话 cookie。**

用会话而不是显式意图参数，是因为登录弹窗只在未登录时可达、而「绑定微信」按钮只在已登录时可见
——「有没有会话」正好等价于用户的心智，不需要引入额外状态。它同时堵掉了
「已登录浏览器经书签访问 `/authorize` 就静默换账号」这个隐患。

**会话失效时回落为登录**（而不是报错）：本产品里「会话失效」就等于「已登出」
（前端表现为登录按钮重新出现），此时点微信登录的语义就是登录。这是**有意接受**的行为。

**CSRF 复核**：绑定分支的鉴权是「有效会话」，CSRF 防护仍是 ADR-0022 的 state 双提交 cookie。
攻击者无法把**自己的**微信 code 重放进受害者浏览器：要让 state 校验通过，请求里的 `state`
必须等于该浏览器 httpOnly 的 `wechat_oauth_state`，其值只出现在那个 cookie 与 302 到
`open.weixin.qq.com` 的 `Location` 里（跨源读不到）；往受害者浏览器种 cookie 是可能的，
但种下的随机值攻击者自己也不知道。**不引入新的 CSRF 面。**

### 二、补绑邮箱：邮箱 + 验证码，**不设密码**

- 仅**占位邮箱**的账号可补绑 → 天然规避了「换绑」，因此不必实现解绑/换绑，也就没有
  「解到没有登录方式」这种状态；真实邮箱账号请求补绑直接 400 `EMAIL_ALREADY_BOUND`
  （与 Spec D3 的 `EMAIL_ALREADY_VERIFIED` 同款口径：400 而非 409）。
- 复用注册那套验证码基建（`email_verification_codes` 表、60s 冷却、连错 5 次作废），
  但**主题与正文另起一份**（`枝想 邮箱绑定验证码`）：收件人已经注册过了，
  收到「欢迎加入，您的注册验证码」是错的提示，且测试的 outbox 断言按主题精确匹配。
- **`email_verified` 保持 TRUE**。这一点是硬约束而不是口味：admin 的换绑函数
  `updateUserEmail` 会把 `email_verified` 置 false，而 `middleware/quota.ts` 对未验证邮箱
  一律 403 `EMAIL_NOT_VERIFIED` —— 复用它等于**绑完邮箱后所有 chat 请求立刻全挂**。
  因此新增 `bindVerifiedEmail`（置 TRUE 并清空 verify_token）而不是复用那个函数。
- `password_hash` 保持哨兵 → `has_password` 仍为 false、修改密码表单继续隐藏
  （没有旧密码可验）。想用邮箱登录的用户，走登录页「忘记密码」自助设置——
  此时那个地址已经真的收得到信了。个人中心该行文案明确写出这条路径。

### 三、唯一性预检必须跨租户（否则生产上它永不生效）

`users` 的 RLS 谓词是 `id = current_setting('app.user_id')`。在已登录的 `runWithUser(me)`
作用域下，`findUserByEmail(别人的邮箱)` 在 **PG 里恒返回 null**（内存模式没有 RLS，能查到）
—— 也就是说「友好的 409」在生产**永远不会触发**，只剩一条静默的双模分叉。

因此预检包在 `runWithSystem('auth: 绑定邮箱前按 email 跨租户查重（需全站唯一性）', …)` 里；
`UPDATE` 仍留在 `runWithUser` 作用域。真正的兜底是 `users.email` 的唯一索引（`23505` → 409）。

### 四、**新增凭据不踢会话**（与「换凭据才踢」并列成规则）

`changeOwnPassword` / `resetPassword` 都会 `deleteUserSessions`（**换**凭据，旧的必须失效）。
绑邮箱**增加**一个新凭据，不削减任何既有凭据的爆炸半径——踢下线只会让刚绑完的用户被登出、
还得再用新邮箱登录一次，零安全收益。这条规则写进本文档，防止后人以「统一风格」为名把两者合并。

### 五、限流与通道隔离

- 两个新限流器（独立实例，ADR-0007，user-keyed，挂在 `authMiddleware` 之后）：
  `bindEmailSendCodeRateLimiter`（5/h）、`bindEmailRateLimiter`（10/h，兼作 6 位码提交刷量的第一道）。
- 绑定失败走**独立查询参数** `wechat_bind_error`，**不挤进 `wechat_error`**：
  后者在前端会打开「登录」弹窗，对一次绑定操作弹出登录框是错的引导（用户本来就是登录态）。

### 六、运营台解绑逃生舱（用户侧仍不解绑）

单向绑定 + 只凭会话放行，若没有任何解除手段，一次误绑（扫了别人的微信、或手机号被回收后
微信号易主）就会在账号上留下一个**永久且无法移除的登录凭据**。因此新增

`DELETE /api/admin/users/:id/oauth/:provider`（`authMiddleware` + `requireAdmin` +
router 级 `runWithSystem`，跨租户与管理员校验都是现成的），审计 `admin_oauth_unbind`
并记下解绑前的昵称。用户侧仍然没有自助解绑，符合「不做解绑」的口径。

### 七、提醒：由 `email_placeholder` 驱动，不用 URL 参数

`/me` 已经返回 `email_placeholder`，它覆盖「以后再登录时提醒」（需求是「提醒用户进行绑定」，
不只注册当时），用户绑定后自动消失。一次性去重标记按账号分键
（`src/lib/bind-nudge.ts` 用 `scopedKey` + `scopeKeyFor`）——用全局键会让同一浏览器上
**第二个账号永远看不到提醒**。

### Positive Consequences

- 既有邮箱账号可以通过「先登录 → 绑微信」把微信变成第二个登录方式，不再产生平行空账号；
- 纯微信账号获得完整的账号生命周期：绑邮箱 → 忘记密码 → 邮箱+密码登录 → 可自助找回；
- 回调的「有会话即绑定」顺手关掉了静默换账号的隐患；
- 绑定状态（`wechat_bound` / `wechat_nickname`）由 `/me` 统一返回，前端不再靠
  「邮箱是不是占位」去**猜**微信绑没绑（那正是 ADR-0022 遗留的徽章错误推断）；
- 误绑有解药，且不需要在用户侧开放解绑。

### Negative Consequences

- **补绑邮箱不设密码** ⇒ 用户想邮箱登录必须自己再走一次「忘记密码」（个人中心有文案指引）；
- **绑定只凭有效会话、不再验证密码**：在解锁的共享/二手设备上，攻击者扫自己的微信即可在
  受害者账号上留下一个持久凭据。缓解＝运营台可解绑 + 绑定前明示「绑定为一次性操作」；
- **一账号一微信身份**，且用户不能自助解绑；
- 会话失效时回落为登录，因此「旧标签页的绑定」在会话过期后会变成一次登录；
- 目标邮箱属于某个**已注销**账号时可以绑成功（partial 唯一索引与 `findUserByEmail` 都排除
  已注销行，与 F4「同邮箱可重新注册为新 id」一致）；副作用是那个已注销账号此后**无法被 restore**
  （会 409），管理员需先改邮箱；
- 内存模式的 `restoreAccount` 没有 partial unique index 的等价物，可能出现「两个活体用户同邮箱」
  （仅内存/测试模式，PG 侧由唯一索引兜住）。

### Follow-up / Mitigation

- 「绑定需重验证 / 绑定意图 cookie」记入技术债（当前靠运营台解绑兜底）；
- 内存 `restoreAccount` 的双模分叉记入技术债（只影响测试环境）；
- `.env` 无新增变量；部署手册无需改。

## Pros and Cons of the Options

### Option A: 只做诚实告知

good：改动最小（一个查询参数 + 一句提示），零新增端点。
bad：把「你有两个账号」这件事留给用户自己消化；拉新来的微信用户永远账号分裂。

### Option B: 双向绑定 + 运营台逃生舱

good：唯一可行的「既有账号 + 微信」路径被打通；同时解掉纯微信账号无法找回的问题。
bad：新增 2 个用户端点 + 1 个 admin 端点 + 3 个仓储函数 + 1 个服务模块 + 1 张邮件模板；
需要把「唯一性预检必须跨租户」这类作用域细节写对。

### Option C: 微信账号强制先绑邮箱

good：账号唯一性最强，不存在平行账号。
bad：首次转化掉一层；且完全没回答「已有邮箱账号想绑微信」这个原始问题。

### Option D: 自动合并

good：用户零操作。
bad：微信不返回邮箱/手机，**技术上做不到**；即便做得到，错误合并等于数据泄漏。

## References

- 代码：
  - `server/routes/wechat.ts`（`resolveSessionUser` / `handleBind`）
  - `server/services/account-binding.service.ts`、`server/services/admin.service.ts`（`unbindOAuthIdentity`）
  - `server/repositories/{user,oauth}.repository.ts`（`bindVerifiedEmail` / `findOAuthIdentityByUserId` / `destroyOAuthIdentity`）
  - `server/routes/auth.ts`（`/bind-email`、`/bind-email/send-code`、`/me` 增 `wechat_bound`）、`server/routes/admin.ts`
  - `server/lib/mailer.ts`（`sendEmailBindCodeEmail`）、`server/middleware/auth.ts`（两个新限流器）
  - 前端：`src/components/ui/AccountBindingNudge.tsx`、`src/components/ui/UserProfileModal.tsx`、`src/lib/bind-nudge.ts`、`src/context/AuthContext.tsx`
- 测试：`tests/account-binding.test.ts`（23 例）、`tests/wechat-login.test.ts`（回归）
- 关联：ADR-0022（微信登录，本 ADR 的前序）、ADR-0019（RLS/作用域）、ADR-0007（独立限流器）、ADR-0005 / Spec F4（软删与 30 天冷却）、Spec D3（邮箱验证码基建）
