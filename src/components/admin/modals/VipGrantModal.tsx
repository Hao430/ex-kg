/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Crown } from 'lucide-react';
import { AuthUser } from '../../../types';
import { Modal } from '../../ui/base/Modal';
import { formatDate } from '../../../lib/format';
import { extractErrorMessage } from '../../../lib/api';

export interface VipGrantModalProps {
  targetUser: AuthUser | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError?: (message: string) => void;
}

export const VipGrantModal: React.FC<VipGrantModalProps> = ({
  targetUser,
  onClose,
  onSuccess,
  onError,
}) => {
  const [vipDaysToAdd, setVipDaysToAdd] = useState<number>(30);
  const [submittingVip, setSubmittingVip] = useState(false);

  if (!targetUser) return null;

  const handleGrantVipDays = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingVip(true);
    try {
      const res = await fetch(`/api/admin/users/${targetUser.id}/vip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days: vipDaysToAdd }),
      });
      if (!res.ok) {
        onError?.(await extractErrorMessage(res, 'VIP 授权设置失败'));
        return;
      }
      const d = await res.json();
      onSuccess(d.message);
    } catch (e: any) {
      onError?.(e?.message || '操作失败');
    } finally {
      setSubmittingVip(false);
    }
  };

  return (
    <Modal
      isOpen={!!targetUser}
      onClose={onClose}
      zIndex="z-60"
      size="md"
      ariaLabel="授权 / 调整 VIP 会员天数"
    >
      <div className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
            <Crown className="w-4 h-4" />
          </div>
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            授权 / 调整 VIP 会员天数
          </h4>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          目标用户：<span className="font-mono text-slate-700 dark:text-slate-300 font-medium">{targetUser.email}</span>
          {targetUser.vip_expires_at && (
            <span className="block text-amber-600 dark:text-amber-400 mt-0.5">
              当前 VIP 到期时间：{formatDate(targetUser.vip_expires_at)}
            </span>
          )}
        </p>

        <form onSubmit={handleGrantVipDays} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-600 dark:text-slate-300 mb-1.5 font-medium">
              快捷预设天数（在当前剩余天数上顺延）
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: '+7 天周度', days: 7 },
                { label: '+30 天月度', days: 30 },
                { label: '+90 天季度', days: 90 },
                { label: '+365 天年度', days: 365 },
              ].map((preset) => (
                <button
                  key={preset.days}
                  type="button"
                  onClick={() => setVipDaysToAdd(preset.days)}
                  className={`px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                    vipDaysToAdd === preset.days
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 ring-2 ring-amber-500/20'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-600 dark:text-slate-300 mb-1 font-medium">
              自定义授权天数（输入 0 将立即取消该用户的 VIP 身份）
            </label>
            <div className="relative">
              <input
                type="number"
                min="0"
                value={vipDaysToAdd}
                onChange={(e) => setVipDaysToAdd(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono"
              />
              <span className="absolute right-3 top-2 text-xs text-slate-400">天</span>
            </div>
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
              disabled={submittingVip}
              className="px-4 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium shadow-sm transition-all cursor-pointer disabled:opacity-50"
            >
              {submittingVip ? '授权中…' : '确认授予特权天数'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};
