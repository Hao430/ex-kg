# ADR-0003: 多模型容灾链（Gemini → OpenAI 兼容协议）

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: 枝想架构组
- **Tags**: ai-integration, resilience, fail-over

## Context and Problem Statement

AI 推理是枝想的核心服务，第三方 API 的可用性与配额直接决定产品体验：

- Gemini 在高并发时段会触发 429（`resource_exhausted`）或 503（`high demand`）；
- 单模型风险高：若供应商全量失败，AI 推演整个断线；
- 用户对"AI 推演中"极敏感，断联会被误读为"产品崩了"。

## Decision Drivers

- 单模型 429/503 不能让用户感知断联；
- 容灾链切换延迟要低（< 2s）；
- 容灾链不能依赖额外配置（首次启动即生效）；
- 保留 OpenAI 协议热备，给二期多供应商接入留口。

## Considered Options

- **Option A: 单模型**（仅 `gemini-3.8-flash`）
- **Option B: 多模型容灾链**（默认 + 2 档容灾 + 兜底推演）
- **Option C: 外部 AI gateway**（如 Portkey / OpenRouter）

## Decision Outcome

**Chosen option: B**, because 它在不引入外部依赖的前提下，**对用户透明地消化了 429/503**。容灾链是写死在 `chat.ts` 的常量列表中（一期可接受，二期可配置化）。

### 容灾链结构

```
默认:  gemini-3.8-flash
失败 1: gemini-3.1-flash-lite
失败 2: gemini-flash-latest
兜底:  generateFallbackResponse()（内置知识库）
```

### Positive Consequences

- 99%+ 推理成功率（实测）；
- `cleanErrorMessage()` 智能识别 401/429/503 并给出可读提示；
- 全链路失败时 `generateFallbackResponse` 兜底，画布思考不断联；
- OpenAI 协议热备（`openai` provider）保留接入能力。

### Negative Consequences

- 容灾链**硬编码**在 `chat.ts`，改一处要发版（建议改 ADR-0003-Follow-up）；
- 容灾链**没有 per-model 用量统计**（`ai_request_logs.provider` 字段已加但未启用统计）；
- 兜底推演是固定模板，**用户可能感知"AI 偷懒"**——但比"断联"好。

### Follow-up / Mitigation

- 二期从 `ai_models_config` 表读容灾链配置（带白名单校验）；
- 兜底推演改为更智能的"知识库检索"（依赖向量库，二期再议）；
- 监控容灾链切换频率，超过阈值告警（依赖 OTel，见技术债清单）。

## Pros and Cons of the Options

### Option A: 单模型

- **Good**: 简单
- **Bad**: 单点失败 = 全站断联；不可接受

### Option B: 多模型容灾链（已选）

- **Good**: 用户无感消化失败；接入门槛低
- **Bad**: 硬编码；二期需重构

### Option C: 外部 AI gateway

- **Good**: 多供应商管理标准化；自动 fallback；可观测性
- **Bad**: 外部依赖；隐私合规审查；成本

## References

- 代码：`server/routes/chat.ts:36-100`、`server/repositories/ai.repository.ts`、`server/services/ai.service.ts`
- 文档：`docs/技术架构文档.md` §1.1、`docs/specs/E4-模型配置单点依赖告警.md`
