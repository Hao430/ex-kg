import { GoogleGenAI } from '@google/genai';
import { recordEventLog } from '../../repositories/event-log.repository.js';
import { MAX_GROUNDING_QUERIES, MAX_GROUNDING_SOURCES } from './ai-constants.js';
import type {
  AIProvider,
  ChatStreamCallbacks,
  GroundingSource,
  ProviderExecutionOptions,
  ProviderExecutionResult,
} from './ai-provider.interface.js';

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

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

  async execute(
    options: ProviderExecutionOptions,
    callbacks: ChatStreamCallbacks
  ): Promise<ProviderExecutionResult> {
    const {
      messages,
      effectiveSystemInstruction,
      systemModelConfig,
      requestedModel,
      userId,
      canvasId,
      nodeId,
      startTime,
    } = options;

    const ai = getGenAI();

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const preferredModel =
      systemModelConfig.gemini_model ||
      (requestedModel && typeof requestedModel === 'string' && requestedModel.trim()
        ? requestedModel.trim()
        : '');

    const FALLBACK_MODEL_RE = /^[\w.\-/]{1,64}$/;
    const DEFAULT_GEMINI_FALLBACKS = [
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
    ];
    const configuredFallbacks = (systemModelConfig.gemini_fallback_models || [])
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .filter((m) => FALLBACK_MODEL_RE.test(m));
    const candidateModels = Array.from(
      new Set([
        preferredModel,
        ...(configuredFallbacks.length > 0 ? configuredFallbacks : DEFAULT_GEMINI_FALLBACKS),
      ])
    ).filter(Boolean);

    let lastError: unknown = null;
    let streamStarted = false;
    let actualModelUsed = preferredModel;
    let totalTokensCount = 0;
    let accumulatedResponseText = '';
    let resetCount = 0;
    let candidateFailures = 0;
    let ttftMs = 0;
    let rawSourcesCount = 0;
    let sourcesTruncated = false;

    const accumulatedSources: GroundingSource[] = [];
    const seenUris = new Set<string>();
    const accumulatedQueries: string[] = [];
    const seenQueries = new Set<string>();

    for (const candidate of candidateModels) {
      if (options.isAborted?.()) {
        break;
      }
      const toolConfigs = [{ googleSearch: {} }, undefined];

      for (const tools of toolConfigs) {
        if (options.isAborted?.()) {
          break;
        }
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
                  seenUris.add(web.uri);
                  rawSourcesCount++;
                  if (accumulatedSources.length >= MAX_GROUNDING_SOURCES) {
                    sourcesTruncated = true;
                    continue;
                  }
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
            resetCount++;
            await callbacks.onReset();
            void recordEventLog({
              category: 'chat',
              event: 'chat_stream_reset',
              entityType: 'node',
              entityId: nodeId || null,
              userId,
              num1: resetCount,
              details: { canvasId: canvasId || null },
            });
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
              if (!ttftMs) ttftMs = Date.now() - startTime;
              accumulatedResponseText += firstVal.text;
              await callbacks.onToken(firstVal.text);
            }

            if (accumulatedSources.length > 0 || accumulatedQueries.length > 0) {
              await callbacks.onGrounding({
                sources: accumulatedSources,
                queries: accumulatedQueries,
              });
            }
          }

          while (true) {
            if (options.isAborted?.()) {
              break;
            }
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
                if (!ttftMs) ttftMs = Date.now() - startTime;
                accumulatedResponseText += text;
                await callbacks.onToken(text);
              }
            }
          }

          let promptTokens = 0;
          const responseTokens = Math.ceil(accumulatedResponseText.length / 2.5);
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

          return {
            provider: 'gemini',
            modelUsed: actualModelUsed,
            promptTokens,
            completionTokens: responseTokens,
            totalTokens: totalTokensCount,
            groundingSources: accumulatedSources,
            groundingQueries: accumulatedQueries,
            rawSourcesCount,
            sourcesTruncated,
            webSearchCalls: 0,
            ttftMs,
            resetCount,
            candidateFailures,
          };
        } catch (candidateErr: any) {
          lastError = candidateErr;
          candidateFailures++;
          const errMsg = candidateErr?.message || String(candidateErr);
          console.warn(`Model ${candidate} (tools=${!!tools}) issue:`, errMsg.slice(0, 200));
          void recordEventLog({
            category: 'chat',
            event: 'chat_model_candidate_failed',
            entityType: 'node',
            entityId: nodeId || null,
            userId,
            num1: candidateFailures,
            details: {
              model: candidate,
              tools: !!tools,
              canvasId: canvasId || null,
              error: errMsg.slice(0, 200),
            },
          });

          if (tools) {
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    }

    throw lastError || new Error('All model candidates failed');
  }
}
