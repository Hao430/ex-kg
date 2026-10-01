import { resolveOpenAiEndpoint } from '../ai.service.js';
import { MAX_GROUNDING_QUERIES, MAX_GROUNDING_SOURCES } from './ai-constants.js';
import type {
  AIProvider,
  ChatStreamCallbacks,
  GroundingSource,
  ProviderExecutionOptions,
  ProviderExecutionResult,
} from './ai-provider.interface.js';

export class OpenAiProvider implements AIProvider {
  readonly name = 'openai';

  async execute(
    options: ProviderExecutionOptions,
    callbacks: ChatStreamCallbacks
  ): Promise<ProviderExecutionResult> {
    const {
      messages,
      effectiveSystemInstruction,
      systemModelConfig,
      requestedModel,
      startTime,
    } = options;

    const actualModelUsed = systemModelConfig.openai_model || requestedModel || 'deepseek-chat';
    const apiKey = systemModelConfig.openai_api_key;
    const endpoint = resolveOpenAiEndpoint(systemModelConfig, '/responses');

    const responsesInput = messages.map((m) => ({
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
        ...(systemModelConfig.force_web_search !== false ? { tool_choice: 'required' } : {}),
        stream: true,
        enable_thinking: false,
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
    const accumulatedSources: GroundingSource[] = [];
    const seenUris = new Set<string>();
    const accumulatedQueries: string[] = [];
    const seenQueries = new Set<string>();
    let usageTokens: { input?: number; output?: number; total?: number } | null = null;
    let ttftMs = 0;
    let webSearchCalls = 0;
    let rawSourcesCount = 0;
    let sourcesTruncated = false;

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

    const collectSources = (sources: unknown) => {
      if (!Array.isArray(sources)) return;
      for (const s of sources) {
        const pick = (...keys: string[]) =>
          keys.map((k) => (s as any)?.[k]).find((v) => typeof v === 'string' && v.trim()) || '';
        const uri = pick('url', 'uri', 'link');
        if (uri && !seenUris.has(uri)) {
          seenUris.add(uri);
          rawSourcesCount++;
          if (accumulatedSources.length >= MAX_GROUNDING_SOURCES) {
            sourcesTruncated = true;
            continue;
          }
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
      if (options.isAborted?.()) {
        break;
      }
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
          continue;
        }

        switch (chunk?.type) {
          case 'response.output_text.delta': {
            const delta = chunk?.delta;
            if (typeof delta === 'string' && delta) {
              if (!ttftMs) ttftMs = Date.now() - startTime;
              accumulatedResponseText += delta;
              await callbacks.onToken(delta);
            }
            break;
          }
          case 'response.output_item.done': {
            if (chunk?.item?.type === 'web_search_call') {
              webSearchCalls++;
              collectQueries(chunk.item.action?.query);
              collectQueries(chunk.item.action?.queries);
              collectSources(chunk.item.action?.sources);
              if (accumulatedSources.length > 0 || accumulatedQueries.length > 0) {
                await callbacks.onGrounding({
                  sources: accumulatedSources,
                  queries: accumulatedQueries,
                });
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
            break;
        }
      }
    }

    if (!accumulatedResponseText && !usageTokens) {
      throw new Error('Responses API 未返回有效输出');
    }

    const promptChars =
      effectiveSystemInstruction.length +
      messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
    const promptTokens = usageTokens?.input ?? Math.ceil(promptChars / 3.5);
    const responseTokens = usageTokens?.output ?? Math.ceil(accumulatedResponseText.length / 2.5);
    const totalTokensCount =
      usageTokens?.total ?? Math.max(100, (promptTokens as number) + (responseTokens as number));

    return {
      provider: 'openai',
      modelUsed: actualModelUsed,
      promptTokens: promptTokens as number,
      completionTokens: responseTokens as number,
      totalTokens: totalTokensCount,
      groundingSources: accumulatedSources,
      groundingQueries: accumulatedQueries,
      rawSourcesCount,
      sourcesTruncated,
      webSearchCalls,
      ttftMs,
      resetCount: 0,
      candidateFailures: 0,
    };
  }
}
