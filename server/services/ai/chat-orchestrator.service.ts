import type { Response } from 'express';
import { AppError } from '../../lib/errors.js';
import {
  getAiModelConfig,
  isModelConfigured,
  recordAiRequestLog,
  sumUserTokensSince,
} from '../ai.service.js';
import { recordEventLog } from '../../repositories/event-log.repository.js';
import type { UserRecord } from '../../core/records.js';
import type { ChatMessage, AIProvider } from './ai-provider.interface.js';
import { OpenAiProvider } from './openai-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import {
  cleanErrorMessage,
  generateFallbackResponse,
  isQuotaOrRateLimit,
} from './fallback-handler.js';

export async function sseWrite(res: Response, payload: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  const ok = res.write(payload);
  if (!ok) {
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        res.off('drain', onDrain);
        res.off('close', onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      res.once('drain', onDrain);
      res.once('close', onClose);
    });
  }
}

export interface StreamChatParams {
  user: UserRecord;
  messages: ChatMessage[];
  model?: string;
  systemInstruction?: string;
  canvasId?: string | null;
  nodeId?: string | null;
  res: Response;
}

export class ChatOrchestrator {
  private openaiProvider = new OpenAiProvider();
  private geminiProvider = new GeminiProvider();

  async streamChat(params: StreamChatParams): Promise<void> {
    const { user, messages, model, systemInstruction, canvasId, nodeId, res } = params;
    const startTime = Date.now();

    let obsProvider = '';
    let ttftMs = 0;
    let aborted = false;
    let fallbackUsed = false;
    let resetCount = 0;
    let candidateFailures = 0;
    let actualModelName = (typeof model === 'string' && model.trim()) || '';
    let aiLogWritten = false;

    const writeAiLog = async (data: Parameters<typeof recordAiRequestLog>[0]) => {
      if (aiLogWritten) return;
      aiLogWritten = true;
      try {
        await recordAiRequestLog(data);
      } catch {
        /* 埋点失败不阻塞 */
      }
    };

    res.on('error', () => {
      aborted = true;
    });

    res.on('close', () => {
      if (res.writableEnded) return;
      aborted = true;
      void writeAiLog({
        userId: user.id,
        canvasId: canvasId || null,
        nodeId: nodeId || null,
        modelName: actualModelName,
        totalTokens: 0,
        latencyMs: Date.now() - startTime,
        status: 'error',
        errorMessage: '客户端中断连接（SSE 未完成即断开）',
        provider: obsProvider,
        ttftMs,
        aborted: true,
        resetCount,
        candidateFailures,
        fallbackUsed,
      });
      void recordEventLog({
        category: 'chat',
        event: 'chat_client_abort',
        entityType: 'canvas',
        entityId: canvasId || null,
        userId: user.id,
        details: { nodeId: nodeId || null, ttftMs, resetCount, candidateFailures },
      });
    });

    try {
      const systemModelConfig = await getAiModelConfig();

      if (!(await isModelConfigured())) {
        throw new AppError(
          400,
          'MODEL_NOT_CONFIGURED',
          'AI 模型尚未配置，请管理员在管理后台「模型配置」中选择模型并保存后再试'
        );
      }

      const dailyTokenQuota = parseInt(process.env.AI_DAILY_TOKEN_QUOTA || '2000000', 10);
      if (dailyTokenQuota > 0) {
        const now = new Date();
        const dayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const usedTokens = await sumUserTokensSince(user.id, dayStartUtc);
        if (usedTokens >= dailyTokenQuota) {
          throw new AppError(
            429,
            'DAILY_TOKEN_QUOTA_EXCEEDED',
            '今日 AI 用量已达上限，请明日再试或联系管理员调整'
          );
        }
      }

      // Ensure messages sent to provider are properly formed (start with user, strictly alternate roles)
      const sanitizedMessages: ChatMessage[] = [];
      for (const msg of messages) {
        if (!msg.content || typeof msg.content !== 'string' || !msg.content.trim()) continue;
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        if (sanitizedMessages.length === 0) {
          if (role === 'user') {
            sanitizedMessages.push({ role, content: msg.content });
          }
          continue;
        }
        const prev = sanitizedMessages[sanitizedMessages.length - 1];
        if (prev.role === role) {
          prev.content = `${prev.content}\n\n${msg.content}`;
        } else {
          sanitizedMessages.push({ role, content: msg.content });
        }
      }
      const executionMessages = sanitizedMessages.length > 0 ? sanitizedMessages : messages;

      const baseSystemInstruction =
        systemModelConfig.custom_system_prompt?.trim() ||
        systemInstruction ||
        `你是一位擅长苏格拉底式启发与深度探索的 AI 导师。
【核心回复规则】
1. **严格字数控制（硬约束）**：正文（含公式与要点）必须控制在 350～450 字，超过 450 字视为失败。禁止空洞开场白、复述问题与结尾客套总结。
2. **要点式排版，杜绝滚动**：结论先行——第 1 句话直接给出核心答案；随后用 3～5 个要点展开，每个要点 1～2 行、关键术语加粗。禁止 3 行以上的大段落，节点卡片内不应出现滚动条。
3. **循序渐进的层次结构**：按「是什么 → 为什么（机理）→ 怎么用（应用与边界）」组织要点，每一层只讲该层最关键的一步，刻意留出可追问的钩子——细节留给下一层深入，不要试图一次讲完。
4. **公式规范**：涉及公式用标准 LaTeX（行内 $...$，独立块级 $$...$$），单个回答中块级公式至多 1 个。
5. **衍生探索标记**：在完成主体解答后，务必在回答的最末尾另起一行输出精确标记：
---SUGGESTIONS---
紧接着输出恰好 3 个后续探索问题：每个独占一行，不超过 30 字，不带序号或额外标记，并按循序渐进排列——第 1 个深化本回答中最关键的那个点；第 2 个打开相邻的机制、前提或对比视角；第 3 个打开跨领域迁移、现实应用或历史/思想脉络的新视角。三个问题禁止互相重复，也不要套用「数学/物理本质」这类固定句式。`;

      const searchInstruction = `\n\n【实时联网检索与权威来源索引规则】
系统已全面启用实时联网搜索与知识推演。请结合权威信息进行精准分析。
正文中凡是引用外部客观事实、统计数据之处，请在句末使用连续的数字方括号角标（例如 [1]、[2]）精确标引来源。
角标编号规则：[n] 中的 n 必须与本次回答「参考来源」列表中来源的编号一一对应，按检索返回的顺序从 [1] 开始连续编号；凡未出现在来源列表中的编号一律不得使用，严禁虚构或跳号。
回答总字数仍须严格遵守 350～450 字的硬约束，结尾必须另起一行保留 ---SUGGESTIONS--- 分隔符与 3 个循序渐进的后续思考问题。`;

      const effectiveSystemInstruction = baseSystemInstruction + searchInstruction;

      let provider: AIProvider;
      if (systemModelConfig.provider === 'openai' && systemModelConfig.openai_api_key) {
        obsProvider = 'openai';
        provider = this.openaiProvider;
      } else {
        obsProvider = 'gemini';
        provider = this.geminiProvider;
      }

      let lastError: unknown = null;
      let streamStarted = false;

      try {
        const executionResult = await provider.execute(
          {
            messages: executionMessages,
            effectiveSystemInstruction,
            systemModelConfig,
            requestedModel: model,
            userId: user.id,
            canvasId,
            nodeId,
            startTime,
            isAborted: () => aborted || res.writableEnded,
          },
          {
            onToken: async (text) => {
              if (!ttftMs) ttftMs = Date.now() - startTime;
              streamStarted = true;
              await sseWrite(res, `data: ${JSON.stringify({ text })}\n\n`);
            },
            onGrounding: async (grounding) => {
              await sseWrite(res, `data: ${JSON.stringify({ grounding })}\n\n`);
            },
            onReset: async () => {
              resetCount++;
              await sseWrite(res, `data: ${JSON.stringify({ reset: true })}\n\n`);
            },
          }
        );

        actualModelName = executionResult.modelUsed;
        ttftMs = executionResult.ttftMs || ttftMs;
        resetCount = executionResult.resetCount || resetCount;
        candidateFailures = executionResult.candidateFailures || candidateFailures;

        await writeAiLog({
          userId: user.id,
          canvasId: canvasId || null,
          nodeId: nodeId || null,
          modelName: executionResult.modelUsed,
          promptTokens: executionResult.promptTokens,
          completionTokens: executionResult.completionTokens,
          totalTokens: executionResult.totalTokens,
          latencyMs: Date.now() - startTime,
          status: 'success',
          groundingChunksCount: executionResult.groundingSources.length,
          provider: obsProvider,
          webSearchCalls: executionResult.webSearchCalls,
          rawSourcesCount: executionResult.rawSourcesCount,
          sourcesTruncated: executionResult.sourcesTruncated,
          ttftMs,
          resetCount,
          candidateFailures,
          fallbackUsed,
        });

        await sseWrite(
          res,
          `data: ${JSON.stringify({
            done: true,
            modelUsed: executionResult.modelUsed,
            tokensConsumed: executionResult.totalTokens,
            grounding: {
              sources: executionResult.groundingSources,
              queries: executionResult.groundingQueries,
            },
          })}\n\n`
        );
        res.end();
        return;
      } catch (err: any) {
        lastError = err;
      }

      if (!streamStarted) {
        const lastMsg = cleanErrorMessage(lastError);
        if (isQuotaOrRateLimit(lastMsg)) {
          fallbackUsed = true;
          const userPrompt = messages[messages.length - 1]?.content || '深度思考探索';
          const fallbackText = generateFallbackResponse(userPrompt);

          const chunkSize = 20;
          for (let i = 0; i < fallbackText.length; i += chunkSize) {
            const slice = fallbackText.slice(i, i + chunkSize);
            await sseWrite(res, `data: ${JSON.stringify({ text: slice })}\n\n`);
            await new Promise((r) => setTimeout(r, 25));
          }

          const fallbackTokens = Math.max(100, Math.ceil(fallbackText.length / 2.5));

          await writeAiLog({
            userId: user.id,
            canvasId: canvasId || null,
            nodeId: nodeId || null,
            modelName: 'arborize-knowledge-base',
            promptTokens: 0,
            completionTokens: fallbackTokens,
            totalTokens: fallbackTokens,
            latencyMs: Date.now() - startTime,
            status: 'success',
            groundingChunksCount: 0,
            provider: 'gemini-fallback',
            ttftMs: ttftMs || Date.now() - startTime,
            resetCount,
            candidateFailures,
            fallbackUsed: true,
          });

          void recordEventLog({
            category: 'chat',
            event: 'chat_fallback_response',
            entityType: 'node',
            entityId: nodeId || null,
            userId: user.id,
            details: {
              canvasId: canvasId || null,
              lastError: lastError
                ? String((lastError as any)?.message || lastError).slice(0, 200)
                : null,
            },
          });

          await sseWrite(
            res,
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
      if (error instanceof AppError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      console.error('Chat API Error:', error);
      const friendlyMsg = cleanErrorMessage(error);
      await writeAiLog({
        userId: user?.id || null,
        canvasId: canvasId || null,
        nodeId: nodeId || null,
        modelName: actualModelName,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - startTime,
        status: 'error',
        errorMessage: friendlyMsg,
        groundingChunksCount: 0,
        provider: obsProvider,
        ttftMs,
        aborted,
        resetCount,
        candidateFailures,
        fallbackUsed,
      });
      await sseWrite(
        res,
        `data: ${JSON.stringify({
          error: friendlyMsg,
        })}\n\n`
      );
      res.end();
    }
  }
}

export const chatOrchestrator = new ChatOrchestrator();
