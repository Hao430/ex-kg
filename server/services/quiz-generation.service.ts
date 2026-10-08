/**
 * Spec R1 — AI 出题服务（非流式，双 provider）。
 *
 * 照 `title.service.ts`（Spec J1）另起一路，**不复用** `ai-provider.interface.ts`
 * （其 `execute()` 签名强制吃流式回调，结构化出题用不上）。
 *
 * 三个关键设计（Spike 定稿，见 Spec §8.1）：
 * 1. **结构化输出**：线上 provider 是 OpenAI 兼容 `/responses`（千问），用
 *    `response_format: { type: 'json_schema' }`；不支持时降级 `json_object`。
 *    ⚠️ schema 刻意不含 `$ref`/`$defs`（Gemini 侧不吃），换 provider 也安全。
 * 2. **截断防护四步**：给足 max_output_tokens → 查 finishReason（MAX_TOKENS 直接判失败，
 *    **不修复**）→ jsonrepair 兜底 → **必须再过 zod**（`.length(n)` 挡住残缺批次）。
 * 3. **token 闸门自补**：`AI_DAILY_TOKEN_QUOTA` 的判定写死在 `chat-orchestrator`
 *    的 `streamChat` 内部，非流式路径**绕过**它（`title.service` 今天就是这样）。
 *    故本服务自行调 `sumUserTokensSince` 复刻那 12 行检查，否则闸门形同虚设。
 */
import { GoogleGenAI } from '@google/genai';
import { jsonrepair } from 'jsonrepair';
import { getAiModelConfig, resolveOpenAiEndpoint, recordAiRequestLog, sumUserTokensSince } from './ai.service.js';
import { AppError } from '../lib/errors.js';
import type { AiModelConfig, QuizQuestionRecord, QuizOptionRecord } from '../core/records.js';
import {
  buildQuizJsonSchema,
  validateGeneratedQuiz,
  type GenerateQuizInput,
  type GeneratedQuiz,
} from './quiz-schema.js';

/**
 * 出题系统提示词。
 *
 * 借鉴参考实现（questioner-skill）的两条经验：
 * 1. **「判定学科」置于最高优先级**：参考仓库曾把非 AI 学科的题硬塞进
 *    「神经网络/梯度下降」，根因是提示词写死了领域假设。我们面对「用户输入任意主题」
 *    是同一类风险，故把学科判定提为第一步并显式否定强插 AI 概念。
 * 2. **干扰项须针对常见误区构造**，严禁明显荒谬项；判断题错误陈述须针对误区且错因具体。
 *
 * ⚠️ 用户主题**只进 user message**，本常量是服务端唯一 system prompt 来源
 * （出题端点绝不提供 `systemInstruction` 入参，注入面见 Spec §4.3）。
 */
const QUIZ_SYSTEM_PROMPT = `你是严谨的出题专家。

## 第一步：判定学科（最高优先级，先于以下全部规则）
先判断用户主题所属学科：
- 属物理/化学/生物/历史/地理/语文/数学等学科 → 严格按该学科的知识与思维方式出题，
  绝不可强行插入神经网络、梯度下降、损失函数、注意力机制等 AI 概念
- 属人工智能/机器学习领域 → 严格按下方 AI 相关要求出题
- 数学主题 → 除非用户明确要求与 AI 结合，否则按纯数学出题

## 第二步：题型
- 单选题：4 个选项（A/B/C/D），恰好 1 个正确答案。干扰项必须针对**学习者的常见误区**构造
  （如把必要条件当充分条件、混淆因果与相关、遗漏边界条件），
  **严禁**出现明显荒谬、一眼可排除的选项
- 判断题：一句**非模棱**的陈述。错误陈述必须针对常见误区设计，
  且错的原因要具体（不能是"表述不严谨"这类模糊理由）
- 本批题中判断题的正误比例接近 1:1
- 题干场景化，贴近目标人群的认知水平；同一批题目里主语与场景不得重复

## 第三步：难度（不可自行更改，按传入值严格执行）
- 入门：概念直给，题干 ≤80 字，不用术语堆砌。考记忆与理解
- 进阶：需一步推理，题干 ≤150 字。考应用与计算
- 困难：多步骤推理或新情境迁移，题干 ≤250 字。考分析与综合评价
不考死记硬背的数字、年份、公式系数。

## 输出要求
只输出严格 JSON，不要任何解释文字，不要 Markdown 代码块围栏。
每题给出解析（2 句以内，说清为什么对、错项错在哪）。
单选与判断题混合出题，题型字段 type 分别为 'single' 与 'true_false'。`;

