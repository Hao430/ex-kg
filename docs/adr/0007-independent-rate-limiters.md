# ADR-0007: 12 个独立限流器

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: security, rate-limiting, resilience

## Context and Problem Statement

枝想后端需要保护模型推理资源、注册/登录端点免爆破、分享/导出免滥用。**限流器是关键的安全屏障**：

- 注册被刷会批量创建账号，消耗 30 次生成额度；
- 登录被刷会触发 5 次错误密码锁定（`locked_until`）但也消耗用户耐心；
- 模型推理被刷会拖垮 API 配额 + 增加成本；
- 不同端点**威胁模型不同**，应有独立的配额池。

## Decision Drivers

- 限流器**独立实例**（共享 store 会让一个端点耗尽名额拖垮其他端点）；
- 限流 key 按端点语义：登录/注册/找回密码走 IP；聊天走 user_id；
- 角色阶梯：体验版 25/min、VIP 60/min、Admin 120/min；
- 不同限流器**应有不同上限**，按端点风险分级。

## Considered Options

- **Option A: 全局单限流器**
- **Option B: 按角色单限流器**
- **Option C: 按端点独立限流器**（已选）
- **Option D: 外部 WAF**（如 Cloudflare Workers）

## Decision Outcome

**Chosen option: C**, because 12 个限流器**互不串扰**，每个端点按自身风险配置上限，新增端点必须独立评估（这反过来约束了"随便加端点"）。

### 限流器清单（12 个）

| 限流器 | 维度 | 上限 | 用途 |
| :--- | :--- | :--- | :--- |
| `loginRateLimiter` | IP | 15 / min | 防爆破 |
| `signupRateLimiter` | IP | 5 / h | 防批量注册 |
| `sendRegisterCodeRateLimiter` | IP | 5 / h | 防邮件轰炸 |
| `sendRegisterCodeEmailLimiter` | email | 60s 冷却 | 防单邮箱轰炸 |
| `forgotPasswordRateLimiter` | IP | 5 / h | 防枚举 |
| `resendVerificationRateLimiter` | user | 3 / 10 min | 防邮件轰炸 |
| `roleBasedRateLimiter` | user | 25/60/120 per min by role | 推理配额 |
| `quotaRateLimiter` | IP | 60 / min | 配额查询 |
| `shareActionRateLimiter` | IP | 10 / min | 分享写 |
| `publicShareReadLimiter` | IP | 60 / min | 公开分享读 |
| `adminLogReadRateLimiter` | user | 30 / min | 日志查询 |
| `autoTitleRateLimiter` | user | 20 / min | 自动命名 |

### Positive Consequences

- 每个端点风险分级清晰；
- 单端点耗尽不影响其他；
- 角色阶梯（user/vip/admin）天然映射到 `roleBasedRateLimiter`；
- 测试时 `limiter.resetKey()` 可单端点复位。

### Negative Consequences

- **in-memory 限流器单实例假设**：多实例部署时**每个实例独立计数**，N 实例 = 实际限流 ×N（见技术债清单 §P0 `trust proxy` IP 误判 + 本 ADR 的多实例风险）；
- 新增端点必须主动加限流器，靠规范约束（待补架构守护测试）；
- 12 个限流器难统一调优（无 dashboard）。

### Follow-up / Mitigation

- 水平扩展前必须**外置限流 store**（Redis / 共享 store），或在反代做 L4 限流；
- 架构守护测试强制"新增 `/api/*` 路由必须挂限流器"（见技术债清单 §治理待办）；
- 增加限流命中指标埋点（依赖 OTel，见技术债清单 §可观测性）。

## Pros and Cons of the Options

### Option A: 全局单限流器

- **Good**: 极简
- **Bad**: 一端点耗尽拖垮全部

### Option B: 按角色单限流器

- **Good**: 按用户配额
- **Bad**: 防爆破失效（攻击者走不同用户/IP）

### Option C: 按端点独立限流器（已选）

- **Good**: 风险分级；互不串扰
- **Bad**: 多实例失效；难统一调优

### Option D: 外部 WAF

- **Good**: 标准；可视化
- **Bad**: 外部依赖；规则维护成本

## References

- 代码：`server/middleware/auth.ts:20-189`
- 文档：`docs/specs/D1-注册限流与阶梯校准.md`、`docs/specs/D3-邮箱验证.md`
