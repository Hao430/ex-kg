/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * fetch 响应错误提取（纯函数，无 React 依赖）。
 *
 * 后端 errorHandler 统一序列化为 `{error, code}` JSON，个别路径（如 F4 注销
 * 的 /api/auth/account）回 `{message}`。取值顺序：body.error → body.message → fallback。
 *
 * ⚠️ 响应体只能消费一次：调用点若还需从 body 取 code/payUrl 等其他字段，
 * 应自行 `res.json()` 后内联取 error，不要走本函数（二次 json() 必然失败 → 恒回落 fallback）。
 */

export async function extractErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) return error;
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
