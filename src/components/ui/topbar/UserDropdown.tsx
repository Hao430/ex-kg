/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import {
  ChevronDown,
  User,
  Share2,
  Crown,
  MessageSquarePlus,
  ShieldAlert,
  LogOut,
  LogIn,
} from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { useModal } from '../../../context/ModalContext';
import { useClickOutside } from '../../../hooks/useClickOutside';
import { Tooltip } from '../Tooltip';

export interface UserDropdownProps {
  onGoToLanding?: () => void;
  onOpenIntroduce?: () => void;
}

export const UserDropdown: React.FC<UserDropdownProps> = ({
  onGoToLanding,
  onOpenIntroduce,
}) => {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const { user, isVip, logout } = useAuth();
  const {
    openAuthModal,
    openRechargeModal,
    openUserProfileModal,
    openMySharesModal,
    openFeedbackModal,
    openAdminModal,
  } = useModal();

  const handleIntroduce = onGoToLanding ?? onOpenIntroduce;

  // 点击外部与 Escape 监听
  useClickOutside({
    refs: [userMenuRef],
    enabled: showUserMenu,
    onOutside: () => setShowUserMenu(false),
    closeOnEscape: true,
  });

  if (!user) {
    return (
      <div className="flex items-center gap-1.5">
        {handleIntroduce && (
          <button
            onClick={handleIntroduce}
            className="hidden xl:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <span>介绍</span>
          </button>
        )}
        <button
          onClick={() => openAuthModal('signin')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-medium shadow-xs transition-colors cursor-pointer"
        >
          <LogIn className="w-3.5 h-3.5" />
          <span>登录 / 注册</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={userMenuRef} className="relative">
      <Tooltip content={`用户个人中心: ${user.name || user.email}`} side="bottom">
        <button
          id="topbar-user-menu-btn"
          onClick={() => setShowUserMenu(!showUserMenu)}
          className="flex items-center gap-2 p-1 sm:px-2.5 sm:py-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer text-xs focus:outline-none border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
        >
          {/* 头像 */}
          <div className="w-7 h-7 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center font-bold text-xs shadow-xs overflow-hidden">
            {user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('data:')) ? (
              <img src={user.avatar} alt="avatar" className="w-full h-full object-cover" />
            ) : user.avatar ? (
              <span className="text-sm">{user.avatar}</span>
            ) : (
              <span>{user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}</span>
            )}
          </div>

          <span className="hidden 2xl:inline text-slate-700 dark:text-slate-200 font-semibold max-w-[90px] truncate">
            {user.name || user.email.split('@')[0]}
          </span>

          <span
            className={`hidden 2xl:inline px-1.5 py-0.5 rounded-md text-xxs font-bold uppercase tracking-wider ${
              user.role === 'admin'
                ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                : isVip
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
            }`}
          >
            {user.role === 'admin' ? '管理员' : isVip ? 'VIP' : '普通版'}
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400" />
        </button>
      </Tooltip>

      {/* 用户中心下拉面板 */}
      {showUserMenu && (
        <div
          id="topbar-user-dropdown-menu"
          className="absolute top-full right-0 mt-2 w-60 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] p-2 z-50 animate-in fade-in zoom-in-95"
        >
          {/* 头卡 */}
          <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-xl border border-slate-100 dark:border-slate-800/80 mb-1.5">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center font-bold text-sm shadow-sm overflow-hidden shrink-0">
                {user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('data:')) ? (
                  <img src={user.avatar} alt="avatar" className="w-full h-full object-cover" />
                ) : user.avatar ? (
                  <span className="text-base">{user.avatar}</span>
                ) : (
                  <span>{user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                  {user.name || '深度探索者'}
                </div>
                <div className="text-xxs text-slate-400 truncate">{user.email}</div>
              </div>
            </div>

            <div className="mt-2.5 pt-2 border-t border-slate-200/60 dark:border-slate-800/80 flex items-center justify-between text-xxs">
              <span className="text-slate-500">账户权限：</span>
              {user.role === 'admin' ? (
                <span className="font-semibold text-purple-600 dark:text-purple-400 flex items-center gap-1">
                  系统管理员
                </span>
              ) : isVip ? (
                <span className="font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <Crown className="w-3 h-3 fill-amber-400/30" /> VIP 尊享会员
                </span>
              ) : (
                <span className="font-medium text-slate-500 dark:text-slate-400">基础免费版</span>
              )}
            </div>
          </div>

          <div className="py-1 space-y-0.5">
            {/* 个人中心 */}
            <button
              id="user-menu-profile-btn"
              onClick={() => {
                setShowUserMenu(false);
                openUserProfileModal();
              }}
              className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <User className="w-4 h-4 text-indigo-500 shrink-0" />
              <div>
                <div className="font-medium">个人中心</div>
                <div className="text-xxs text-slate-400">修改头像、昵称与账户信息</div>
              </div>
            </button>

            {/* 我的分享 */}
            <button
              id="user-menu-my-shares-btn"
              onClick={() => {
                setShowUserMenu(false);
                openMySharesModal();
              }}
              className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <Share2 className="w-4 h-4 text-sky-500 shrink-0" />
              <div>
                <div className="font-medium">我的分享</div>
                <div className="text-xxs text-slate-400">管理生效中的分享链接</div>
              </div>
            </button>

            {/* VIP 会员权益 */}
            <button
              id="user-menu-vip-btn"
              onClick={() => {
                setShowUserMenu(false);
                openRechargeModal();
              }}
              className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <Crown className="w-4 h-4 text-amber-500 shrink-0" />
              <div>
                <div className="font-medium">{isVip ? 'VIP 会员权益' : '开通 VIP 会员'}</div>
                <div className="text-xxs text-slate-400">
                  {isVip ? '查看特权与续费周期' : '尊享无限画板与深度推演'}
                </div>
              </div>
            </button>

            {/* 提交反馈 */}
            <button
              id="user-menu-feedback-btn"
              onClick={() => {
                setShowUserMenu(false);
                openFeedbackModal();
              }}
              className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <MessageSquarePlus className="w-4 h-4 text-emerald-500 shrink-0" />
              <div>
                <div className="font-medium">提交反馈</div>
                <div className="text-xxs text-slate-400">提出功能建议或问题报错</div>
              </div>
            </button>

            {/* 管理员后台入口 */}
            {user.role === 'admin' && (
              <button
                id="user-menu-admin-btn"
                onClick={() => {
                  setShowUserMenu(false);
                  openAdminModal();
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 rounded-xl transition-colors cursor-pointer"
              >
                <ShieldAlert className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                <div>
                  <div className="font-medium">运营管理台</div>
                  <div className="text-xxs text-purple-500/70">模型配置与用户权限</div>
                </div>
              </button>
            )}

            <div className="border-t border-slate-100 dark:border-slate-800 my-1" />

            {/* 安全登出 */}
            <button
              id="user-menu-logout-btn"
              onClick={() => {
                setShowUserMenu(false);
                logout();
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition-colors cursor-pointer font-medium"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>安全退出登录</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
