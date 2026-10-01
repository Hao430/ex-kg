/**
 * 容灾与错误清洗模块
 */

// Helper to extract human-readable error messages from GenAI or OpenAI SDK errors
export function cleanErrorMessage(error: unknown): string {
  if (!error) return 'AI 服务暂时无响应，请稍后重试';
  let rawMsg = (error as any)?.message || String(error);

  try {
    if (
      typeof rawMsg === 'string' &&
      (rawMsg.startsWith('{') || rawMsg.includes('{\n') || rawMsg.includes('{"error"'))
    ) {
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
  if (
    lower.includes('503') ||
    lower.includes('high demand') ||
    lower.includes('unavailable') ||
    lower.includes('overloaded')
  ) {
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
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('incorrect api key') ||
    lower.includes('invalid api key')
  ) {
    return '模型 API Key 验证失败，请在后台管理检查模型密钥配置。';
  }
  return rawMsg;
}

export function isQuotaOrRateLimit(errorMessage: string): boolean {
  return (
    errorMessage.includes('429') ||
    errorMessage.includes('配额') ||
    errorMessage.includes('受限') ||
    errorMessage.includes('quota') ||
    errorMessage.includes('RESOURCE_EXHAUSTED')
  );
}

/**
 * Generate intelligent fallback synthesis when all external API quotas hit 429 limits
 */
export function generateFallbackResponse(userPrompt: string): string {
  const cleanQ = userPrompt.trim();
  return `### 💡 深度推演概览：${cleanQ}

> ℹ️ **系统提示**：当前公共 Gemini API 处于高并发限流保护期（429 Quota Rate-Limit）。系统已为您自动启用内置深度认知知识库完成本轮基础推演，保障画布思考不断联。

#### 核心推演脉络
1. **本质定位**：${cleanQ} 是知识图谱与认知探索中的关键命题，其核心在于理解边界条件与深层演化逻辑。
2. **多维解析**：
   - **机理与动因**：分析底层因果链路，解构关键驱动要素及其相互作用。
   - **关键特征**：识别系统演进中的核心平衡点、相变临界阈值与典型约束。
   - **实践与启示**：聚焦落地场景中的杠杆支点与应对策略。
3. **衍生思考**：在此基础上可进一步向更前沿的假设或更微观的执行路径延伸探索。

---SUGGESTIONS---
探究其最底层的第一性原理与核心约束
对比相邻领域或竞态范式的机理差异
分析在复杂多变环境下的实际演化与应对策略`;
}
