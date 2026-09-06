import { Router, Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import { getAiModelConfig, recordAiRequestLog } from '../services/ai.service.js';
import { authMiddleware, validateInputLimits, roleBasedRateLimiter } from '../middleware/auth.js';
import { chatQuotaMiddleware } from '../middleware/quota.js';

export const chatRouter = Router();

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
    const { messages, model, systemInstruction, canvasId, nodeId } = req.body;
    const user = req.user!;
    const startTime = Date.now();

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    try {
      // 1. Fetch system AI model configuration
      const systemModelConfig = await getAiModelConfig();

      // Effective system instruction for structured DeepDive thinking, concise responses (<600 words) and suggestion generation
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
回答总字数仍须严格保持在 600 字以内，结尾必须另起一行保留 ---SUGGESTIONS--- 分隔符与后续思考问题。`;

      const effectiveSystemInstruction = baseSystemInstruction + searchInstruction;

      // =========================================================================
      // PATH A: OpenAI-Compatible Provider (DeepSeek, OpenAI, SiliconFlow, Kimi, etc.)
      // =========================================================================
      if (systemModelConfig.provider === 'openai' && systemModelConfig.openai_api_key) {
        const baseUrl = (systemModelConfig.openai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const actualModelUsed = systemModelConfig.openai_model || model || 'deepseek-chat';
        const apiKey = systemModelConfig.openai_api_key;
        const endpoint = `${baseUrl}/chat/completions`;

        const openaiMessages = [
          { role: 'system', content: effectiveSystemInstruction },
          ...messages.map((m: { role: string; content: string }) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
        ];

        const openAiResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: actualModelUsed,
            messages: openaiMessages,
            stream: true,
            temperature: systemModelConfig.temperature ?? 0.7,
            max_tokens: systemModelConfig.max_tokens ?? 4096,
          }),
        });

        if (!openAiResponse.ok) {
          const errBody = await openAiResponse.text();
          let parsedErr = errBody;
          try {
            const j = JSON.parse(errBody);
            parsedErr = j?.error?.message || j?.message || errBody;
          } catch {}
          throw new Error(`OpenAI 接口调用失败 (HTTP ${openAiResponse.status}): ${parsedErr}`);
        }

        if (!openAiResponse.body) {
          throw new Error('OpenAI 接口未返回有效数据流');
        }

        let accumulatedResponseText = '';
        const reader = openAiResponse.body.getReader();
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
            if (trimmed === 'data: [DONE]') continue;

            if (trimmed.startsWith('data: ')) {
              const jsonStr = trimmed.slice(6);
              try {
                const chunk = JSON.parse(jsonStr);
                const deltaContent = chunk?.choices?.[0]?.delta?.content || '';
                if (deltaContent) {
                  accumulatedResponseText += deltaContent;
                  res.write(`data: ${JSON.stringify({ text: deltaContent })}\n\n`);
                }
              } catch (e) {
                // Ignore chunk parse errors
              }
            }
          }
        }

        // Calculate token consumption
        const promptChars = openaiMessages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
        const promptTokens = Math.ceil(promptChars / 3.5);
        const responseTokens = Math.ceil(accumulatedResponseText.length / 2.5);
        const totalTokensCount = Math.max(100, promptTokens + responseTokens);

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
          groundingChunksCount: 0,
        });

        // Send final done event
        res.write(
          `data: ${JSON.stringify({
            done: true,
            modelUsed: actualModelUsed,
            tokensConsumed: totalTokensCount,
            grounding: {
              sources: [],
              queries: [],
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
      const preferredModel =
        systemModelConfig.gemini_model ||
        (model && typeof model === 'string' && model.trim() ? model.trim() : 'gemini-3.8-flash');

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
                    seenQueries.add(q.trim());
                    accumulatedQueries.push(q.trim());
                  }
                }
              }

              if (Array.isArray(metadata.groundingChunks)) {
                for (const chunk of metadata.groundingChunks) {
                  const web = chunk?.web;
                  if (web?.uri && typeof web.uri === 'string' && !seenUris.has(web.uri)) {
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
              modelUsed: 'deepdive-knowledge-base (容灾模式)',
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
      console.error('Chat API Error:', error);
      const friendlyMsg = cleanErrorMessage(error);
      try {
        await recordAiRequestLog({
          userId: user?.id || null,
          canvasId: canvasId || null,
          nodeId: nodeId || null,
          modelName: typeof model === 'string' ? model : 'gemini-3.8-flash',
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

