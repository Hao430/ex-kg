# ADR-0004: 多租户严格属主制

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: security, multi-tenancy, idor

## Context and Problem Statement

枝想是多租户 SaaS，画布是用户的核心数据资产。**越权访问（IDOR）** 是 SaaS 最常见的高危漏洞：

- 攻击者通过枚举 `/api/canvases/<id>` 访问他人画布；
- 历史放行（`board-` 前缀属主共享、`guest_*` 属主）已造成过一次线上事故（Spec A1 砍掉游客模式前）；
- 严格属主制是**默认安全姿态**。

## Decision Drivers

- 画布读/写/删**只允许**属主本人或 admin；
- 默认共享画板（首屏）是唯一放行点（用户期望一致体验）；
- 任何放行都必须有显式函数判断（不能依赖字符串前缀）；
- 审计日志必须留痕。

## Considered Options

- **Option A: 全严格属主**（连默认画板都私有）
- **Option B: 严格属主 + 默认画板共享**（已选）
- **Option C: ACL 中间件**（每画板一份 ACL）
- **Option D: 角色 + 资源属主**（RBAC 通用模型）

## Decision Outcome

**Chosen option: B**, because 它在保证多租户安全的前提下，保留了"首屏一致体验"的产品需求。**唯一放行点**是 `isSharedDefaultCanvas('default-board' | 'default-canvas')`，函数化判断 + 默认画板禁删共同兜底。

### Positive Consequences

- IDOR 攻击面被压缩到一个白名单函数；
- `isSharedDefaultCanvas` 是**唯一**需要审计的放行点；
- 历史放行（`board-` 前缀、`seed_`、`demo-user-1`、`guest_*`）**全部删除**（H1 安全加固 2026-09-07）；
- 写 `user_audit_logs`（`canvas_delete / canvas_save` 等动作）形成审计闭环。

### Negative Consequences

- 默认画板禁删（见 ADR-0012），物理上锁死"全局默认板"概念；
- 二期要做"团队协作"时，**属主制不适用**——需引入 ACL（见技术债清单 §演进性）。

### Follow-up / Mitigation

- 团队协作出现在画布 `canvas_shares` 表（一期空壳），设计草案待立；
- `user_audit_logs` 增加 `(user_id, action, target_id)` 复合索引（见技术债清单 §可观测性）。

## Pros and Cons of the Options

### Option A: 全严格属主

- **Good**: 最严
- **Bad**: 首屏体验割裂（新用户登录看不到任何画板）

### Option B: 严格属主 + 默认画板共享（已选）

- **Good**: 安全 + 体验平衡；放行点函数化
- **Bad**: 团队协作要重做权限模型

### Option C: ACL 中间件

- **Good**: 灵活
- **Bad**: 一期过度设计；权限矩阵爆炸

### Option D: RBAC 通用模型

- **Good**: 标准
- **Bad**: 一期角色就 3 档，引入 RBAC 是过度工程

## References

- 代码：`server/repositories/canvas.repository.ts:9-17`、`server/middleware/auth.ts`
- 文档：`docs/specs/H1-画布多租户严格属主制.md`、`docs/specs/A1-删除游客模式.md`
