import { getAiModelConfig, getSavedAiModelConfig } from '../repositories/ai.repository.js';
import type { AiModelConfig } from '../core/records.js';
import { assertSafeOutboundUrl } from '../lib/outbound-url.js';

export { getAiModelConfig, getSavedAiModelConfig, saveAiModelConfig, recordAiRequestLog, sumUserTokensSince } from '../repositories/ai.repository.js';

/**
 * 解析 OpenAI 兼容端点（ADR-0024 / 安全审查 H2）。
 *
 * 两个调用点共用——chat 的 `/responses`（流式）与自动标题的 `/responses`（非流式）——
 * 避免各写一份校验而漂移。**使用点也校验一次**：保存时的校验管不到校验上线前
 * 就已写进库的老配置，而这条路径会用平台密钥去请求那个地址。
 *
 * 抛 400 `OUTBOUND_URL_REJECTED`（守卫内部），由统一 errorHandler 序列化。
 */
export function resolveOpenAiEndpoint(config: AiModelConfig, path: string): string {
  const baseUrl = (config.openai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  assertSafeOutboundUrl(baseUrl, { purpose: '推理服务地址' });
  return `${baseUrl}${path}`;
}

/**
 * Spec E4（跟踪清单「模型配置单点依赖」）：模型是否已配置。
 * 与 chat 路由 MODEL_NOT_CONFIGURED 拦截完全同口径：管理员从未保存配置，
 * 或按当前 provider 选中的模型为空 → false（此时全站 AI 推理不可用）。
 * 供 chat 拦截与 admin overview 告警横幅共用，保证判定单一来源。
 */
export async function isModelConfigured(): Promise<boolean> {
  const systemModelConfig = await getAiModelConfig();
  const savedConfig = await getSavedAiModelConfig();
  const usingOpenAI = systemModelConfig.provider === 'openai' && !!systemModelConfig.openai_api_key;
  const configuredModel = usingOpenAI ? savedConfig?.openai_model : savedConfig?.gemini_model;
  return Boolean(configuredModel && String(configuredModel).trim());
}
