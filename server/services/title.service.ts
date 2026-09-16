/**
 * 自动命名服务（Spec J1）：根据「用户提问 + 回答摘录」一次产出节点标题与画板名。
 * - 独立非流式调用（不联网、无 SUGGESTIONS），与推理链路解耦
 * - 双 provider：openai 兼容 /responses（stream:false）与 gemini generateContent
 * - 非关键路径：任何失败静默返回 null，前端保留现有截断标题
 */
import { GoogleGenAI } from '@google/genai';
import { getAiModelConfig, resolveOpenAiEndpoint } from './ai.service.js';
import type { AiModelConfig } from '../core/records.js';

export interface AutoTitleResult {
  nodeTitle: string | null;
  boardTitle: string | null;
}

export interface AutoTitleMeta {
  ok: boolean;
  modelName: string;
  provider: string;
  totalTokens: number;
  error?: string;
}

const TITLE_SYSTEM = `你是思维画布命名助手。根据「用户提问」与「AI 回答摘录」为本次探索命名，输出严格 JSON（禁止代码块围栏与任何解释）：
{"node":"该回答节点的标题","board":"整个画板的名称"}
要求：两者各不超过 15 个汉字；单行；不加书名号、句号或任何前后缀；board 是比 node 更概括的主题级命名（同一画板的看板列表标识）。`;

/** 单次生成最大输出（标题 JSON 很短，200 足够） */
const TITLE_MAX_TOKENS = 200;

// Lazy GoogleGenAI initialization（与 chat.ts 同款惰性单例模式）
let genaiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!genaiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    genaiClient = new GoogleGenAI({ apiKey });
  }
  return genaiClient;
}

/** 提取模型输出中的 JSON 并解析；容错代码围栏与前后杂质 */
function parseTitles(text: string): AutoTitleResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { nodeTitle: null, boardTitle: null };
  try {
    const cleaned = text
      .slice(start, end + 1)
      .replace(/```(?:json)?/g, '')
      .trim();
    const parsed = JSON.parse(cleaned) as { node?: unknown; board?: unknown };
    return {
      nodeTitle: typeof parsed.node === 'string' ? clampTitle(parsed.node) : null,
      boardTitle: typeof parsed.board === 'string' ? clampTitle(parsed.board) : null,
    };
  } catch {
    return { nodeTitle: null, boardTitle: null };
  }
}

/** 15 字硬上限 + 单行 + 去引号书名号 */
function clampTitle(s: string): string {
  const cleaned = s
    .trim()
    .split('\n')[0]
    .replace(/^[「『"']+/, '')
    .replace(/[」』"']+$/, '')
    .trim();
  return cleaned.slice(0, 15);
}

/** 非流式 /responses 输出取文本：优先顶层 output_text，回退遍历 output[].content[].text */
function extractResponseText(json: any): string {
  if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text;
  let text = '';
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') text += c.text;
        }
      }
    }
  }
  return text;
}

export async function generateAutoTitles(opts: {
  question: string;
  answer: string;
  includeBoard: boolean;
}): Promise<{ result: AutoTitleResult; meta: AutoTitleMeta }> {
  const config: AiModelConfig = await getAiModelConfig();
  const userContent = opts.includeBoard
    ? `【用户提问】${opts.question}\n【回答摘录】${opts.answer}`
    : `【用户提问】${opts.question}\n【回答摘录】${opts.answer}\n（本次无需 board，输出中 board 用空字符串即可）`;

  // PATH A：openai 兼容 /responses（非流式，不挂任何工具）
  if (config.provider === 'openai' && config.openai_api_key) {
    const modelName = config.openai_model || 'qwen-plus';
    // ADR-0024：出站守卫（与 chat 共用 ai.service 的解析函数，避免两处校验漂移）
    const endpoint = resolveOpenAiEndpoint(config, '/responses');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai_api_key}` },
        body: JSON.stringify({
          model: modelName,
          instructions: TITLE_SYSTEM,
          input: [{ role: 'user', content: userContent }],
          stream: false,
          enable_thinking: false,
          temperature: 0.3,
          max_output_tokens: TITLE_MAX_TOKENS,
          store: false,
        }),
      });
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200);
        return {
          result: { nodeTitle: null, boardTitle: null },
          meta: { ok: false, modelName, provider: 'openai', totalTokens: 0, error: `HTTP ${res.status}: ${errText}` },
        };
      }
      const json = await res.json();
      const titles = parseTitles(extractResponseText(json));
      const totalTokens = typeof json?.usage?.total_tokens === 'number' ? json.usage.total_tokens : 0;
      return {
        result: titles,
        meta: { ok: true, modelName, provider: 'openai', totalTokens },
      };
    } catch (e: any) {
      return {
        result: { nodeTitle: null, boardTitle: null },
        meta: {
          ok: false,
          modelName,
          provider: 'openai',
          totalTokens: 0,
          error: String(e?.message || e).slice(0, 200),
        },
      };
    }
  }

  // PATH B：gemini 非流式
  const modelName = config.gemini_model || 'gemini-3.8-flash';
  try {
    const ai = getGenAI();
    const resp = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config: {
        systemInstruction: { parts: [{ text: TITLE_SYSTEM }] },
        temperature: 0.3,
        maxOutputTokens: TITLE_MAX_TOKENS,
      },
    });
    const titles = parseTitles(resp.text || '');
    const totalTokens = (resp as any)?.usageMetadata?.totalTokenCount || 0;
    return { result: titles, meta: { ok: true, modelName, provider: 'gemini', totalTokens } };
  } catch (e: any) {
    return {
      result: { nodeTitle: null, boardTitle: null },
      meta: {
        ok: false,
        modelName,
        provider: 'gemini',
        totalTokens: 0,
        error: String(e?.message || e).slice(0, 200),
      },
    };
  }
}
