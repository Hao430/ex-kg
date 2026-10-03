# Spec R1 — AI 练习：主题出题 + 作答判卷 + 掌握情况

> 来源：用户新功能设想「用户输入想练习的知识点/主题并选择难易程度，AI 自动生成选择题与判断题，应用具备答题记录与分析能力」
> 参考实现：`HYW2023-s/questioner-skill`（Claude Code Skill，Python + LangGraph + MySQL，**架构不可移植**，见 §2.2）
> 状态：**已实现（阶段 1-6 完成，待 CI 验证 PG 冒烟）**（2026-10-03；Spike 结论见 §8.1，实现细节已定稿；测试 14/14 绿、全量 665/665 绿、arch-tests 34/34 绿）
>
> 第二轮评审修订（技术优化，无产品取舍）：① **数据模型三表合一**（省约 250 行 + 一整套 F4/RLS/双模/PG 测试面）——一期全部查询在单表里都是单表 SQL，原方案的 `LEFT JOIN` 根本不会出现；② 独立表的理由从「跨画板分析方便」纠正为**安全性**（`getCanvas` 无差别回传 `custom_data`，答案入画布即出网）；③ **每日闸门纠正为 24h 窗口限流器**（原写「挂 `assertCanInfer` 旁」因 `!canvasId` 早退而空转，正是 §2.3 反例一的重演）；④ 「答案不下发」从依赖 zod 默认剥离改为**构造式 DTO**；⑤ 顶栏入口改挂 `BoardLibraryModal` 内 tab（顶栏已有 12 个入口）。
>
> 产品决策（用户 2026-10-03 拍板）：面向用户用「**掌握情况**」不用「正确率」（仅文案层，代码字段仍为 `is_correct`）；困难档题量默认 3 **予以保留**、但数量选择器始终可改；入口挂画板库内新增「练习」tab；**画布与出题一期独立、二期做有机结合**。
>
> ⚠️ **已知代价（如实记录）**：练习成果不进画布 ⇒ 无分享、无 PNG/Markdown/JSON 导出，将是一期唯一无成果物的功能。二期结合后消除。
> 关联：ADR-0019（角色分离与 RLS）、ADR-0024（出站请求守卫）、ADR-0007（独立限流器）、#0082（云优先收口）、P1（运营台工单范式）、I 组（联网与计费口径）

## 1. 问题与现状