/** 选项标签（洗牌后按新位置重新编号，见 shuffleSingleQuestion） */
const LABELS = ['A', 'B', 'C', 'D'] as const;

/**
 * 每题输出上限估算：题干 ≤250 字 + 4 选项 + 解析 2 句 ≈ 400 token。
 * 按最坏情况给足余量，避免 max_tokens 截断导致批次残缺（Spike 结论 §8.1）。
 */
const MAX_OUTPUT_TOKENS_PER_QUESTION = 500;
const MAX_OUTPUT_TOKENS_MIN = 4000;

export interface GenerateQuizMeta {
  ok: boolean;
  modelName: string;
  provider: 'openai' | 'gemini';
  totalTokens: number;
  latencyMs: number;
  /** 出题自审摘要（透传给前端展示，让用户知道这套题的来历） */
  review: {
    subject?: string;
    difficultyFit?: string;
    misconceptionDesign?: string;
    /** 解析/校验失败时置 true，**如实告知用户**，不静默返空 */
    parseFailed?: boolean;
    attempts?: number;
    error?: string;
  };
}

export interface GenerateQuizResult {
  /** 已带上题级 id 并完成洗牌，可直接落库 */
  questions: QuizQuestionRecord[];
  meta: GenerateQuizMeta;
}

// ─────────────────────────── 洗牌（Spike 验证的三步实现）───────────────────────────

/**
 * 单选题洗牌，消除 LLM 固有的位置偏置。
 *
 * ⚠️ **三步缺一不可，缺任一步等于没洗**（Spike 实测，见 Spec §8.1）：
 * 1. 拷贝后 Fisher-Yates 洗牌（不原地改，避免污染调用方的数组）；
 * 2. **按新位置重新编号标签** `newOptions[i].label = LABELS[i]`；
 * 3. **以「正确项文本」而非标签为映射锚点**求新答案。
 *
 * 只做 1 而漏掉 2/3 时，正确项会连同其原标签一起移动 → `correct` 恒为原标签，
 * 实测偏斜 100pp（用户选同一个字母即可白拿分）。
 *
 * @param rng 注入随机源以便测试断言映射不变式；生产用 Math.random 即可
 *            （出题是产品功能而非安全边界，答案标签是服务端算的又不外泄）
 */
export function shuffleSingleQuestion(
  options: readonly QuizOptionRecord[],
  correctLabel: string,
  rng: () => number = Math.random,
): { options: QuizOptionRecord[]; correct: string } {
  // 1. 拷贝后洗牌（Fisher-Yates）
  const shuffled = options.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 2. 按新位置重新编号标签
  const newOptions = shuffled.map((o, i) => ({ label: LABELS[i], text: o.text }));

  // 3. 以正确项**文本**为锚点求新标签（用标签会因移动而失效）
  const correctText = options.find((o) => o.label === correctLabel)?.text;
  const idx = correctText === undefined ? -1 : shuffled.findIndex((o) => o.text === correctText);
  if (idx < 0) throw new Error('洗牌丢失了正确项（选项文本重复或为空）');

  return { options: newOptions, correct: LABELS[idx] };
}

// ─────────────────────────── 解析与截断防护 ───────────────────────────

/**
 * 把模型原始输出解析成结构化题目。
 *
 * 四步防护（任一失败即抛，由调用方决定是否带 issue 重试）：
 * 1. `extractJsonBlock` 先截出 JSON 本体；
 * 2. `jsonrepair` 兜底（补截断的括号/引号）；
 * 3. `JSON.parse`；
 * 4. **zod 校验 + 确定性守卫**——jsonrepair 只保证「能 parse」，被截掉的内容会变 null，
 *    只有 `.length(count)` 能把「4 道半题」挡下来，故**修复后必须再过校验**。
 *
 * ⚠️ 为什么要先截 JSON（Spike 实测）：提示词已要求「不要任何解释文字」，但模型偶尔不听话。
 * `jsonrepair` 遇到「自然语言 + JSON」时会把整段**包成一个数组**（实测得到 `{0:…,1:…,2:…}`）
 * —— 它确实「能 parse」，但 zod 拒绝。故必须先切出 JSON 本体。
 */
function parseAndValidate(raw: string, count: number): GeneratedQuiz {
  const json = JSON.parse(jsonrepair(extractJsonBlock(raw)));
  return validateGeneratedQuiz(json, count);
}

