# ADR-0010: scrypt 加固参数（N=2^16 / r=8 / p=1）

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: security, cryptography, password-hash

## Context and Problem Statement

密码散列是认证体系的核心。**离线爆破**是常见攻击：

- 数据库泄露后攻击者拿到 `password_hash` 离线爆破；
- scrypt 是抗 GPU/ASIC 的内存硬函数；
- 但 scrypt 参数选错会被绕过：参数过弱（< 100ms）等于明文；参数过强（> 1s）会拖垮登录体验。

## Decision Drivers

- 单次校验 ≥ 200ms（spec 注释声明，本机实测 215ms）；
- 内存占用 ≥ 64MB（抗 GPU）；
- 版本头格式支持**存量升级**（旧 hash 登录时透明升级）；
- 不能用默认 Node scrypt 参数（太弱）。

## Considered Options

- **Option A: bcrypt**
- **Option B: Argon2**
- **Option C: scrypt with N=2^16/r=8/p=1 + 版本头**（已选）
- **Option D: scrypt 默认参数**（N=2^14）

## Decision Outcome

**Chosen option: C**, because scrypt 在 Node `crypto` 内置、零依赖；N=2^16 是当前业界推荐（OWASP 2023 建议 ≥ N=2^15，r=8，p=1）；版本头让存量 hash 登录时自动重 hash。

### Positive Consequences

- 抗 GPU 爆破（64MB 内存要求）；
- 抗 ASIC（scrypt 是内存硬函数）；
- 登录性能可接受（200ms 量级）；
- 存量 hash 升级透明（`scrypt$N$r$p$salt:key` 头解析）。

### Negative Consequences

- 64MB 内存要求在低配服务器上是负担（容器需 ≥ 128MB 内存限制）；
- `maxmem` 参数必须配 128MB（实测 64MB 偶尔触发警告）；
- 200ms 是单次成本，**多实例登录风暴时会阻塞 Node 事件循环**——需 `worker_threads` 异步化（见 follow-up）。

### Follow-up / Mitigation

- 密码校验改 `worker_threads` 异步（避免阻塞事件循环）；
- CI 跑散列性能回归（确保硬件升级不会让散列降到 100ms 以下）；
- 监控登录 P99 延迟（> 1s 告警）。

## Pros and Cons of the Options

### Option A: bcrypt

- **Good**: 广泛使用；库成熟
- **Bad**: 不是内存硬函数（GPU 友好）

### Option B: Argon2

- **Good**: 最新标准；抗 GPU/ASIC
- **Bad**: 需引入 `argon2` 包（Node 内置 `crypto` 不支持）

### Option C: scrypt 加固 + 版本头（已选）

- **Good**: Node 内置；内存硬；可升级
- **Bad**: 阻塞事件循环；内存占用大

### Option D: scrypt 默认

- **Good**: 简单
- **Bad**: 参数过弱；OWASP 不推荐

## References

- 代码：`server/lib/crypto.ts:1-120`
- 文档：`docs/specs/F5-scrypt与日志留存.md`、`docs/技术架构文档.md` §1.1
- 外部：OWASP Password Storage Cheat Sheet 2023
