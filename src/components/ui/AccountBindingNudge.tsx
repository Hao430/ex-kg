import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Mail, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { BIND_NUDGE_EVENT, dismissBindNudge, isBindNudgeDismissed } from '../../lib/bind-nudge';

/**
 * ADR-0023：账号绑定相关的轻提示条（顶部居中，可关闭）。
 *
 * 两种内容，**互斥且优先显示前者**：
 * 1. `bindNotice` —— 微信绑定回调带回来的结果（成功/失败）。**失败也绝不弹登录框**：
 *    用户本来就是登录态，弹登录框是错的引导；
 * 2. 「建议绑定邮箱」提醒 —— 只在 `email_placeholder === true`（微信自动建号的账号）
 *    且用户没关过时出现；一旦补绑邮箱，条件自动不成立，提示自行消失。
 *
 * 提醒的去重标记按账号分键（见 `src/lib/bind-nudge.ts`），所以同一浏览器上的
 * 第二个账号仍会看到自己的提醒。
 */
export const AccountBindingNudge: React.FC = () => {
  const { user, bindNotice, clearBindNotice, openUserProfileModal } = useAuth();
  const [nudgeVisible, setNudgeVisible] = useState(false);

  // localStorage 只在客户端读；监听 dismiss 事件以便同页其他入口关闭后同步
  useEffect(() => {
    const refresh = () => setNudgeVisible(Boolean(user?.email_placeholder) && !isBindNudgeDismissed(user?.id));
    refresh();
    window.addEventListener(BIND_NUDGE_EVENT, refresh);
    return () => window.removeEventListener(BIND_NUDGE_EVENT, refresh);
  }, [user?.id, user?.email_placeholder]);

  // 结果提示是瞬时的：成功后不必让用户手动关（失败也自动收，避免长期占用视线）
  useEffect(() => {
    if (!bindNotice) return;
    const t = setTimeout(() => clearBindNotice(), 6000);
    return () => clearTimeout(t);
  }, [bindNotice, clearBindNotice]);

  if (bindNotice) {
    const isSuccess = bindNotice.type === 'success';
    return (
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 max-w-[92vw]">
        <div
          className={`flex items-start gap-2.5 px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl backdrop-blur-md border animate-in fade-in slide-in-from-top-2 duration-200 ${
            isSuccess
              ? 'bg-emerald-50/95 dark:bg-emerald-950/90 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
              : 'bg-rose-50/95 dark:bg-rose-950/90 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
          }`}
        >
          {isSuccess ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          )}
          <span>{bindNotice.text}</span>
          <button
            type="button"
            onClick={clearBindNotice}
            className="ml-1 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (!nudgeVisible) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 max-w-[92vw]">
      <div className="flex items-start gap-2.5 px-4 py-2.5 rounded-xl text-xs text-slate-700 dark:text-slate-200 bg-white/95 dark:bg-slate-900/95 shadow-2xl backdrop-blur-md border border-amber-200 dark:border-amber-900/60 animate-in fade-in slide-in-from-top-2 duration-200">
        <Mail className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
        <span>
          你的账号还没有绑定邮箱。绑定后可用邮箱登录，也能在忘记密码时自助找回。
        </span>
        <button
          type="button"
          onClick={() => {
            openUserProfileModal();
          }}
          className="ml-1 shrink-0 px-2 py-1 rounded-lg text-[11px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
        >
          去绑定
        </button>
        <button
          type="button"
          onClick={() => dismissBindNudge(user?.id)}
          className="shrink-0 px-1.5 py-1 rounded-lg text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
        >
          不再提示
        </button>
      </div>
    </div>
  );
};