/**
 * 描述模型原始输出的**结构**（不含任何题目内容）。
 *
 * ⚠️ 只记形状不记内容：`ai_request_logs` 与错误文案都不该落题面/用户主题
 * （同「节点内容不进日志」的纪律）。但仅凭 `expected object, received array`
 * 无法判断模型到底吐了什么——2026-10-03 那次排查正是卡在这里：
 * 既不知道是数组、也不知道是几元素、也不知道是否被截断。
 * 故把**元信息**（顶层类型 / 长度 / 字节数）拼进错误文案：
 * `shape=array len=5 bytes=1834` 一眼就能区分「漏信封」「双份输出」「被截断」。
 */
function describeShape(raw: string): string {
  const text = raw.trim();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!text) return 'shape=empty bytes=0';

  let shape: string;
  try {
    const parsed: unknown = JSON.parse(jsonrepair(extractJsonBlock(text)));
    if (Array.isArray(parsed)) {
      shape = `array len=${parsed.length}`;
    } else if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed as Record<string, unknown>);
      // 信封是否缺失是本次故障的关键信号，故把顶层键名带出来（键名是结构不是内容）
      shape = `object keys=${keys.slice(0, 5).join(',') || '(none)'}`;
    } else {
      shape = `scalar ${parsed === null ? 'null' : typeof parsed}`;
    }
  } catch {
    // 连repair 都救不回来 = 输出根本不是 JSON（如纯散文或空响应）
    shape = `unparsable firstChar=${JSON.stringify(text[0])}`;
  }
  return `shape=${shape} bytes=${bytes}`;
}

/**
 * 从可能夹杂自然语言的输出里截出 JSON 本体。
 * 优先取第一个 `{` 到最后一个 `}`；找不到再退化到首个 `[`（容错，正常不会走到）。
 */
function extractJsonBlock(raw: string): string {
  const text = raw.trim();
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) return text.slice(objStart, objEnd + 1);
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) return text.slice(arrStart, arrEnd + 1);
  return text;
}

/** 出站响应里的 finishReason 判定（OpenAI 兼容 /responses 与 Gemini 字段名不同） */
function isTruncated(body: any): boolean {
  const candidates = body?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    // Gemini：finishReason 可能是 'MAX_TOKENS'
    if (String(candidates[0]?.finishReason || '').toUpperCase().includes('MAX_TOKENS')) return true;
  }
  if (String(body?.status || '').toUpperCase() === 'INCOMPLETE') return true;
  const incomplete = body?.incomplete_details;
  if (incomplete && String(incomplete.reason || '').toUpperCase() === 'MAX_OUTPUT_TOKENS') return true;
  return false;
}

// ─────────────────────────── 主流程 ───────────────────────────

let genaiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!genaiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    genaiClient = new GoogleGenAI({ apiKey });
  }
  return genaiClient;
}

/** token 闸门：复刻 chat-orchestrator 的检查（非流式路径不经过它） */
async function assertTokenQuota(userId: string): Promise<void> {
  const dailyTokenQuota = parseInt(process.env.AI_DAILY_TOKEN_QUOTA || '2000000', 10);
  if (dailyTokenQuota <= 0) return;
  const now = new Date();
  const dayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const usedTokens = await sumUserTokensSince(userId, dayStartUtc);
  if (usedTokens >= dailyTokenQuota) {
    throw new AppError(429, 'DAILY_TOKEN_QUOTA_EXCEEDED', '今日 AI 用量已达上限，请明日再试或联系管理员调整');
  }
}

function buildUserContent(input: GenerateQuizInput): string {
  return `主题：${input.topic}\n目标难度：${input.difficulty}\n请生成 ${input.count} 道题。`;
}

function toRecords(quiz: GeneratedQuiz): QuizQuestionRecord[] {
  return quiz.questions.map((q, idx) => {
    const id = crypto.randomUUID();
    if (q.type === 'single' && q.options) {
      // 洗牌三步（见 shuffleSingleQuestion），并同步更新 correct
      const shuffled = shuffleSingleQuestion(
        q.options.map((o) => ({ label: o.label, text: o.text })),
        q.correct
      );
      return {
        id,
        type: 'single',
        stem: q.stem,
        options: shuffled.options,
        correct: shuffled.correct,
        explanation: q.explanation,
        knowledge_point: q.knowledge_point,
      };
    }
    return {
      id,
      type: 'true_false',
      stem: q.stem,
      options: null,
      correct: q.correct,
      explanation: q.explanation,
      knowledge_point: q.knowledge_point,
    };
  });
}

