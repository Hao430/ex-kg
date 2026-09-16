/**
 * HTML 文本转义（安全审查 M3）。
 *
 * **单一定义**：`server/lib/seo.ts`（服务端注入的 head/正文）与 `server/lib/mailer.ts`
 * （邮件 HTML 模板）都从这里取。安全相关的编码函数必须只有一份——两份实现意味着将来
 * 只修一处，而漏掉的那处仍然可注入。
 *
 * 覆盖 `& < > " '` 五个字符：引号必须转义，否则插值落在属性位置（`href="…"`）时
 * 可以被提前闭合。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
