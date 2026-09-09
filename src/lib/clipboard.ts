/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 剪贴板工具：navigator.clipboard 优先，非安全上下文兜底 textarea + execCommand。
 * 从 ShareLinkModal 抽出复用（ShareLinkModal / MySharesModal）。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {}
  return false;
}
