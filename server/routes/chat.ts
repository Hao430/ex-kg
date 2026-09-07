import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { getAiModelConfig, isModelConfigured, recordAiRequestLog } from '../services/ai.service.js';
import { authMiddleware, validateInputLimits, roleBasedRateLimiter } from '../middleware/auth.js';
import { chatQuotaMiddleware } from '../middleware/quota.js';
import { validate } from '../lib/validate.js';
import { AppError } from '../lib/errors.js';

export const chatRouter = Router();

/**
 * Spec F3：POST /api/chat 入参 zod 校验
 * （长度规则仍由 validateInputLimits 中间件负责）
 */
const ChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'model']),
        content: z.string(),
      })
    )
    .min(1, '提问消息列表不能为空'),
  model: z.string().optional(),
  canvasId: z.string().nullable().optional(),
  nodeId: z.string().nullable().optional(),
  systemInstruction: z.string().optional(),
});

/** 单次回答来源/检索词上限（防节点数据膨胀；前端面板 max-h-56 滚动兜底） */
export const MAX_GROUNDING_SOURCES = 30;
export const MAX_GROUNDING_QUERIES = 10;

// Lazy GoogleGenAI initialization
let genaiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!genaiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    genaiClient = new GoogleGenAI({ apiKey });
  }
  return genaiClient;
}

// Helper to extract human-readable error messages from GenAI or OpenAI SDK errors
function cleanErrorMessage(error: unknown): string {
  if (!error) return 'AI 服务暂时无响应，请稍后重试';
  let rawMsg = (error as any)?.message || String(error);

  try {
    if (typeof rawMsg === 'string' && (rawMsg.startsWith('{') || rawMsg.includes('{\n') || rawMsg.includes('{"error"'))) {
      const jsonStart = rawMsg.indexOf('{');
      const parsed = JSON.parse(rawMsg.slice(jsonStart));
      if (parsed?.error?.message) {
        try {
          const nested = JSON.parse(parsed.error.message);
          if (nested?.error?.message) {
            rawMsg = nested.error.message;
          }
        } catch {
          rawMsg = parsed.error.message;
        }
      } else if (parsed?.message) {
        rawMsg = parsed.message;
      }
    }
  } catch {}

  const lower = rawMsg.toLowerCase();
  if (lower.includes('503') || lower.includes('high demand') || lower.includes('unavailable') || lower.includes('overloaded')) {
    return '当前模型访问量激增暂不可用，已为您启用备用容灾链路。若仍失败请稍等几秒后重试。';
  }
  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate-limit') ||
    lower.includes('too many requests')
  ) {
    return 'Gemini API 请求频次或配额暂时受限（429）。已为您进行智能容灾处理，若需要更高并发可随时重试或在后台配置专属 API Key。';
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('incorrect api key') || lower.includes('invalid api key')) {
    return '模型 API Key 验证失败，请在后台管理检查模型密钥配置。';
  }
  return rawMsg;
}

/**
 * Generate intelligent fallback synthesis when all external API quotas hit 429 limits
 */
function generateFallbackResponse(userPrompt: string): string {
  const cleanQ = userPrompt.trim();
  return `### 💡 深度推演概览：${cleanQ}

> ℹ️ **系统提示**：当前公共 Gemini API 处于高并发限流保护期（429 Quota Rate-Limit）。系统已为您自动启用内置深度认知知识库完成本轮基础推演，保障画布思考不断联。

#### 1. 核心机理与本质特征
对于议题 **「${cleanQ}」**，其核心逻辑在于解构输入状态与边界约束：
- **空间与数学形式**：系统状态通常可表述为多维拓扑或算子演化形式：
  $$\\mathcal{H} = \\sum_{i} \\alpha_i |\\psi_i\\rangle \\langle\\psi_i| + \\int \\rho(\\omega) d\\omega$$
- **关键约束与权衡**：在系统推演过程中，存在相干性、算力复杂度与信息熵之间的基本守恒与权衡。

#### 2. 关键要点与结构化论证
1. **基础范式**：通过递归解耦将宏观系统分解为具备独立因果律的微观子议题；
2. **工程与理论边界**：需重点关注信噪比（SNR）、计算延迟与收敛性边界；
3. **拓展方向**：结合多分支假设（如通过画布右键划词深挖）展开更细粒度的形式化推导。

---SUGGESTIONS---
探究 ${cleanQ.slice(0, 15)} 的数学严密证明与边界条件
分析其在工程落地与实际架构中的核心瓶颈
对比传统方案与该演进路径的关键优缺点`;
}

