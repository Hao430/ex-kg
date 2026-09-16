# ADR-0024: 出站请求守卫（管理员可填的服务地址）

- **Status**: Accepted
- **Date**: 2026-09-16
- **Deciders**: 枝想架构组
- **Tags**: security, ssrf, secrets, ai-config, admin

## Context and Problem Statement

`ai_model_config.openai_base_url` 由管理员在运营台自由填写，服务端随后
`fetch(\`${baseUrl}/responses\`)` 发起出站请求（`server/routes/chat.ts`、`server/services/title.service.ts`），
并在 `/api/admin/model-config/test` 上提供「测试连接」。这条链路上**此前没有任何校验**，
2026-09-16 的安全审查把后果收敛为三条：

1. **平台 AI 密钥外送**：联调端点在请求体未带 Key（或带的是掩码 `••••`）时会回落到
   `currentConfig.openai_api_key`。于是「把地址填成自己的域名 + 不填 Key」= 让服务端把
   **真实密钥**以 `Authorization: Bearer` 送到任意主机。这不是理论风险——回落逻辑本身
   是为了「不重填 Key 也能测同一台」，它默认了「地址不会变」这个未被校验的前提。
2. **SSRF**：地址可以是回环、内网、链路本地或云元数据（`169.254.169.254`、阿里云
   `100.100.100.200`），服务端成为内网探针；上游响应体还会被回显给调用方。
3. **协议与明文**：`file:`/`gopher:` 之类未被拦；明文 `http` 被放行，API Key 走明文链路。

本决策改变「服务端允许对谁发起请求」这一安全机制，按 `docs/adr/0000-adr-template.md` §2
必须落 ADR。

### 现状盘点（谁在出站）

| 位置 | 目标来源 | 是否受本 ADR 约束 |
| :--- | :--- | :--- |
| `POST /api/admin/model-config/test` | 请求体 `openai_base_url` | ✅ 守卫 |
| `PUT /api/admin/model-config` | 请求体 `openai_base_url`（落库） | ✅ 保存即校验 |
| `POST /api/chat` → `/responses` | 库里的 `openai_base_url` | ✅ 使用点复核 |
| 自动标题 → `/responses` | 库里的 `openai_base_url` | ✅ 使用点复核 |
| `wechat-provider.ts` | 硬编码 `api.weixin.qq.com` | ➖ 无需（不接受入参） |
| `alipay-provider.ts` | 环境变量派生 | ➖ 无需（不接受入参） |

## Decision Drivers

- 密钥不得因为「管理员填错一个框」而离开平台；
- 服务端不得成为内网/元数据探针（运营台账号被钓鱼或会话被盗时同样成立）；
- **安全控制不得依赖 `NODE_ENV`**——本项目已有反面教材：`mock-pay` 曾只挡
  `NODE_ENV=production`，在预发/灰度/漏设 `NODE_ENV` 的线上等于不设防（2026-09-14 修复）；
- 内网自托管模型（Ollama 等）是真实需求，不能被一刀切死，但必须**显式声明**而不是默认放开；
- 非法配置要**响亮失败**，不得静默回落到某个「看起来能用」的地址。

## Considered Options

- **Option A：只校验协议（http/https）** — 最小改动，但密钥外送与 SSRF 两条主风险仍在。
- **Option B：全量守卫 + 私网显式开关**（已选）。
- **Option C：域名白名单（只允许已知 provider 域名）** — 最严，但把「换供应商要改代码发版」
  写成了流程，且自托管场景彻底不可能，代价大于收益。

## Decision Outcome

**Chosen option: "B"。** 新增 `server/lib/outbound-url.ts`，导出
`assertSafeOutboundUrl(raw, { purpose })`，命中即抛 400 `OUTBOUND_URL_REJECTED`。

### 一、恒定拒绝（与任何开关无关）

