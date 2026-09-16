/**
 * ADR-0023：一次性「建议绑定邮箱」提醒的去重标记。
 *
 * 提醒的**触发条件**是 `user.email_placeholder === true`（微信自动建号的账号），
 * 由服务端返回，用户一旦补绑邮箱就自动消失——本模块只负责「用户已经关过一次就别再烦他」。
 *
 * 两个约定照 `checklist.ts` 的先例：
 * - **必须按账号分键**（`scopedKey` + `scopeKeyFor`）：用全局键的话，同一浏览器上
 *   第二个账号永远看不到提醒（第一个账号关掉就等于替所有人关掉了）；
 * - localStorage 不可用（隐私模式）时按「已关闭」处理，**不打扰用户**。
 */

import { scopeKeyFor, scopedKey } from './board-scope';

export const BIND_NUDGE_EVENT = 'arborize:bind-nudge';

function nudgeKey(userId: string | null | undefined): string {
  return scopedKey('bind_email_nudge_dismissed', scopeKeyFor(userId));
}

export function isBindNudgeDismissed(userId: string | null | undefined): boolean {
  try {
    return localStorage.getItem(nudgeKey(userId)) === '1';
  } catch {
    return true;
  }
}

export function dismissBindNudge(userId: string | null | undefined): void {
  try {
    localStorage.setItem(nudgeKey(userId), '1');
  } catch {
    /* 写不进去就只在本次会话内静默（下次打开会再提醒一次） */
  }
  window.dispatchEvent(new CustomEvent(BIND_NUDGE_EVENT));
}