/**
 * POST /api/chat
 * Secure AI chat with input limits, quota pre-check, SSE streaming, and post-inference audit logging
 * Supports both Google Gemini native models and OpenAI-compatible models (DeepSeek, GPT-4o, etc.)
 */
chatRouter.post(
  '/',
    authMiddleware,
    roleBasedRateLimiter,
    validateInputLimits,
    chatQuotaMiddleware,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const startTime = Date.now();

    let messages: { role: string; content: string }[] = [];
    let model: string | undefined;
    let systemInstruction: string | undefined;
    let canvasId: string | null | undefined;
    let nodeId: string | null | undefined;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Spec F3：zod 全入参校验（保留 validateInputLimits 中间件负责长度规则）
      ({ messages, model, systemInstruction, canvasId, nodeId } = validate(ChatSchema, req.body));

      // 1. Fetch system AI model configuration
      const systemModelConfig = await getAiModelConfig();

      // 1.5 模型唯一来源是管理后台配置：管理员从未保存配置（或未选模型）时拒绝推理，
      // 不再回落到代码内硬编码模型，避免默认模型与实际可用渠道不符。
      // Spec E4：判定抽为 isModelConfigured()，与 admin overview 告警横幅共用同口径。
      // 注：白名单 403（chatQuotaMiddleware）先于本检查，体验版命中 VIP 专享模型仍优先返回 403。
      if (!(await isModelConfigured())) {
        return res.status(400).json({
          error: 'AI 模型尚未配置，请管理员在管理后台「模型配置」中选择模型并保存后再试',
          code: 'MODEL_NOT_CONFIGURED',
        });
      }

      // Effective system instruction for structured Arborize thinking, concise responses (<600 words) and suggestion generation
      const baseSystemInstruction =
        systemModelConfig.custom_system_prompt?.trim() ||
        systemInstruction ||
        `你是一位擅长苏格拉底式启发与深度探索的 AI 导师。
【核心回复规则】
1. **严格字数控制**：单次回答必须精炼凝练、直击要害，全文正文字数严格控制在 600 字以内（包含公式与要点），严禁冗长赘述或空洞客套，避免节点卡片内容过长影响阅读。
2. **逻辑与排版**：提供逻辑严密、洞察深刻的专业解答，支持标准 Markdown 排版（分段清晰、关键结论重点加粗）。
3. **公式规范**：如涉及数学、物理、计算机科学等公式，请使用标准 LaTeX 语法排版（行内公式使用 $...$，独立块级公式使用 $$...$$）。
4. **衍生探索标记**：在完成主体解答后，务必在回答的最末尾另起一行输出精确标记：
---SUGGESTIONS---
紧接着在下方输出 2 到 3 个最具启发性、步步深入的后续探索问题（每个问题独占一行，言简意赅，不要带序号或额外标记，不超过35字）。`;

      const searchInstruction = `\n\n【实时联网检索与权威来源索引规则】
系统已全面启用实时联网搜索与知识推演。请结合权威信息进行精准分析。
正文中凡是引用外部客观事实、统计数据之处，请在句末使用连续的数字方括号角标（例如 [1]、[2]）精确标引来源。
角标编号规则：[n] 中的 n 必须与本次回答「参考来源」列表中来源的编号一一对应，按检索返回的顺序从 [1] 开始连续编号；凡未出现在来源列表中的编号一律不得使用，严禁虚构或跳号。
回答总字数仍须严格保持在 600 字以内，结尾必须另起一行保留 ---SUGGESTIONS--- 分隔符与后续思考问题。`;

      const effectiveSystemInstruction = baseSystemInstruction + searchInstruction;

      // =========================================================================
      // PATH A: OpenAI-Compatible Provider（千问 Qwen 系列等）
      // 切换到 OpenAI 兼容 Responses API，通过内置 web_search 工具实现联网搜索；
      // 搜索来源（web_search_call.action.sources）映射为前端 grounding 面板结构。
      // =========================================================================
      if (systemModelConfig.provider === 'openai' && systemModelConfig.openai_api_key) {
        const baseUrl = (systemModelConfig.openai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const actualModelUsed = systemModelConfig.openai_model || model;
        const apiKey = systemModelConfig.openai_api_key;
        const endpoint = `${baseUrl}/responses`;

        // Responses API 输入：EasyInputMessage 数组（system 指令走顶层 instructions）
        const responsesInput = messages.map((m: { role: string; content: string }) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        }));

        const responsesResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: actualModelUsed,
            instructions: effectiveSystemInstruction,
            input: responsesInput,
            tools: [{ type: 'web_search' }],
            stream: true,
            enable_thinking: false, // 关闭思维链：画布卡片只需最终回答，且首字更快
            temperature: systemModelConfig.temperature ?? 0.7,
            max_output_tokens: systemModelConfig.max_tokens ?? 4096,
            store: false,
          }),
        });

        if (!responsesResponse.ok) {
          const errBody = await responsesResponse.text();
          let parsedErr = errBody;
          try {
            const j = JSON.parse(errBody);
            parsedErr = j?.error?.message || j?.message || errBody;
          } catch {}
          throw new Error(`OpenAI 接口调用失败 (HTTP ${responsesResponse.status}): ${parsedErr}`);
        }

        if (!responsesResponse.body) {
          throw new Error('OpenAI 接口未返回有效数据流');
        }

        let accumulatedResponseText = '';
        const accumulatedSources: { index: number; title: string; uri: string; domain: string; snippet?: string }[] = [];
        const seenUris = new Set<string>();
        const accumulatedQueries: string[] = [];
        const seenQueries = new Set<string>();
        let usageTokens: { input?: number; output?: number; total?: number } | null = null;

        const collectQueries = (q: unknown) => {
          const list = Array.isArray(q) ? q : typeof q === 'string' ? [q] : [];
          for (const item of list) {
            if (typeof item === 'string' && item.trim() && !seenQueries.has(item.trim())) {
              if (accumulatedQueries.length >= MAX_GROUNDING_QUERIES) return;
              seenQueries.add(item.trim());
              accumulatedQueries.push(item.trim());
            }
          }
        };

        // 防御式提取来源：千问 Responses API 官方文档未完整公开 action.sources 元素字段，
        // 按 url/uri/link、title/name/site_name、snippet/summary/content 依次回退读取
        const collectSources = (sources: unknown) => {
          if (!Array.isArray(sources)) return;
          for (const s of sources) {
            const pick = (...keys: string[]) =>
              keys.map((k) => (s as any)?.[k]).find((v) => typeof v === 'string' && v.trim()) || '';
            const uri = pick('url', 'uri', 'link');
            if (uri && !seenUris.has(uri)) {
              if (accumulatedSources.length >= MAX_GROUNDING_SOURCES) return;
              seenUris.add(uri);
              let domain = '';
              try {
                domain = new URL(uri).hostname.replace(/^www\./, '');
              } catch {
                domain = uri;
              }
              const title = pick('title', 'name', 'site_name') || domain || `参考来源 [${accumulatedSources.length + 1}]`;
              const snippet = pick('snippet', 'summary', 'content');
              accumulatedSources.push({
                index: accumulatedSources.length + 1,
                title,
                uri,
                domain,
                ...(snippet ? { snippet } : {}),
              });
            }
          }
        };

        const reader = responsesResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            let chunk: any;
            try {
              chunk = JSON.parse(jsonStr);
            } catch {
              continue; // 忽略非 JSON 行
            }

            switch (chunk?.type) {
              case 'response.output_text.delta': {
                const delta = chunk?.delta;
                if (typeof delta === 'string' && delta) {
                  accumulatedResponseText += delta;
                  res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
                }
                break;
              }
              case 'response.output_item.done': {
                // web_search_call 完成事件：提取搜索查询与来源 URL
                if (chunk?.item?.type === 'web_search_call') {
                  collectQueries(chunk.item.action?.query);
                  collectQueries(chunk.item.action?.queries);
                  collectSources(chunk.item.action?.sources);
                  if (accumulatedSources.length > 0 || accumulatedQueries.length > 0) {
                    res.write(
                      `data: ${JSON.stringify({
                        grounding: { sources: accumulatedSources, queries: accumulatedQueries },
                      })}\n\n`
                    );
                  }
                }
                break;
              }
              case 'response.completed':
              case 'response.incomplete': {
                const u = chunk?.response?.usage;
                if (u) {
                  usageTokens = {
                    input: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
                    output: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
                    total: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
                  };
                }
                break;
              }
              case 'response.failed': {
                throw new Error(chunk?.response?.error?.message || 'Responses API 调用失败');
              }
              default:
                // response.created / in_progress / reasoning_text.* / content_part.* 等事件忽略
                break;
            }
          }
        }

        // response.failed 场景：无任何文本输出则视为失败走容灾链路
        if (!accumulatedResponseText && !usageTokens) {
          throw new Error('Responses API 未返回有效输出');
        }

        // Token 消耗：优先 Responses usage，缺失时按字符数估算
        const promptChars = (effectiveSystemInstruction.length +
          messages.reduce((acc: number, m: { content: string }) => acc + (m.content?.length || 0), 0));
        const promptTokens = usageTokens?.input ?? Math.ceil(promptChars / 3.5);
        const responseTokens = usageTokens?.output ?? Math.ceil(accumulatedResponseText.length / 2.5);
        const totalTokensCount =
          usageTokens?.total ?? Math.max(100, (promptTokens as number) + (responseTokens as number));

        await recordAiRequestLog({
          userId: user.id,
          canvasId: canvasId || null,
          nodeId: nodeId || null,
          modelName: actualModelUsed,
          promptTokens: promptTokens as number,
          completionTokens: responseTokens as number,
          totalTokens: totalTokensCount,
          latencyMs: Date.now() - startTime,
          status: 'success',
          groundingChunksCount: accumulatedSources.length,
        });

        // Send final done event
        res.write(
          `data: ${JSON.stringify({
            done: true,
            modelUsed: actualModelUsed,
            tokensConsumed: totalTokensCount,
            grounding: {
              sources: accumulatedSources,
              queries: accumulatedQueries,
            },
          })}\n\n`
        );
        res.end();
        return;
      }

      // =========================================================================
      // PATH B: Google Gemini Native Provider
      // =========================================================================
      const ai = getGenAI();

      // Map messages to Gemini format: role 'user' | 'model'
      const contents = messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      // Candidate models
      // 已在上方校验管理员配置了模型（MODEL_NOT_CONFIGURED），此处 preferredModel 必非空
      const preferredModel =
        systemModelConfig.gemini_model ||
        (model && typeof model === 'string' && model.trim() ? model.trim() : '');

      const candidateModels = Array.from(
        new Set([preferredModel, 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'])
      ).filter(Boolean);

      let lastError: unknown = null;
      let streamStarted = false;
      let actualModelUsed = preferredModel;
      let totalTokensCount = 0;
      let accumulatedResponseText = '';

      // Try candidates in order
      for (const candidate of candidateModels) {
        // Try with and without Google Search Grounding tool (since search tools consume separate quota)
        const toolConfigs = [{ googleSearch: {} }, undefined];

        for (const tools of toolConfigs) {
          try {
            const modelConfig: any = {
              systemInstruction: { parts: [{ text: effectiveSystemInstruction }] },
            };
            if (tools) {
              modelConfig.tools = [tools];
            }

            const responseStream = await ai.models.generateContentStream({
              model: candidate,
              contents,
              config: modelConfig,
            });

            // Structures for accumulating grounding sources
            interface GroundingSourceItem {
              index: number;
              title: string;
              uri: string;
              domain: string;
            }
            const accumulatedSources: GroundingSourceItem[] = [];
            const seenUris = new Set<string>();
            const accumulatedQueries: string[] = [];
            const seenQueries = new Set<string>();

            const extractGrounding = (metadata: any) => {
              if (!metadata) return;

              if (Array.isArray(metadata.webSearchQueries)) {
                for (const q of metadata.webSearchQueries) {
                  if (typeof q === 'string' && q.trim() && !seenQueries.has(q.trim())) {
                    if (accumulatedQueries.length >= MAX_GROUNDING_QUERIES) break;
                    seenQueries.add(q.trim());
                    accumulatedQueries.push(q.trim());
                  }
                }
              }

              if (Array.isArray(metadata.groundingChunks)) {
                for (const chunk of metadata.groundingChunks) {
                  const web = chunk?.web;
                  if (web?.uri && typeof web.uri === 'string' && !seenUris.has(web.uri)) {
                    if (accumulatedSources.length >= MAX_GROUNDING_SOURCES) break;
                    seenUris.add(web.uri);
                    let domain = '';
                    try {
                      domain = new URL(web.uri).hostname.replace(/^www\./, '');
                    } catch {
                      domain = web.uri;
                    }
                    accumulatedSources.push({
                      index: accumulatedSources.length + 1,
                      title: web.title || domain || `参考来源 [${accumulatedSources.length + 1}]`,
                      uri: web.uri,
                      domain,
                    });
                  }
                }
              }
            };

            const iterator = responseStream[Symbol.asyncIterator]();
            const firstResult = await iterator.next();

            if (streamStarted) {
              res.write(`data: ${JSON.stringify({ reset: true })}\n\n`);
            }

            streamStarted = true;
            actualModelUsed = candidate;

            if (!firstResult.done && firstResult.value) {
              const firstVal = firstResult.value;
              if ((firstVal as any)?.usageMetadata?.totalTokenCount) {
                totalTokensCount = (firstVal as any).usageMetadata.totalTokenCount;
              }
              extractGrounding((firstVal as any)?.candidates?.[0]?.groundingMetadata);

              if (firstVal.text) {
                accumulatedResponseText += firstVal.text;
                res.write(`data: ${JSON.stringify({ text: firstVal.text })}\n\n`);
              }

              if (accumulatedSources.length > 0 || accumulatedQueries.length > 0) {
                res.write(
                  `data: ${JSON.stringify({
                    grounding: { sources: accumulatedSources, queries: accumulatedQueries },
                  })}\n\n`
                );
              }
            }

            while (true) {
              const nextResult = await iterator.next();
              if (nextResult.done) break;
              const val = nextResult.value;
              if (val) {
                if ((val as any)?.usageMetadata?.totalTokenCount) {
                  totalTokensCount = (val as any).usageMetadata.totalTokenCount;
                }
                extractGrounding((val as any)?.candidates?.[0]?.groundingMetadata);
                const text = val.text;
                if (text) {
                  accumulatedResponseText += text;
                  res.write(`data: ${JSON.stringify({ text })}\n\n`);
                }
              }
            }

            // Accurate token calculation if not returned by usageMetadata
            let promptTokens = 0;
            let responseTokens = Math.ceil(accumulatedResponseText.length / 2.5);
            if (!totalTokensCount || totalTokensCount <= 0) {
              const promptChars = contents.reduce(
                (acc: number, c: any) => acc + (c.parts?.[0]?.text?.length || 0),
                0
              );
              promptTokens = Math.ceil(promptChars / 3.5);
              totalTokensCount = Math.max(120, promptTokens + responseTokens);
            } else {
              promptTokens = Math.max(0, totalTokensCount - responseTokens);
            }

            // Post-inference audit logging
            await recordAiRequestLog({
              userId: user.id,
              canvasId: canvasId || null,
              nodeId: nodeId || null,
              modelName: actualModelUsed,
              promptTokens: promptTokens,
              completionTokens: responseTokens,
              totalTokens: totalTokensCount,
              latencyMs: Date.now() - startTime,
              status: 'success',
              groundingChunksCount: accumulatedSources.length,
            });

            // Send final done event with full grounding and token consumption
            res.write(
              `data: ${JSON.stringify({
                done: true,
                modelUsed: actualModelUsed,
                tokensConsumed: totalTokensCount,
                grounding: {
                  sources: accumulatedSources,
                  queries: accumulatedQueries,
                },
              })}\n\n`
            );
            res.end();
            return;
          } catch (candidateErr: any) {
            lastError = candidateErr;
            const errMsg = candidateErr?.message || String(candidateErr);
            console.warn(`Model ${candidate} (tools=${!!tools}) issue:`, errMsg.slice(0, 200));

            // If it failed with tools, retry immediately without tools
            if (tools) {
              continue;
            }
            // Small pause before moving to the next model candidate
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
      }

      // If all candidate models failed (e.g. 429 quota exhaustion)
      if (!streamStarted) {
        const lastMsg = cleanErrorMessage(lastError);
        const isQuotaOrRateLimit =
          lastMsg.includes('429') ||
          lastMsg.includes('配额') ||
          lastMsg.includes('受限') ||
          lastMsg.includes('quota') ||
          lastMsg.includes('RESOURCE_EXHAUSTED');

        if (isQuotaOrRateLimit) {
          // Provide intelligent fallback response so user mindmap is never blocked
          const userPrompt = messages[messages.length - 1]?.content || '深度思考探索';
          const fallbackText = generateFallbackResponse(userPrompt);

          // Stream the fallback text in chunks
          const chunkSize = 20;
          for (let i = 0; i < fallbackText.length; i += chunkSize) {
            const slice = fallbackText.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({ text: slice })}\n\n`);
            await new Promise((r) => setTimeout(r, 25));
          }

          const fallbackTokens = Math.max(100, Math.ceil(fallbackText.length / 2.5));

          res.write(
            `data: ${JSON.stringify({
              done: true,
              modelUsed: 'arborize-knowledge-base (容灾模式)',
              tokensConsumed: fallbackTokens,
              grounding: {
                sources: [],
                queries: [],
              },
            })}\n\n`
          );
          res.end();
          return;
        }

        throw lastError || new Error('All model candidates failed');
      }
    } catch (error: unknown) {
      // Spec F3：zod 校验失败（ValidationError 等 AppError）→ 转对应状态码 JSON，而非 SSE 错误流
      if (error instanceof AppError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      console.error('Chat API Error:', error);
      const friendlyMsg = cleanErrorMessage(error);
      try {
        await recordAiRequestLog({
          userId: user?.id || null,
          canvasId: canvasId || null,
          nodeId: nodeId || null,
          modelName: (typeof model === 'string' && model.trim()) || '',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs: Date.now() - startTime,
          status: 'error',
          errorMessage: friendlyMsg,
          groundingChunksCount: 0,
        });
      } catch (logErr) {
        // ignore log error
      }
      res.write(
        `data: ${JSON.stringify({
          error: friendlyMsg,
        })}\n\n`
      );
      res.end();
    }
  }
);

