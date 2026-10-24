/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 日期格式化（纯函数，无 React 依赖）。
 * 收敛各处手写的 toLocaleDateString('zh-CN') 与 NaN 守卫。
 */

export function formatDate(
  input: string | number | Date,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', opts);
}