/**
 * 出站调用与解析的**统一记账点**（Spec R1 观测缺口修复）。
 *
 * ⚠️ 为什么不能沿用「先记 success，再解析」的写法：解析失败会抛给外层 catch，
 * 而那条 success 记录**已经落库且无法撤回**——于是「出题失败」在
 * `ai_request_logs` 里显示为 `status=success`、`error_message` 为空，
 * 运营台看上去一切正常，排查时**唯一线索只存在于 HTTP 响应体里**（出进程即丢）。
 * 2026-10-03线上那批 `invalid_type: expected object, received array` 就是这么查不出来的。
 *
 * 故改为：先解析出结果，再按**真实结局**记一条（成功 success / 失败 error + 原因）。
 * `errorMessage` 落**截断后的 zod 摘要**（与前端 review.error 同一份文本），
 * 不落模型原文——题面内容不进日志，与画布保存观测同一纪律。
 */
async function recordQuizCall(input: {
  userId: string;
  provider: 'openai' | 'gemini';
  modelName: string;
  start: number;
  totalTokens: number;
  ok: boolean;
  errorMessage?: string;
}): Promise<void> {
  await recordAiRequestLog({
    userId: input.userId,
    canvasId: null,
    nodeId: null,
    modelName: input.modelName,
    totalTokens: input.totalTokens,
    latencyMs: Date.now() - input.start,
    status: input.ok ? 'success' : 'error',
    errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
    provider: input.provider,
  });
}

/** 失败时构造的空结果（元信息里带 parseFailed 与原因，如实告知前端） */
function failedResult(
  provider: 'openai' | 'gemini',
  modelName: string,
  start: number,
  error: unknown,
  attempts: number,
  totalTokens = 0,
): GenerateQuizResult {
  const message = String((error as Error)?.message || error).slice(0, 200);
  return {
    questions: [],
    meta: {
      ok: false,
      modelName,
      provider,
      totalTokens,
      latencyMs: Date.now() - start,
      review: {
        parseFailed: true,
        attempts,
        error: message,
      },
    },
  };
}

/**
 * 生成练习题。
 *
 * ⚠️ 本函数**不抛错**（除 token 闸门外），失败时返回 `questions: []` +
 * `review.parseFailed=true`——出题是主功能，静默返空会让用户以为「AI 出不了题」，
 * 故失败原因必须透传到前端（对照 title.service 的静默返 null 那是刻意选择，此处不同）。
 */
