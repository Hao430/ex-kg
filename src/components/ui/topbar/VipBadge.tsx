/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Crown, Sparkles } from 'lucide-react';
import { Tooltip } from '../Tooltip';

export interface VipBadgeProps {
  isVip: boolean;
  /** VIP 用户点击（特权管理）时传给充值弹窗的来源文案 */
  sourceVip: string;
  /** 非 VIP 点击（升级）时传给充值弹窗的来源文案 */
  sourceUpgrade: string;
  onOpen: (source: string) => void;
  className?: string;
}

/** VIP 徽章 / 升级按钮：全应用头部统一的 VIP 入口（画布 / AI 练习共用）。
 *  VIP = 金色渐变胶囊；非 VIP = 实心 amber「升级 VIP」。 */
export const VipBadge: React.FC<VipBadgeProps> = ({
  isVip,
  sourceVip,
  sourceUpgrade,
  onOpen,
  className = '',
}) =>
  isVip ? (
    <Tooltip content="尊享 Pro VIP 会员特权（无限画板与无限推演）" side="bottom">
      <button
        id="topbar-vip-badge-btn"
        onClick={() => onOpen(sourceVip)}
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-xl bg-gradient-to-r from-amber-500/15 via-amber-400/10 to-amber-500/15 hover:from-amber-500/25 hover:to-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-300/80 dark:border-amber-700/80 text-xs font-semibold transition-all cursor-pointer shadow-2xs ${className}`}
      >
        <Crown className="w-3.5 h-3.5 text-amber-500 fill-amber-500/30 shrink-0" />
        <span className="font-bold tracking-tight whitespace-nowrap">VIP</span>
        <span className="text-xxs font-normal opacity-85 hidden 2xl:inline text-amber-600 dark:text-amber-400">
          尊享版
        </span>
        <Sparkles className="hidden 2xl:block w-2.5 h-2.5 text-amber-500 shrink-0 ml-0.5 animate-pulse" />
      </button>
    </Tooltip>
  ) : (
    <Tooltip content="升级至 Pro VIP 会员，解锁无限画板与无限制思考节点" side="bottom">
      <button
        id="topbar-upgrade-vip-btn"
        onClick={() => onOpen(sourceUpgrade)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white text-xs font-semibold transition-all cursor-pointer shadow-xs hover:shadow-md ${className}`}
      >
        <Crown className="w-3.5 h-3.5 text-amber-200 shrink-0" />
        <span className="whitespace-nowrap">升级 VIP</span>
      </button>
    </Tooltip>
  );
