import { getAiModelConfig, getSavedAiModelConfig } from '../repositories/ai.repository.js';

export { getAiModelConfig, getSavedAiModelConfig, saveAiModelConfig, recordAiRequestLog, sumUserTokensSince } from '../repositories/ai.repository.js';

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