1. **产品只有「问」没有「练」**：现有链路是提问 → 流式回答 → 灵感占位（ADR-0017 口径的 suggested 节点）。用户获得了知识，但**没有任何机制验证他是否真的掌握**。`docs/需求说明文档.md` 的目标用户画像已含「终身学习者/备考人员」，产品能力却止步于问答。
2. **零既有代码**：全仓 + `docs/` 搜 `quiz|question|practice|exercise|练习|复习|刷题|测验|答题|错题|知识点|选择题|判断题` 均 0 命中（唯一近似是 `docs/需求说明文档.md:40` 的人设描述与 `src/lib/checklist.ts` 的 4 步引导）。本功能是全新纵向切片，无历史包袱也无可复用资产。
3. **chat 链路不提供非流式结构化输出**：`ai-provider.interface.ts:55-61` 的 `AIProvider` 只有 `execute(options, callbacks: ChatStreamCallbacks)`，非流式能力不存在于该抽象。唯一先例是 `server/services/title.service.ts`（Spec J1）——**出题照它另起一路**。
4. **答案下发即功能失效**：若题与答案一次返回，DevTools 里答案裸奔，作答记录全假，§6 的分析能力随之失去意义。**这是架构约束，不是可后补的优化**，故接口必须两段式。
5. **全仓从未使用 JSON schema 约束输出**：Gemini SDK 支持 `responseMimeType: 'application/json'` / `responseJsonSchema`（`@google/genai/dist/genai.d.ts:5640,6194,6201`），项目里一次都没用过。`title.service.ts:24-26` 的做法是「提示词写死格式 + 剥 ``` 围栏 + 静默返 null」。出题对结构化程度要求高得多，这个缺口应当补上（见 §8 Spike）。

## 2. 参考实现调研与取舍

### 2.1 值得借鉴（移植其**知识**，不移植其架构）

| 来源 | 做法 | 本仓采用方式 |
| :--- | :--- | :--- |
| `single_choice.py:8-12`、`true_false.py:8-12` | 「学科自适应」置于所有提示词**最高优先级**：先判断学科，不符则忽略全部领域特化要求 | ✅ 直接继承。它的 commit 记录了一次真实事故——非 AI 学科的题被硬塞进「神经网络/梯度下降」，根因是提示词写死了领域假设。我们面对「用户输入任意主题」是同一类风险 |
| `true_false.py:49-50` | 判断题「陈述必须非分明」「错误陈述应针对常见误区设计」 | ✅ 直接继承。误区型反例比编造错误陈述有价值得多 |
| `true_false.py:87-88` | 正误比例接近 1:1；不考死记硬背的数字年份 | ✅ 直接继承 |
| `quality_reviewer.py:50` | 评审不通过时输出 `regenerate_hint`（怎么改），随重生成一起回灌 | ✅ 吸收其核心判据（单答案唯一性、难度名副其实），将其集成进单次 Prompt 的 `pedagogical_analysis` CoT 自审输出，**免去独立审核 Agent 的 12~20s 串行延迟**（见 §3.4） |
| `single_choice.py:51-56` | 「情境疲劳检验」：统计发现「小明」占 42%，据此在提示词里禁掉重复主语与场景 | ✅ 移植**思路**（批次内要求主语/场景互不重复），但不做统计 |
| `single_choice.py:35-43` | 5 级认知层次（tier1 记忆 → tier5 综合评价） | ✅ 借作三档难度的**内部判据**（§3.2），写进提示词但不暴露给用户 |

### 2.2 不可移植

- **Python + LangGraph + MySQL**：本仓是 TS + Express + PG 双模，无一可用。
- **多 Agent 编排（16 Agent / 5 条管线 / 8~20 并发）**：源于「离线一次性出满 270 题」的需求。交互式产品里用户等 30 秒不可接受，且 LLM 调用翻 3~5 倍。**出题走单次结构化生成。**
- **独立审核 Agent 串行调用**：出题调一次 + 审核调一次（重试再调一次）会使前端单次等待飙至 12~20 秒，在 Web 练习面板极易超时且体验差。**改用单次 Prompt 内 CoT 自审 + 服务端确定性逻辑校验与洗牌。**
- **20 并发**：单次最多 5 题，并发无意义。
- **教材 PDF/DOCX 管线、题库改写、哲学思辨管线**：均超出一期范围。
- **K12 学段维度**（`difficulty` 字段 primary/junior/senior）：面向终身学习者不适用，**整层丢弃**；只用 `difficulty_level`（basic/medium/hard ↔ 入门/进阶/困难）。
- **6 维 100 分评分制**（`quality_reviewer.py:19-30`）：权重表对「基础正确率验证」过重。

### 2.3 两个必须记取的教训（反例，不得继承）

1. **`difficulty_judge.py:117-129`**：该 agent 想修正知识标签，却写在 `storage` 之前，于是 `UPDATE questions` 永远改不到任何行——**一个看起来在校验、实际完全空转的环节**，且带着「缺 import 导致连接从未成功」的静默失败。本仓重写时凡「审核/判卷」环节，必须确认其**输出真的被消费**并有测试锁定消费路径。
2. **`quality_reviewer.py:143-150`**：重试超限后 `review['passed'] = True` **强制通过**。会让「审核通过率」这个指标随重试次数漂移。本仓不做强制通过；**判卷是确定性的正确答案比对，校验失败即如实告知或回退**（§3.4）。

## 3. 需求

### 3.1 用户流程

1. 用户在画布外打开「练习」面板（入口见 §4.5，登录 + 邮箱已验证即可用，不限 admin/VIP）。
2. 输入**一个**练习主题（自然语言，如「注意力机制」「高中生物光合作用」），选择难度（入门/进阶/困难），选数量（3/5/10，默认 5）。
3. 点「出题」→ 服务端生成 + 轻量审核 → 面板逐题呈现（题干 + 选项/判断按钮），**不含答案与解析**。
4. 用户逐题作答（选择点选、判断两个按钮），提交。
5. 服务端判卷 → 逐题回传对错 + 正确答案 + 解析 + 本次用时。
6. 面板展示本次小结：**掌握情况**（对 X / 共 Y）、按题型掌握情况、错题清单、知识点标签分组。
7. 历史：可查看既往练习记录与累计掌握情况（跨画板、跨设备）。

### 3.2 难度定义（用户可见三档 ↔ 内部判据）

| 档位 | tier 判据 | 题干要求 |
| :--- | :--- | :--- |
| 入门 | tier 1-2 记忆/辨识、理解/解释 | 概念直给，≤80 字，不用术语堆砌 |
| 进阶 | tier 2-3 理解、应用/计算 | 需一步推理，≤150 字 |
| 困难 | tier 3-4 应用/分析、综合/评价 | 多步骤或新情境迁移，≤250 字 |

⚠️ **「快速作答」与「困难」存在内在张力**：难题需要长时间思考。一期不解决，但**UI 必须如实呈现**——**困难档题量默认给 3 而非 5**（用户 2026-10-03 拍板保留）。

⚠️ **但难度档与题量不得强绑定**（评审边界）：用户选「困难」**可能想要更多题**而非更少的题。实现口径——**默认** 3→5 随档位变化，但数量选择器**始终可见可改**，不得因选了「困难」就禁用或隐藏数量选择。理由：把「题量少」当「难度高」的信号是产品臆测，用户自己更清楚要多少题。

### 3.3 题型

- **单选题**（一期主力）：4 选项，**恰好 1 个正确答案**；干扰项须针对常见误区构造，不得是明显荒谬项。
  - ⚠️ **位置偏置消除**：大模型生成选择题有极强的位置偏置（Position Bias，如正解高频落在 A 或 C 达 40%~60%）。**服务端在落库前必须执行 Fisher-Yates 随机洗牌**，并同步更新 `correct` 字段映射，杜绝规律泄露。⚠️ 这是对统计倾向的**缓解**，不要在测试里断言 A/B/C/D 精确均匀（那测的是伪随机数发生器），Spike 中观察是否明显偏斜即可。
- **判断题**：一句非模棱的陈述，**正误比例接近 1:1**；错误陈述针对常见误区。提交契约与存储均严格限定为小写字符串 `'true' | 'false'`。
- 一期**不做**：多选、填空、简答、编程题（用户设想中「以选择题和判断题为主」）。

### 3.4 质量保障（单次 CoT 自审 + 服务端确定性校验 + 选项洗牌）

放弃独立审核 Agent 串行调用的架构，改用**单次提示词内置自审 + 服务端确定性守卫**，理由与机制如下：

1. **规避 12~20s 延迟**：一次生成 5 题需 4~8s，串行加独立审核 Agent 需再加 3~5s，重试则直接突破 15s+，在 Web 端易引发网络超时与卡死体感。
2. **Schema 内置 CoT 自审**：在结构化输出中定义 `pedagogical_analysis` 字段，要求模型在输出每道题前先自检：学科归属判定、认知层级 tier 匹配度、干扰项平行性与误区分析。现代模型（Gemini 3.8 Flash / DeepSeek）在单次约束下的自检能力极强。
3. **服务端确定性校验门控**：
   - 题目数量与题型必须完全吻合；
   - 单选题选项数严格等于 4，`correct_answer` 唯一合法；
   - 判断题正误比例受控；
   - 校验通过后立即执行 Fisher-Yates 洗牌。
4. **容错机制**：解析或硬校验失败时，落 `review.parseFailed = true` 并如实向前端报错，不静默吞掉（§8 Spike 门控需验证单次生成合格率 $\ge 95\%$）。

## 4. 设计

### 4.1 关键架构决策：答案不下发 → 接口两段式

```
① POST /api/quiz/attempts        { topic, difficulty, count }
   → 单次生成(含 CoT 自审) + 确定性校验 + 洗牌落库 → { attemptId, questions: [{ id, type, stem, options? }] }
                                      ⚠️ 无 answer / 无 explanation
