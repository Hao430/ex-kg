/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { AuthUser } from '../../../types';

export interface UserEmailModalProps {
  targetUser: AuthUser | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError?: (message: string) => void;
}

export const UserEmailModal: React.FC<UserEmailModalProps> = ({
  targetUser,
  onClose,
  onSuccess,
  onError,
}) => {
  const [newEmail, setNewEmail] = useState('');
  const [submittingEmail, setSubmittingEmail] = useState(false);

  if (!targetUser) return null;

  const handleUpdateUserEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingEmail(true);
    try {
      const res = await fetch(`/api/admin/users/${targetUser.id}/email`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: newEmail.trim() }),
      });
      const d = await res.json();
      if (res.ok) {
        onSuccess(d.message);
        setNewEmail('');
      } else {
        onError?.(d.error || '修改邮箱失败');
      }
    } catch (e: any) {
      onError?.(e?.message || '网络异常');
    } finally {
      setSubmittingEmail(false);
    }
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-5">
        <div className="flex items-center gap-2 mb-1">
          <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-500">
            <Mail className="w-4 h-4" />
          </div>
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            修改用户登录邮箱
          </h4>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          目标用户：<span className="font-mono text-slate-700 dark:text-slate-300 font-medium">{targetUser.email}</span>
          <span className="block mt-0.5">
            修改后原邮箱立即失效，需向新邮箱重新完成验证后方可使用 AI 推理。
          </span>
        </p>

        <form onSubmit={handleUpdateUserEmail} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-600 dark:text-slate-300 mb-1 font-medium">
              新邮箱地址
            </label>
            <input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="new@example.com"
              className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submittingEmail}
              className="px-4 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium shadow-sm transition-all cursor-pointer disabled:opacity-50"
            >
              {submittingEmail ? '提交中...' : '确认修改邮箱'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
