/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';

export type BannerTone = 'success' | 'error' | 'info';

const TONE_CLASSES: Record<BannerTone, string> = {
  success: 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 px-3 py-2 rounded-xl text-xs',
  error: 'bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900 px-3 py-2 rounded-xl text-xs',
  info: 'bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900 px-3 py-2 rounded-xl text-xs',
};

const TONE_ICONS: Record<BannerTone, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

export interface StatusBannerProps {
  type?: BannerTone;
  children: React.ReactNode;
  /** 覆盖/补充容器样式（各站点明暗主题差异由此保留） */
  className?: string;
  dismissible?: boolean;
  onDismiss?: () => void;
  /** 跳过内置 tone 皮肤（颜色/内边距/字号），只保留 flex 结构——皮肤完全由 className 提供 */
  unstyled?: boolean;
  /** 自定义图标；传 null 隐藏图标；缺省用 tone 对应图标 */
  icon?: React.ReactNode;
}

/**
 * 统一状态横幅：收敛各处手写的 `{statusMsg && …}` 提示条结构。
 * 默认自带 tone 皮肤；站点自有皮肤用 unstyled + className 保持原样。
 */
export const StatusBanner: React.FC<StatusBannerProps> = ({
  type = 'info',
  children,
  className = '',
  dismissible = false,
  onDismiss,
  unstyled = false,
  icon,
}) => {
  const Icon =
    icon === null
      ? null
      : icon !== undefined
      ? icon
      : React.createElement(TONE_ICONS[type], { className: 'w-3.5 h-3.5 shrink-0 mt-0.5' });

  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 ${unstyled ? '' : `${TONE_CLASSES[type]} leading-relaxed`} ${className}`}
    >
      {Icon}
      <div className="flex-1 min-w-0">{children}</div>
      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          className="shrink-0 p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