export async function generateQuiz(
  userId: string,
  input: GenerateQuizInput,
): Promise<GenerateQuizResult> {
  const start = Date.now();
  const config: AiModelConfig = await getAiModelConfig();
  const userContent = buildUserContent(input);
  const maxOutputTokens = Math.max(MAX_OUTPUT_TOKENS_MIN, input.count * MAX_OUTPUT_TOKENS_PER_QUESTION);

  // token 闸门在发请求前拦（不消耗配额地拒绝）
  await assertTokenQuota(userId);

  // PATH A：openai 兼容 /responses（非流式，线上为千问）
  if (config.provider === 'openai' && config.openai_api_key) {
    const modelName = config.openai_model || 'deepseek-chat';
    // ADR-0024：出站守卫，与 chat 共用解析函数，避免两处校验漂移
    const endpoint = resolveOpenAiEndpoint(config, '/responses');
    // 本路径已记账的标志：外层 catch 只在**未记账**时补记，
    // 否则「已记 success 后又抛错」会与下面的 error 记录重复成两条
    let logged = false;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai_api_key}` },
        body: JSON.stringify({
          model: modelName,
          instructions: QUIZ_SYSTEM_PROMPT,
          input: [{ role: 'user', content: userContent }],
          stream: false,
          enable_thinking: false,
          temperature: 0.8,
          max_output_tokens: maxOutputTokens,
          store: false,
          // 结构化约束：优先 json_schema，不支持时降级 json_object
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'quiz_questions', schema: buildQuizJsonSchema(input.count) },
          },
        }),
      });
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200);
        const err = new Error(`HTTP ${res.status}: ${errText}`);
        await recordQuizCall({ userId, provider: 'openai', modelName, start, totalTokens: 0, ok: false, errorMessage: String(err.message) });
        logged = true;
        return failedResult('openai', modelName, start, err, 1);
      }
      const json: any = await res.json();
      const totalTokens = typeof json?.usage?.total_tokens === 'number' ? json.usage.total_tokens : 0;
      // 截断判定：MAX_TOKENS 直接判失败，**不修复**（修复只会得到残缺批次）
      if (isTruncated(json)) {
        const err = new Error('输出被 max_output_tokens 截断，请减少题量或重试');
        await recordQuizCall({ userId, provider: 'openai', modelName, start, totalTokens, ok: false, errorMessage: String(err.message) });
        logged = true;
        return failedResult('openai', modelName, start, err, 1, totalTokens);
      }
      const text = extractResponseText(json);

      // ⚠️ 解析在记账**之内**：失败要落 status=error（见 recordQuizCall 的注释）
      let quiz: GeneratedQuiz;
      try {
        quiz = parseAndValidate(text, input.count);
      } catch (e) {
        const diag = `${String((e as Error)?.message || e)} | ${describeShape(text)}`;
        await recordQuizCall({ userId, provider: 'openai', modelName, start, totalTokens, ok: false, errorMessage: diag });
        logged = true;
        return failedResult('openai', modelName, start, new Error(diag), 1, totalTokens);
      }

      await recordQuizCall({ userId, provider: 'openai', modelName, start, totalTokens, ok: true });
      logged = true;
      return {
        questions: toRecords(quiz),
        meta: {
          ok: true,
          modelName,
          provider: 'openai',
          totalTokens,
          latencyMs: Date.now() - start,
          review: {
            subject: quiz.pedagogical_analysis.subject,
            difficultyFit: quiz.pedagogical_analysis.difficulty_fit,
            misconceptionDesign: quiz.pedagogical_analysis.misconception_design,
            attempts: 1,
          },
        },
      };
    } catch (e) {
      // 未记账才补记：网络异常/出站守卫拒绝等在上面的分支之外抛出，
      // 若不补记则这次出题在运营台**完全没有痕迹**（比记成 success 更糟）
      if (!logged) {
        await recordQuizCall({ userId, provider: 'openai', modelName, start, totalTokens: 0, ok: false, errorMessage: String((e as Error)?.message || e) });
      }
      return failedResult('openai', modelName, start, e, 1);
    }
  }

  // PATH B：gemini 非流式
  const modelName = config.gemini_model || 'gemini-3.8-flash';
  let geminiLogged = false;
  try {
    const ai = getGenAI();
    const resp = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config: {
        systemInstruction: { parts: [{ text: QUIZ_SYSTEM_PROMPT }] },
        temperature: 0.8,
        maxOutputTokens: maxOutputTokens,
        // ⚠️ 出题不挂 web_search：只出稳定的通识/学科知识，
        // 同时规避「引用 URL 混入题目 JSON」的解析失败模式（与 title.service 同口径）
        responseMimeType: 'application/json',
        responseJsonSchema: buildQuizJsonSchema(input.count) as any,
      } as any,
    });
    const totalTokens = (resp as any)?.usageMetadata?.totalTokenCount || 0;

    // ⚠️ 解析在记账**之内**：失败要落 status=error（见 recordQuizCall 的注释）
    let quiz: GeneratedQuiz;
    try {
      quiz = parseAndValidate(resp.text || '', input.count);
    } catch (e) {
      const diag = `${String((e as Error)?.message || e)} | ${describeShape(resp.text || '')}`;
      await recordQuizCall({ userId, provider: 'gemini', modelName, start, totalTokens, ok: false, errorMessage: diag });
      geminiLogged = true;
      return failedResult('gemini', modelName, start, new Error(diag), 1, totalTokens);
    }

    await recordQuizCall({ userId, provider: 'gemini', modelName, start, totalTokens, ok: true });
    geminiLogged = true;
    return {
      questions: toRecords(quiz),
      meta: {
        ok: true,
        modelName,
        provider: 'gemini',
        totalTokens,
        latencyMs: Date.now() - start,
        review: {
          subject: quiz.pedagogical_analysis.subject,
          difficultyFit: quiz.pedagogical_analysis.difficulty_fit,
          misconceptionDesign: quiz.pedagogical_analysis.misconception_design,
          attempts: 1,
        },
      },
    };
  } catch (e) {
    // 同PATH A：SDK 抛错（凭据缺失/网络）时补记，否则运营台无痕迹
    if (!geminiLogged) {
      await recordQuizCall({ userId, provider: 'gemini', modelName, start, totalTokens: 0, ok: false, errorMessage: String((e as Error)?.message || e) });
    }
    return failedResult('gemini', modelName, start, e, 1);
  }
}

/** 非流式 /responses 输出取文本（照 title.service 的双路径回退） */
function extractResponseText(json: any): string {
  if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text;
  let text = '';
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
        }
      }
    }
  }
  if (text.trim()) return text;
  if (typeof json?.choices?.[0]?.message?.content === 'string') return json.choices[0].message.content;
  if (typeof json?.content === 'string') return json.content;
  return '';
}
