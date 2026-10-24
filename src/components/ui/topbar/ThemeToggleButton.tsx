/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { Tooltip } from '../Tooltip';

export interface ThemeToggleButtonProps {
  isDark: boolean;
  onToggle: () => void;
  className?: string;
}

/** 主题切换按钮：图标语义全应用统一——当前深色显示 Moon（点击切浅色）。
 *  窄屏隐藏等响应式策略由调用方通过 className 决定。 */
export const ThemeToggleButton: React.FC<ThemeToggleButtonProps> = ({
  isDark,
  onToggle,
  className = '',
}) => (
  <Tooltip content={isDark ? '切换浅色模式' : '切换沉浸深色模式'} side="bottom">
    <button
      id="topbar-theme-toggle-btn"
      onClick={onToggle}
      className={`p-2 rounded-xl border text-xs font-medium cursor-pointer transition-all ${
        isDark
          ? 'bg-slate-800/90 hover:bg-slate-700 text-amber-300 border-slate-700/80 shadow-inner'
          : 'bg-slate-100 hover:bg-slate-200/80 text-slate-700 border-slate-200/80'
      } ${className}`}
    >
      {isDark ? (
        <Moon className="w-3.5 h-3.5 text-amber-300 fill-amber-300/20" />
      ) : (
        <Sun className="w-3.5 h-3.5 text-amber-500" />
      )}
    </button>
  </Tooltip>
);
