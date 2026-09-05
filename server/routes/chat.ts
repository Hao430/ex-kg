import { Router, Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import { deductCredits } from '../db.js';
import { authMiddleware, quotaMiddleware, validateInputLimits, roleBasedRateLimiter } from '../middlewares.js';

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

// Helper to extract human-readable error messages from GenAI SDK errors
function cleanErrorMessage(error: unknown): string {
  if (!error) return 'AI 服务暂时无响应，请稍后重试';
  let rawMsg = (error as any)?.message || String(error);

  try {
    if (typeof rawMsg === 'string' && (rawMsg.startsWith('{') || rawMsg.includes('{\n'))) {
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
      }
    }
  } catch {}

  if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
    return '当前模型访问量激增暂不可用，已尝试备用链路。若仍失败请稍等几秒后重试。';
  }
  if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
    return '请求频次超限，请稍候再试。';
  }
  return rawMsg;
}

/**
 * POST /api/chat
 * Secure AI chat with input limits, quota pre-check, SSE streaming, and post-inference token deduction
 */
chatRouter.post(
  '/',
  authMiddleware,
  roleBasedRateLimiter,
  validateInputLimits,
  quotaMiddleware,
  async (req: Request, res: Response) => {
    const { messages, model, systemInstruction, enableWebSearch, canvasId } = req.body;
    const user = req.user!;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    try {
      const ai = getGenAI();

      // Map messages to Gemini format: role 'user' | 'model'
      const contents = messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      // Candidate models
      const preferredModel =
        model && typeof model === 'string' && model.trim() ? model.trim() : 'gemini-3.8-flash';

      const candidateModels = Array.from(
        new Set([preferredModel, 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'])
      ).filter(Boolean);

      let lastError: unknown = null;
      let streamStarted = false;
      let actualModelUsed = preferredModel;
      let totalTokensCount = 0;
      let accumulatedResponseText = '';

      // Grounding instructions for citations and indexing
      const searchInstruction = enableWebSearch
        ? `\n\n【联网检索与来源索引规则】
当前已启用 Google 实时联网搜索。请利用最新的权威网络信息进行推演。
正文中凡是引用外部客观事实或数据结论之处，请在句末使用连续的数字方括号角标（例如 [1]、[2]）精确标引来源。
请保持纯正 Markdown 排版，回答最末尾必须另起一行保留 ---SUGGESTIONS--- 分隔符与后续思考问题。`
        : '';

      const effectiveSystemInstruction =
        (systemInstruction ||
          `你是一位擅长苏格拉底式启发与深度探索的 AI 导师。
请对用户的问题提供逻辑严密、洞察深刻、排版优雅的专业解答（支持完整 Markdown）。
如涉及数学、物理、计算机科学等公式，请使用标准 LaTeX 语法排版（行内公式使用 $...$，独立块级公式使用 $$...$$）。
在完成主体解答后，务必在回答的最末尾另起一行输出精确标记：
---SUGGESTIONS---
紧接着在下方输出 2 到 3 个最具启发性、步步深入的后续探索问题（每个问题独占一行，言简意赅，不要带序号或额外标记，不超过35字）。`) +
        searchInstruction;

      for (const candidate of candidateModels) {
        try {
          const modelConfig: any = {
            systemInstruction: { parts: [{ text: effectiveSystemInstruction }] },
          };

          if (enableWebSearch) {
            modelConfig.tools = [{ googleSearch: {} }];
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
          if (!totalTokensCount || totalTokensCount <= 0) {
            const promptChars = contents.reduce(
              (acc: number, c: any) => acc + (c.parts?.[0]?.text?.length || 0),
              0
            );
            const promptTokens = Math.ceil(promptChars / 3.5);
            const responseTokens = Math.ceil(accumulatedResponseText.length / 2.5);
            totalTokensCount = Math.max(120, promptTokens + responseTokens);
          }

          // Execute post-inference token deduction and audit logging
          const { newBalance, transactionId } = await deductCredits({
            userId: user.id,
            canvasId: canvasId || null,
            modelName: actualModelUsed,
            tokensConsumed: totalTokensCount,
            actionType: 'ai_chat',
          });

          // Send final done event with full grounding, token consumption and updated balance
          res.write(
            `data: ${JSON.stringify({
              done: true,
              modelUsed: actualModelUsed,
              tokensConsumed: totalTokensCount,
              creditsBalance: newBalance,
              transactionId,
              grounding: {
                sources: accumulatedSources,
                queries: accumulatedQueries,
              },
            })}\n\n`
          );
          res.end();
          return;
        } catch (candidateErr) {
          lastError = candidateErr;
          console.warn(`Model ${candidate} issue, switching fallback:`, candidateErr);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      if (!streamStarted) {
        throw lastError || new Error('All model candidates failed');
      }
    } catch (error: unknown) {
      console.error('Chat API Error:', error);
      const friendlyMsg = cleanErrorMessage(error);
      res.write(
        `data: ${JSON.stringify({
          error: friendlyMsg,
        })}\n\n`
      );
      res.end();
    }
  }
);
