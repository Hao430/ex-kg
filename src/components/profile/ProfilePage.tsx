/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/profile` 独立路由页（仅自己可见）。
 *
 * StandalonePage 不经 App.tsx 的 Provider 树（main.tsx 直接渲染本组件），
 * 故必须自行包裹 AuthProvider > ModalProvider；只补前者会让共享组件里的
 * useModal 落到默认空函数，弹窗类按钮静默失效。配套渲染三只弹窗让那些动作真正可用。
 *
 * 本页不含任何第二套资料表单/取数：内容全部由 UserProfileContent 单一维护。
 */
import React from 'react';
import { LogIn, Sparkles } from 'lucide-react';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { ModalProvider, useModal } from '../../context/ModalContext';
import { AuthModal } from '../auth/AuthModal';
import { RechargeModal } from '../ui/RechargeModal';
import { MySharesModal } from '../ui/MySharesModal';
import { Spinner } from '../ui/base/Spinner';
import { UserProfileContent } from './UserProfileContent';

const ProfileGate: React.FC = () => {
  const { user, loading } = useAuth();
  const { openAuthModal } = useModal();

  if (loading) {
    return (
      <div
        data-testid="profile-loading"
        className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 dark:bg-[#0b1120] text-slate-500 dark:text-slate-400"
      >
        <Spinner size="lg" />
        <span className="text-xs">正在加载个人中心…</span>
      </div>
    );
  }

  // 未登录只显示提示，绝不渲染任何资料节点、不吐敏感数据。
  if (!user) {
    return (
      <div
        data-testid="profile-login-gate"
        className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0b1120] p-4"
      >
        <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f172a] p-8 text-center shadow-sm">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
            <Sparkles className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-white">请先登录</h1>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            个人中心仅自己可见，登录后即可管理资料、会员配额与账号安全。
          </p>
          <button
            type="button"
            data-testid="profile-login-btn"
            onClick={() => openAuthModal('signin')}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 transition shadow-sm"
          >
            <LogIn className="w-4 h-4" />
            登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="profile-page"
      className="min-h-screen bg-slate-50 dark:bg-[#0b1120] text-slate-900 dark:text-slate-100"
    >
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f172a]">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            枝想 Arborize
          </div>
          <a
            href="/"
            className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            返回首页
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f172a] shadow-sm overflow-hidden flex flex-col">
          <UserProfileContent
            onClose={() => window.location.assign('/')}
            cancelLabel="返回首页"
          />
        </div>
      </main>
    </div>
  );
};

export const ProfilePage: React.FC = () => (
  <AuthProvider>
    <ModalProvider>
      <ProfileGate />
      {/* 让共享组件内的 useModal 动作（登录/升级/我的分享）在本页独立 Provider 树下可用 */}
      <AuthModal />
      <RechargeModal />
      <MySharesModal />
    </ModalProvider>
  </AuthProvider>
);