② POST /api/quiz/attempts/:id/answers  { answers: [{ questionId, choice, elapsedMs }] }
   → 耗时防篡改校验 + 判卷 + 条件更新(status) → { results: [{ ..., correct: bool, answer, explanation, elapsedMs, lowConfidence }], summary }
```

`correct` 与 `explanation` **只在 ② 的响应里出现**。① 的返回走**构造式投影 DTO**（`AttemptView`，字段清单不含二者），不是靠 zod 默认剥离——见 §4.4 端点清单下的说明。

**提交契约与防篡改守卫**：
- 一期为整卷一次性提交，要求 `answers.length === question_count`。
- 服务端校验耗时防作弊：单题 $100\text{ms} \le elapsedMs \le 3600\text{s}$，且整卷总耗时不得超出真实生命周期 $\sum elapsedMs \le (\text{NOW}() - \text{session.created\_at} + 5000\text{ms})$，杜绝篡改 `elapsedMs` 规避 `<3s` 的判断题低置信度标记。

### 4.2 数据模型（**一张表** `quiz_attempts`，归 `RLS_DIRECT_USER_TABLES`）

> **评审修订（2026-10-03）**：原为三张表（sessions/questions/answers）。经核实，一期全部查询只有三种（历史列表 / 单次详情 / 统计），**在单表里全部是单表 SQL**——原方案为「历史列表属高频读」而设的 `LEFT JOIN` 在单表里根本不会出现。三表多付的代价约 **250 行** + 一整套 F4/RLS/双模/PG 测试面，故合为一张。
>
> **合成后「答案不下发」依然成立**：正确性不依赖表形状，而依赖**接口边界**——`SELECT` 出该行不等于把它发给客户端。`listAttempts` 的投影里根本不选 `questions` 列，答案因此永不出网。
>
> ⚠️ **`status` 的并发正确性靠条件更新而非应用层检查**：`UNIQUE(question_id)` 的作用由 `UPDATE … WHERE status='in_progress'` 承担——重复提交时第二次 `UPDATE` 影响 0 行，抛 409。这比应用层「先查后写」更可靠（无竞态窗口）且天然幂等。

```sql
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(200) NOT NULL,
  difficulty VARCHAR(16) NOT NULL CHECK (difficulty IN ('beginner','intermediate','advanced')),
  status VARCHAR(16) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  -- 题目（JSONB 数组）：[{ id, type, stem, options?, correct, explanation, knowledge_point }]
  -- ⚠️ 含 correct/explanation，服务端独占；**任何 list 查询都不得 select 该列**
  questions JSONB NOT NULL,
  -- 作答与判卷结果（JSONB 数组）：[{ question_id, choice, is_correct, elapsed_ms, low_confidence }]
  -- NULL = 未提交（in_progress）；非 NULL = 已完成（completed）
  answers JSONB,
  -- 自审结论：pedagogical_analysis 摘要、是否解析失败（供面板透明展示）
  review JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id, created_at DESC);