| 规则 | 理由 |
| :--- | :--- |
| 必须是合法绝对 URL | 拒绝相对路径与拼错的字符串 |
| 协议只允许 `https:` / `http:` | 拒绝 `file:`/`gopher:`/`javascript:` 等 |
| URL 内不得内嵌 `user:pass@` | 既是凭据泄漏也是解析歧义 |
| 云元数据地址：`metadata.google.internal`、`metadata.goog`、`169.254.169.254`、`100.100.100.200` | 没有任何正当理由让业务访问实例元数据 |

### 二、默认拒绝、可显式放开

`OUTBOUND_ALLOW_PRIVATE_HOSTS=true` 之外的默认形态：拒绝回环 / 私网 / 链路本地 / 保留段
（`0/8`、`10/8`、`127/8`、`100.64/10`、`169.254/16`、`172.16/12`、`192.168/16`、`198.18/15`、
`224/4`、`240/4`，IPv6 的 `::1`/`fe80::/10`/`fc00::/7`/`ff00::/8` 及 IPv4 映射形式），
并且要求 `https`（明文 http 会让 API Key 暴露在链路上）。

**为什么用开关而不是判 `NODE_ENV`**：判 `NODE_ENV` 就等于把控制权交给一个可能没设的环境变量
（见 Decision Drivers 的反面教材）。开关的语义是「运维明确声明：我就是要连内网模型」，
默认关、翻开要明说，与本仓 `SAVE_DEFAULT_BOARD_MODE`、`PAYMENT_ENABLED` 同风格。
开关只影响「私网 + http」两条，元数据恒定拒绝。

### 三、密钥回落必须绑定主机

联调端点的掩码回落加一条前提：**目标主机必须与已保存的一致**，否则要求显式提供 Key
（400 `API_KEY_REQUIRED_FOR_NEW_HOST`）。这条才是把「密钥外送」从漏洞变成特性的那一步——
守卫只保证地址「不是明显危险的」，主机比对才保证「密钥不会去新地方」。

### 四、四个校验点，缺一不可

保存时校验挡不住「校验上线前就已写进库的老配置」，使用点复核挡不住「直接 PUT 写库」——
所以两处都要有：`resolveConfigForSave`（保存）、`/model-config/test`（联调）、
`resolveOpenAiEndpoint`（chat 与自动标题共用的使用点）。

### 五、测试如何配合

守卫默认严格，测试**不得**让它为测试放宽。刻意把模型地址指向回环的套件
（`h2-grounding-chain`、`i2-ai-log-observability`、`i3-auto-title`）在自己文件里显式写下
`process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS = 'true'`，把「这是故意的本地地址」表达在测试里。
守卫默认行为的回归用例见 `tests/outbound-guard.test.ts`。

## Consequences

- **正面**：平台 AI 密钥不再可能被送到请求指定的主机；内网/元数据探测面收窄到「运维显式开启」；
  协议与明文两处顺手加固；非法配置在保存时就报错，不会留到用户推理时才失败。
- **负面 / 代价**：运营台内置的 **Ollama 预设（`http://localhost:11434/v1`）在默认配置下会被拒绝**，
  需设 `OUTBOUND_ALLOW_PRIVATE_HOSTS=true` 才能保存与联调；自托管场景多了一个部署开关要写进
  `.env`（已记入部署手册与环境变量表）。
- ⚠️ **已知残留（明说，不假装覆盖）**：守卫只看**字面主机名**，不做 DNS 解析后按 IP 复核，
  因此 DNS rebinding（公网域名解析到 `127.0.0.1`）仍可绕过私网判定。彻底堵住需要解析后复核
  或固定连接目标（自建 agent / 出网代理），属独立工作项；本 ADR 不声称已覆盖该场景。
- 出站目标的**响应体**仍会被回显给调用方（联调端点），仍是「管理员可见的内部信息」，
  不对外暴露；未列入本次范围。

## 相关

- 安全审查报告（2026-09-16）：H2「管理员 SSRF + 平台 AI 密钥外送」
- [ADR-0007](./0007-independent-rate-limiters.md)（限流器独立性）、[ADR-0016](./0016-admin-strict-canvas-tenancy.md)（运营台能力边界）
- [ADR-0020](./0020-same-origin-guard.md)（另一处「守卫必须在所有路由之前」的先例）
