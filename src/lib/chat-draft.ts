/**
 * 未提交的提问草稿（按「节点 id + 输入框种类」存 sessionStorage）。
 *
 * 提问框的输入在提交前只是组件本地 state，切走画板 / 重挂载就没了——用户体感是
 * 「我打的字消失了」。这里把它存进 sessionStorage：同一标签页内切换画板、刷新都还在；
 * 关掉标签页即清（未提交的草稿没必要长期留存，也不该在 localStorage 里越积越多）。
 *
 * 注意：草稿**不是内容**，不进画布节点、不上传。提交成功后立刻清掉，避免下次打开看到
 * 一条早已问过的旧问题，误以为是新输入。
 */
const KEY_PREFIX = 'deepdive_chat_draft_';

export type ChatDraftKind = 'initial' | 'followup';

function keyFor(nodeId: string, kind: ChatDraftKind): string {
  return `${KEY_PREFIX}${kind}_${nodeId}`;
}

export function getChatDraft(nodeId: string, kind: ChatDraftKind): string {
  try {
    return sessionStorage.getItem(keyFor(nodeId, kind)) ?? '';
  } catch {
    return ''; // 隐私模式/存储被禁：草稿拿不回来，但不影响任何已保存内容
  }
}

export function setChatDraft(nodeId: string, kind: ChatDraftKind, text: string): void {
  try {
    if (text) sessionStorage.setItem(keyFor(nodeId, kind), text);
    else sessionStorage.removeItem(keyFor(nodeId, kind));
  } catch {
    /* ignore */
  }
}

export function clearChatDraft(nodeId: string, kind: ChatDraftKind): void {
  try {
    sessionStorage.removeItem(keyFor(nodeId, kind));
  } catch {
    /* ignore */
  }
}