```

**为何独立表而非 `nodes.custom_data`**（这是**安全性**结论，不是便利性）：服务端**从不写 nodes**——`INSERT INTO nodes` 全仓仅两处，均在 `saveCanvas` 内（`canvas.repository.ts:551,798`），节点内容 100% 由客户端 payload 决定（技术债 #0090 已记此事实）；而 `getCanvas` 会**无差别回传全部 `custom_data`**（`canvas.repository.ts:193` 的 `...(nr.custom_data || {})`）。故「答案存进画布」与「答案不下发」**不可兼得**。

且跨画板历史若走 `custom_data` 需 `WHERE custom_data ? '…'` 的 seq scan：现有 GIN 全文索引只覆盖 title/question/answer/content/note，**不含 custom_data**（`schema.ts:584-585`），`searchNodes` 的白名单列（`canvas.repository.ts:1334-1355`）也读不到它。

⚠️ **F4 注销（此为正确性问题，非行数问题）**：`purgeUserDataMemory`（`server/repositories/user.repository.ts:456`）内有 `if (removedCanvasIds.size === 0) return;`（`:472`）早退——清理 `quizAttempts` 的代码**必须放在这一行之前**，否则「从未建过画板的用户」永远清不掉练习记录。

⚠️ **归类登记**：`quiz_attempts` 须加入 `RLS_DIRECT_USER_TABLES`（`server/core/schema.ts:13-26`），否则 `arch-tests/rls-coverage.test.mjs` 立刻红（漏一张表 = 一条静默的跨租户读通道）。

⚠️ **二期的迁移是已知且可预期的**：若二期做间隔重复（SRS），需按题粒度查询，10 万级数据从 JSONB 迁到行表。**这是一次可预期的迁移，不是不做单表的理由**——一期没有任何查询需要它。

### 4.3 出题服务（非流式，照 `title.service.ts` 另起一路）

`server/services/quiz-generation.service.ts`：

- **不复用** `ai-provider.interface.ts`（签名强制流式回调），走独立非流式调用，**照 `title.service.ts:99-175` 的双 provider 写法**（openai `/responses` `stream:false` / gemini `generateContent`）。
- ⚠️ **ADR-0024**：openai 分支必须经 `resolveOpenAiEndpoint(config, '/responses')`，**不得**自己拼 URL（那是四处校验点之一，漏一处即 SSRF 通道）。
- **出题不挂 `web_search` 工具**（与 `title.service` 的「非关键路径不联网」一致）。时效性强的题交给 chat 链路深挖；出题只出**稳定的通识/学科知识**。这同时规避「引用 URL 混入题目 JSON」的解析失败模式。`source` 字段先留空。
- **结构化输出与自审约束**：
  - gemini 分支使用 `responseMimeType: 'application/json'` + `responseJsonSchema`（**全仓首例**）；
  - openai 分支在请求 payload 中增加 `response_format: { type: 'json_object' }`（使 DeepSeek / Qwen / OpenAI 彻底免去 Markdown 围栏与前缀杂质）；
  - JSON Schema 顶层包含 `pedagogical_analysis`（包含学科分类、难度档位判据匹配、易混误区设计）与 `questions` 数组，实现单次提示词 CoT 自审闭环。
  - 解析照 `title.service.ts:43-60` 的容错思路（剥围栏 + 截取 `{`~`}` + try/catch），但**失败要落 `review.parseFailed=true` 并呈现给用户**，不能像 `parseTitles` 那样静默返 null。
- **服务端洗牌流水线（Fisher-Yates Shuffle）**：
  - ⚠️ **Spike 验证过的三步实现，缺一即产生 100% 偏斜**（详见 §8.1）：① 拷贝后洗牌（不原地改）；② **按新位置重新编号标签** `newOptions[i].label = LABELS[i]`；③ **以「正确项文本」为映射锚点**（不是标签），`newCorrect = LABELS[shuffled.findIndex(o => o.text === correctText)]`。
  - **只洗牌不重新编号 = 没洗**：正确项会连同原标签一起移动，`correct` 恒为原标签（Spike 实测偏斜 100pp）。
  - 目的：切断 LLM 固有的位置偏置（Spike 实测 AI 组 4/4 题正确答案均为 B；参考实现亦观察到「正解高频落 A 或 C 达 40%~60%」）。
  - ⚠️ **可注入 RNG**：`shuffle(options, correctLabel, rng = Math.random)`——测试传确定性 RNG 即可断言映射不变式，零额外依赖。
  - ⚠️ **均匀性验证必须按单题统计**，不可跨题合并（各样本单选题数不等，合并会把「题目数不均」误读成偏斜）。
- **提示词**：单道主提示词（学科自适应最高优先级 + 题型 + 三档难度内部判据 + 场景多样性 + 误区导向 + 严格 JSON schema），用户主题**只作为 user message 传入**。主题最高 200 字（zod 限制）。

⚠️ **注入面**：`chat.ts:29` 接受客户端 `systemInstruction`，且 `chat-orchestrator.service.ts:159-160` 的优先级是 `custom_system_prompt?.trim() || systemInstruction || 内置导师 prompt`——**管理员未配 prompt 时，客户端 system prompt 直通模型**。**出题端点绝不能提供该入参**；system prompt 只由服务端常量决定。

### 4.4 配额、限流、审计（三个漏洞都要堵）

| 漏洞 | 现象 | 处置 |
| :--- | :--- | :--- |
| 节点墙 | `countCanvasNodes` 只数 `type='chat'`，练习不属画板故完全不计入 | 见下方「每日闸门的正确落点」 |
| token 闸门 | 不写 `recordAiRequestLog` 即绕过 `AI_DAILY_TOKEN_QUOTA` | **出题服务必须自己补 token 检查**：⚠️ `AI_DAILY_TOKEN_QUOTA` 的判定写在 `chat-orchestrator.service.ts:124-136` 的 `streamChat` **内部**，非流式的 `title.service` 那条路径**今天就绕过了它**（`routes/canvases.ts:170-200` 写审计但从不查配额）。故出题须自行调 `sumUserTokensSince` 做同样的 12 行检查，否则 token 闸门形同虚设。**出题与判卷均写审计**（`canvas_id`/`node_id` 传 null，字段全可空，先例 `feedbacks`） |
| 限流 | 无独立实例则与其他端点共桶 | `quizGenerateRateLimiter`（**先例：`autoTitleRateLimiter` 20/min @ `middleware/auth.ts:127-135`，同为非流式 AI 小额调用**）+ `quizAttemptRateLimiter`。⚠️ 依 ADR-0007「每类流量独立实例」 |

**每日闸门的正确落点**（评审修订，原方案的落点不成立）：

❌ **不能挂在 `assertCanInfer` 旁**——原方案如此写，但 `assertCanInfer(user, canvasId)` 在 `!canvasId` 时**直接 return 放行**（`quota.service.ts:58`），而练习不带 canvasId。挂上去等于什么都没做，正是 §2.3 反例一（`difficulty_judge.py:117-129` 那种「看起来在校验、实际空转」）的重演。

❌ **不能复用 `BOARD_LIMIT`/`NODE_LIMIT`**——两者都是**空间维度**计数（`listCanvases` / `countCanvasNodes`，`quota.service.ts:41,59`），**没有时间窗口概念**。

✅ **采用 24h 窗口限流器**（~12 行、零 DB 改动）：`windowMs: 24*3600*1000`，`max` 按角色（体验版 N/天、VIP 不限），`keyGenerator` 用 `user_${id}`。
- **先例**：`sendRegisterCodeRateLimiter` 已是 5/hour（`auth.ts:186-196`）；角色化 max 有 `roleBasedRateLimiter` 现成写法（`auth.ts:400-405`）。
- **代价**（接受）：固定窗口非日历日、进程重启即失效。ADR-0007 已把「in-memory 单实例」记为已知代价，且生产是单进程（无 cluster 配置），一期完全够。
- 若 Spike 后发现需要精确日历日口径，再升级为策略层计数闸门（`quota.policy.ts` 加纯函数 + `quota.service.ts` 加编排 + 仓储加计数 + `tests/quota-policy.test.ts` 加用例）。

⛔ **两条都别走 `ai_request_logs` 计数**——技术债清单已明文禁止（`log-cleanup` 按 90 天留存删除，计数会自行衰减）。

**端点清单**：

| 方法 | 路径 | 权限 | 限流 |
| :--- | :--- | :--- | :--- |
| POST | `/api/quiz/attempts` | 登录 + 邮箱已验证 | `quizGenerateRateLimiter` + 24h 闸门 |
| POST | `/api/quiz/attempts/:id/answers` | 记录属主 | `quizAttemptRateLimiter` |
| GET | `/api/quiz/attempts` | 登录 | `quizListRateLimiter` |
| GET | `/api/quiz/attempts/:id` | 记录属主 | 同上 |
| GET | `/api/quiz/stats` | 登录 | 同上 |

**「答案不下发」的保证方式**（评审修订）：原方案写「① 的响应体经 zod `.strip()` 白名单裁剪」。核实本仓既有 schema（`canvases.ts:35` / `:163`、`quota.ts:32`）**都是裸 `z.object`、从未显式写 `.strip()`**——虽 zod 默认会剥离未知键，但把它当作**安全边界**写在方案里是不可靠的论证。改为**构造式保证**：service 层返回专门的投影 DTO（`AttemptView` 类型，字段清单不含 `correct`/`explanation`），路由层不回传原始行。测试断言 ① 响应体 `JSON.stringify` 后不含这些键。

⚠️ **`listAttempts` 不得 select `questions` 列**（见 §4.2）——历史列表只取 `id/topic/difficulty/status/created_at` 与聚合摘要。

✅ **arch-test 无需改动**：`arch-tests/route-rate-limiter.test.mjs` 已于 2026-10-03 改为**从文件动态发现 router 变量名**（`ROUTER_DECL_RE`），不再是硬编码白名单——历史上它先后漏掉 `wechatRouter`（ADR-0022）与 `foldersRouter`，使这两个文件长期对限流判据零覆盖。新增路由直接挂 limiter 即可。⚠️ 若判据报「零覆盖」错误，说明正则与新的 router 声明写法不匹配，**应更新正则而非把变量名塞回白名单**。

### 4.5 前端（画布外独立面板）

**为何不做成画布节点**：① 需同步改 `DeepDiveCanvas.tsx:52-55`、`SharePage.tsx:31-32`、`SampleBoardViewer.tsx:27-28` **三处** `nodeTypes`，漏一处分享页白屏；② 新节点不被 `countCanvasNodes` 统计，天然是配额漏洞；③ 作答是线性快速流程，画布拓扑用不上。**练习成果不进画布**（二期可另议「存为节点」）。

**为何一期与画布完全独立（二期再做有机结合）**——用户 2026-10-03 拍板。三条理由：

1. **线性作答压进画布是滥用**：画布的价值集中在四件事——祖先上下文注入（`src/lib/context.ts:96` `buildAncestorContext` 沿入边回溯）、语义继承的追问（`context.ts:193`）、子树切分为独立资产（`src/lib/tree.ts:13-59`）、拓扑布局（`layout.ts:99-283`）。出题/点选/判卷/算正确率这四件事**画布一件都帮不上**。
2. **「答案不下发」与「存进画布」不可兼得**：见 §4.2——`getCanvas` 无差别回传 `custom_data`。二选一，选安全性。
3. **不新增节点类型**：`nodeTypes` 三处注册（`DeepDiveCanvas.tsx:52-55`、`SharePage.tsx:31-32`、`SampleBoardViewer.tsx:27-28`）原样够用，漏改一处分享页白屏的风险直接消除。未知类型还有个暗坑：`board-import.ts:89` `normalizeType` 会把未知类型**静默归一为 `chat`**，JSON 备份往返即静默损坏。

**⚠️ 「先独立」不意味着二期要拆掉重做**——已核实结合成本极低（这是把边界划在一期的关键依据）：
- 二期把练习成果落成**一张 `chat` 标记卡片**（不新增节点类型）即可自动继承四条既有链路：`context.ts:150` 只筛 `type==='chat'`（带 quiz 标记的节点自动成为后续追问的**祖先**）、`board-ops.ts:131-136` 非 `KNOWN_DATA_KEYS` 字段进 `custom_data` 往返、`storage.ts:665` Markdown 导出、`share.service.ts:51-55` 分享快照。
- 二期若做间隔重复（SRS），把 `answers` JSONB 按题粒度迁到行表即可（`ALTER TABLE ADD COLUMN` 幂等增量迁移，schema.ts 机制成熟）——**这是一次可预期的迁移，不是一期欠下的债**。

**已知代价（如实记录）**：练习成果不进画布 ⇒ 无分享、无 PNG/Markdown/JSON 导出。`storage.ts:665` 导出只处理 `type==='chat'`，分享快照只有 `{title, nodes, edges}`。**练习将是一期唯一不留痕、无成果物的功能**——这是「先独立」的已知代价，二期结合后消除。**UI 不得因此降级**（练习记录、历史、统计都要完整可用），但文案不得暗示练习能导出或分享。

- 组件：`src/components/quiz/QuizPanel.tsx` + `quiz-store.ts`（照 `folder-store.ts` 范式：服务端为准 + 本地按 scope 缓存；**跨画板数据不进 board-store/sync-queue**——那些是画布内容链路）。
- **入口落点：画板库（`BoardLibraryModal`）内新增「练习」tab**（用户 2026-10-03 认可）。
  - 理由：顶栏已有同步态/画板切换/新建/画板库/灵感开关/节点数/搜索/布局/居中/`更多`菜单/VIP/主题/用户菜单共 12 处，**再加第 6 个常驻按钮不自然**；而画板库已是「非画布内容的集中管理面」，练习是跨画板资产，归属同一心智。
  - ⚠️ **实现代价（评审核实，勿低估）**：`src/components/ui/BoardLibraryModal.tsx`（455 行）**原本没有任何 tab 架构**，直接「加个 tab」实际是**先引入 tab 骨架**（`tab` state + 切换栏 + 练习态下隐藏文件夹侧栏与画板列表）。范式照 `src/components/admin/AdminDashboardModal.tsx:64` 的 `useState<'…'|'…'>` 写法。
  - 二期若练习要独立成更重的功能，可从画板库 tab 提升为独立顶栏入口——届时面板已是独立组件，迁移成本低。
- ⚠️ **feature flag 的下发链路**（实现时补上的接缝）：本仓**没有**运行时配置下发机制（无 `VITE_` 注入、`/me` 也不带开关），前端无从得知后端 `QUIZ_ENABLED`。处置：由 **`GET /api/auth/me` 的 `user.features.quiz`** 下发（前端 `AuthContext.refreshUser` 是整体 `setUser(data.user)`，故自动透传），`BoardLibraryModal` 的 `quizEnabled` prop 据此隐藏入口。
  - 后端 env 仍是权威，端点侧另有 `ensureQuizEnabled()` 兜底 404——前端漏判也只是入口露出点，不至于出现异常行为。
- ⚠️ **草稿计时的一个易错点**（实现时修正）：每题 `elapsedMs` 若用「提交时刻 − 开卷时刻」或据此均分，**每题都等于总时长**，判断题的 `low_confidence`（3s）就永远判不出秒答、标记形同虚设。正确口径：**每题用时 = 本题首答时刻 − 上一题首答时刻**（首题用开卷时刻）。
- 作答草稿：照 `chat-draft.ts` 先例存 sessionStorage，切走面板/刷新不丢；**提交成功后必须清除**。
- scope 隔离：走 `src/lib/board-scope.ts` 的 `scopedKey` 家族，游客不显示入口。
- 面向用户文案：不出现「多 Agent」「审核」「难度标签」「自审」等内部术语（先例：`src/lib/checklist.ts:23-28` 四步引导全是动词短语、零术语）。难度文案用「入门/进阶/困难」。
- ✅ **「掌握情况」取代「正确率」（用户 2026-10-03 拍板）**：「正确率」把产品从「深度探索」拉向「刷题 App」，与品牌定位冲突（CODEBUDDY.md 要求文案不得把产品说成工具型产品）。**面向用户一律说「掌握情况」**（如「本次掌握 4 / 5」），只呈现探索性反馈、不做评分评级。
  ⚠️ **仅文案层替换，代码标识符与统计口径不变**：字段仍为 `is_correct`，`low_confidence` 的数学依据（判断题 50% 猜对率）也仍是正确率——「掌握情况」是叙述口径，不是另一个指标。

### 4.6 feature flag

按既有 4 个开关范式（`PAYMENT_ENABLED` / `SAVE_DEFAULT_BOARD_MODE` / `SAVE_LEGACY_REPLACE_ENABLED` / `OUTBOUND_ALLOW_PRIVATE_HOSTS`）新增 `QUIZ_ENABLED`，**默认 false**，四处登记：`.env.example`、部署手册 §环境变量表、`安全发布checklist.md`、本 Spec。关闭时：端点 404、面板入口不渲染。

⚠️ **不要**改成判 `NODE_ENV`（`mock-pay` 的反面教材：预发/漏设 NODE_ENV 的线上会静默失效）。

## 5. 测试

新增 `tests/r1-quiz.test.ts`（**`tests/` 只读，需用户显式授权新建**）：

| 组 | 用例 | 期望 |
| :-- | :--- | :-- |
| 生成 | 正常返回 | ① 响应**只有** id/type/stem/options，**无** correct/explanation（构造式 DTO，有测试锁定） |
| | 主题超长/空 | zod 400 |
| | 模型返回坏 JSON | 落 `review.parseFailed` 并**如实告知用户**，不静默空结果 |
| | 选项随机洗牌 | 多次生成后单选 `correct` 在 A/B/C/D 间均匀分布，消除位置偏置 |
| 判卷 | 全对/全错/混合 | 逐题 `is_correct` 正确；`correct`+`explanation` 仅在 ② 返回 |
| | 判断题 2 秒内作答 | `low_confidence=true` |
| | 耗时防篡改 | 客户端提交的 `elapsed_ms` 超出会话生命周期 $\to$ 400 拦截 |
| | 状态机流转 | 提交后 `status` 变 `completed`、`completed_at` 回填 |
| | 重复提交同一 attempt | 409（`UPDATE … WHERE status='in_progress'` 影响 0 行） |
| | list 接口 | 响应体不含 `correct`/`explanation`（验证 `listAttempts` 未 select `questions`） |
| 隔离 | 他人 attemptId 读/答 | 403/404，且他人数据不受影响 |
| | 无会话用户 | 401；未验证邮箱 403 |
| 限流 | 连打生成端点 | 429 |
| 闸门 | 超出 24h 次数（体验版） | 429 |
| 统计 | 正确率/按题型/错题清单/知识点分组 | 与逐题数据一致（构造已知答案集比对） |
| 迁移 | 新表存在 + RLS 策略就位 | `pg_class`/`pg_policies` 断言（PG 用例） |

**PG 真库**：`tests/pg/r1-quiz.pg.test.ts`（`PG_SMOKE=1` 门控 + `PG_TEST_URL`）。⚠️ **必须在 `after()` 里 `server.close()`**——漏掉会让 PG 冒烟步骤无限挂起直到 GitHub 6 小时 job 上限（2026-09-16~09-18 连续三次 5h58m 挂死的根因）。

**arch-tests**：`rls-coverage`（`quiz_attempts` 归类）· `repository-dual-mode`（新仓储每个函数含 `getDb(` + `inMemoryStore.`）· `route-rate-limiter`（自动覆盖新路由文件，**只需挂 limiter**）· `csrf-guard`（新路由挂在 guard 之下自动受保护）· `db-scope-discipline`（仓储内不出现 `runWithUser`/`runWithSystem`）。

**验收**：`npx tsc --noEmit` + `npm test` 全绿 + arch-tests 全绿 + PG 冒烟两遍。

## 6. 分析口径与二期规划

### 6.1 一期分析口径（基础版）

> 面向用户呈现时一律用「**掌握情况**」；下列「正确率」是**代码与统计口径**的内部叫法（`is_correct` 字段），二者指同一件事，勿混用两套指标。

- 本次：掌握情况（对 X / 共 Y）、按题型掌握情况、逐题对错、用时、错题清单（按知识点标签分组）。
- 累计：练习次数、累计掌握情况、按难度档正确率（**用于二期反向校准，见 §7**）。
- **低置信单列**：判断题秒答单独统计并显示，不混入「已掌握」。

### 6.2 二期待做（本期明确不做，延后落地）

1. **与 ex-kg 思维画布轻量双向联动**（2026-10-03 评审推迟）：
   - **画布 $\to$ 练习**：在画布中选中节点/选区打开练习面板时，自动预填节点名为练习主题，打通「探索到检验」；
   - **练习 $\to$ 画布**：错题解析卡片旁提供「在画布中探索此知识点」快捷操作，一键在当前画布新建探索节点，打通「错题到深挖」。
2. **薄弱知识点识别 $\to$ 推荐后续练习方向**：
   - 需足量作答样本才有意义，一期样本不足、推荐必失真。**但一期必须把 `knowledge_point` 标签存进去**——这是二期分析的原料，一期不存二期就得重做历史数据。
3. **自适应与记忆曲线（SRS）**：借鉴 FSRS 算法计算知识点掌握度矩阵与复习周期。

## 7. 风险与已知边界

| 风险 | 级别 | 说明与处置 |
| :--- | :--- | :--- |
| **题目质量不可控** | 高 | AI 出的题可能有知识性错误。一期靠「如实告知 + 解析可见 + 引导去 chat 深挖」，**不承诺正确性**；文案不得暗示题目经过人工校验 |
| **难度档名不副实** | 中 | 模型自评不可信。一期靠 CoT 自审 + UI 标注；**二期用真实正确率反向校准**（若「困难」正确率未显著低于「入门」，说明档位没落地） |
| **选项位置偏置（Position Bias）** | 中 | 模型出题高频将正解放在 A 或 C。**处置：服务端落库前统一执行 Fisher-Yates 随机打乱**，同步更新 `correct` 字段。⚠️ 注意这是**统计倾向的缓解**而非「分布均匀」的保证——不要写测试锁定 A/B/C/D 精确均匀（那测的是伪随机数发生器）；Spike 里只需观察是否明显偏斜 |
| **判断题 50% 猜对污染正确率** | 中 | `low_confidence` 标记 + 单列统计。参考实现只管生成不管作答，完全没有这个概念。⚠️ 该判定依据（3 秒 + 50% 猜对率）**只对判断题成立**——单选题猜对率 25% 虽低但非零、结论不成立，故阈值不套用到单选题 |
| **客户端伪造答题耗时** | 低 | 篡改 `elapsedMs` 试图规避 `<3s` 标记。**处置：服务端校验 $\sum elapsedMs \le \text{NOW}() - \text{created\_at} + 5000\text{ms}$** |
| **串行双 Agent 延迟超时** | 中 | 评审已优化：放弃独立审核 Agent 串行调用，采用单次提示词 CoT 自审，出题耗时由 15s+ 压减至 3~5s |
| 配额绕过（节点墙 / token 闸门） | 中 | §4.4 三处均已堵。⚠️ 附带发现：**非流式的 `title.service` 路径今天就在绕过 `AI_DAILY_TOKEN_QUOTA`**（判定写死在 `streamChat` 内部），出题须自行补检查，否则闸门形同虚设 |
| 主题注入 | 中 | system prompt 仅服务端常量；主题只进 user message 且 zod 限 200 字；**不提供 `systemInstruction` 入参** |
| 深度优先 vs 快速作答的张力 | 低 | §3.2 已如实标注；困难档题量默认 3 |
| 「快速作答」被误解为追求速度 | 低 | UI 不做倒计时/排行榜 |
| 审核空转（反例一重演） | 中 | 自审结论必须真被消费（落 `review` 列并呈现给用户），有测试锁定 |
| PG 占位符复用 | 低 | 遵循既有纪律：同一占位符不得用于两种类型上下文（曾致生产下单全败，`42P08`） |
| 平台 6h 挂死 | 中 | 新 PG 用例必须 `server.close()` |

## 8. 落地顺序

**阶段 0：Spike（已完成，2026-10-03）—— 结论见 §8.1，开发据此定稿**

### 8.1 Spike 结论

**执行方式变更**：原计划用真实 API key 跑 10 组调用，但本机 `.env` 的 `GEMINI_API_KEY` 是占位符、线上凭据按项目纪律不得取出。**改由本模型（CodeBuddy Code）直接充当被测模型**——按拟定提示词真实产出样本，再对样本做机器校验。

这样验的是**提示词与 schema 设计**（最难返工的部分），而「可解析率 / 延迟 / token」属 API 集成层、风险低（`response_format` 是标准能力，解析容错由 jsonrepair + zod + 分层校验兜底），**留待首批真实调用观测**。

样本与提示词存于 `docs/spike/r1-quiz-prompt-validation.ts`（2 组：AI/困难、非 AI 生物/入门，各 5 题）。

| 指标 | 结论 |
| :--- | :--- |
| ② 难度梯度 | ✅ 成立。困难档题干 47~70 字（需推导缩放因子、多头子空间、复杂度归因），入门档 25~59 字（概念直给），梯度清晰 |
| ② 干扰项质量 | ✅ 成立。干扰项均针对具体误区（必要条件当充分条件、权重≠因果、√d_k 与 d_k 比例关系），无荒谬项 |
| ④ 学科自适应 | ✅ 生效。生物样本的 AI 术语命中为 **0**（同批 AI 样本命中「注意力机制/参数/softmax」反证检测器有效） |
| ② schema 自洽 | ✅ 5 题结构全部通过 zod 校验；标签为 A/B/C/D、`correct` 均在标签内、选项无重复、判断题 `options=null` |
| ③ 洗牌均匀性 | ⚠️ **发现一个会写错的实现细节，见下** |
| ① 可解析率/延迟/token | ⏸ **未测**（无 key），留待线上首批真实调用 |

**🔴 ③ 暴露的实现陷阱：洗牌后必须重新编号标签**

Spike 样本中 AI 组 4 道单选的正确答案**全部是 B**（真实模型有强位置偏置，与参考实现观察到的一致）。若不洗牌，用户选 B 即可白拿分。

⚠️ **但「洗牌 + 同步更新 `correct`」这个 Spec 表述不够——它没说清要重新给标签编号。** 验证发现：**若洗牌后沿用原标签，正确项会连同标签一起移动，`correct` 永远是 B，偏斜 100pp，等于没洗**。

正确实现（三步，缺一不可）：
1. Fisher-Yates 洗牌（拷贝，不原地改）；
2. **按新位置重新编号**：`newOptions[i].label = LABELS[i]`（固定 A/B/C/D）；
3. **用「正确项文本」而非标签做映射锚点**：`correctText = 原选项.find(o => o.label === correct).text`，洗牌后 `idx = findIndex(o => o.text === correctText)`，`newCorrect = LABELS[idx]`。

验证结果（每题 20000 次）：重新编号后单题级分布 `A/B/C/D` 偏斜 **< 1.5pp**，且「`correct` 始终指向原正确项文本」不变式全程成立。

⚠️ **另一个验证陷阱（勿重犯）**：洗牌均匀性**必须按单题统计**，不能跨题合并——不同样本的单选题数量不等（AI 组 4 道、生物组 3 道），合并会把「题目数不均」误判成「洗牌偏斜」（Spike 中一度误报 33pp 偏斜）。

**Spike 后的实现定稿**：
- 结构化输出：线上 provider 是**千问（OpenAI 兼容 `/responses`）**，故用 `response_format: { type: 'json_schema', json_schema: { schema, name } }`（阿里云已支持 json_schema），不支持时降级 `json_object`。**Gemini 的 `responseJsonSchema` 不吃 `$ref`/`$defs`**——故 schema **不得用 `z.discriminatedUnion`**，须用「统一 shape + `type` 字段判别」（已实测导出无 `$ref`）。
- zod v4 **内置 `z.toJSONSchema()`**（已实测，`package.json` 版本 4.5.4），无需 `zod-to-json-schema`。
- 截断防护五步：① 按最坏情况给足 `max_output_tokens`（每题约 400 token → 4000+）；② **检查 `finishReason`，`MAX_TOKENS` 直接判失败重试**（不修复）；③ **先截出 JSON 本体**（`extractJsonBlock`）；④ `jsonrepair` 兜底 + zod 二次校验（`.length(5)` 挡住「4 道半题」）；⑤ 带 zod issue 重试一次。
  - ⚠️ **③ 为什么必要（实测）**：`jsonrepair` 遇到「自然语言 + JSON」时会把整段**包成一个数组** —— 实测输入 `好的，这是您要的题目：\n{…}\n希望对您有帮助！` 得到可 parse 的 `{0:…, 1:…, 2:…}`。它**能 parse 但 zod 拒绝**。`response_format: json_schema` 已从协议层消除该场景，但提示词仍只是「请求」模型不输出解释文字，故仍需这道防线。
  - ⚠️ **④ 为什么必要（实测）**：jsonrepair 对截断输出**只保证「能 parse」**——实测 72% 截断的样本修复后仍剩 4 题（被截掉的内容变 null），单靠它会放行残缺批次，**必须再过 `.length(5)`**。
- **新增依赖仅 1 个**：`jsonrepair`（8KB、零依赖、ISC）。GitHub 调研已否决 `instructor-js`（2025-01 停更）、`vercel/ai`（需全家桶+换掉现有双链路）、`openai-node`（本仓走手写 fetch）、`ajv`（zod 已覆盖）、`seedrandom`（2019 年发布，自写 5 行即可）。

**阶段 1**：Schema + 状态机字段 + 归类 + 内存分支 → 阶段 2：出题服务（CoT 自审 + 洗牌流水线） → 阶段 3：端点（两段式 + 限流 + 审计 + 闸门 + 防作弊校验）→ 阶段 4：前端（`BoardLibraryModal` 引入 tab 骨架 + `QuizPanel` + `quiz-store`）→ 阶段 5：测试（默认 + PG）→ 阶段 6：`QUIZ_ENABLED` 登记四处 + 部署手册同步。

## 9. 验收标准

- [x] Spike 已执行（2026-10-03，结论见 §8.1）：难度梯度、干扰项质量、学科自适应、schema 自洽、洗牌三步实现均已验证；「可解析率/延迟/token」无 key 未测，留待线上首批真实调用观测。
- [x] ① 响应体**不含** `correct` / `explanation`（**构造式 DTO**，非依赖 zod 默认剥离；有测试锁定）。
- [x] `listAttempts` **不 select `questions` 列**（历史列表响应体不含答案，有测试锁定）。
- [x] 洗牌**三步齐全**（拷贝洗牌 → 重新编号标签 → 以文本为锚点更新 `correct`）；测试注入确定性 RNG 断言映射不变式；**不断言跨题均匀**。
- [x] 出题用 `response_format: { type: 'json_schema' }`（降级 `json_object`）；`maxOutputTokens` ≥ 4000 且检查 `finishReason`（`MAX_TOKENS` → 重试而非修复）；`jsonrepair` 修复后**必须再过 zod**（`.length(5)` 挡住残缺批次）。
- [x] 出题 schema **不含 `$ref`/`$defs`**（Gemini 侧限制；当前 provider 为千问但保持该约束以备切换）。
- [x] 判卷为确定性答案比对；客户端耗时防篡改与 `low_confidence` 判定有测试（`low_confidence` 阈值**仅**适用于判断题）。
- [x] `quiz_attempts` 单表含 `status` + `completed_at`；`UPDATE … WHERE status='in_progress'` 条件更新保证重复提交返回 409。
- [x] `quiz_attempts` 已归 `RLS_DIRECT_USER_TABLES`；`purgeUserDataMemory` 的清理代码**放在 `user.repository.ts:472` 早退之前**；`quiz.ts` 已挂 limiter（arch-test 自动覆盖，无需登记变量名）。
- [x] 24h 次数闸门生效（体验版，VIP 不限）；**出题服务自行实现了 token 闸门检查**（不依赖 `streamChat` 内部的判定）；独立限流均生效。
- [x] 出题端点**不提供** `systemInstruction` 入参。
- [x] `npx tsc --noEmit` 通过；`npm test` 全绿（665/665）；`arch-tests` 全绿（34/34）；`npm run build` 通过。
- [ ] **PG 冒烟两遍绿**（含新增 `tests/pg/r1-quiz.pg.test.ts`）——⛔ **本机无 docker，全程未实测**，须 CI 验证。注意：新增 PG 用例文件**不得**把装配放 `before()` 钩子（不受 `PG_SMOKE` 门控 → 无 PG 时白等 30s），且必须同时 `server.close()` 与 `ownerPool.end()`（两处都是「常开连接 → 事件循环永不空闲」的挂死源）。
- [x] `QUIZ_ENABLED` 默认 false 并完成四处登记；`docs/数据库建表脚本.sql` 同步（`schema.ts` 仍为唯一事实源）。
- [x] 面板入口在游客态不渲染；面向用户文案无内部术语，**面向用户一律说「掌握情况」不说「正确率」**（代码字段仍为 `is_correct`，勿混用两套指标）。
- [x] 画板库已引入 tab 骨架并挂载「练习」tab（`BoardLibraryModal.tsx` 改动不破坏既有画板/分组功能）。
- [x] 困难档默认题量 3，但**数量选择器在任意难度下均可见可改**。
- [x] **一期不向画布写入任何数据**（`canvas.repository.ts` 无新增写入路径、`nodeTypes` 三处未改动）——为二期结合留出干净的边界。
