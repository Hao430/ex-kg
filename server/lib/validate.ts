import type { ZodType } from 'zod';
import { ValidationError } from './errors.js';

/**
 * 解析并校验请求体；失败抛 ValidationError（message 与原 safeParse 模式一致）。
 * 可通过 code 参数保留各端点原有的错误码。成功返回 parse 后的强类型数据。
 */
export function validate<T>(schema: ZodType<T>, body: unknown, code = 'VALIDATION_ERROR'): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message || '请求参数格式错误', code);
  }
  return result.data;
}
