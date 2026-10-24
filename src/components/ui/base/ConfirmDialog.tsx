/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle, Info, TriangleAlert } from 'lucide-react';
import { Modal } from './Modal';
import { Spinner } from './Spinner';

export type ConfirmTone = 'danger' | 'primary' | 'warning';

const TONE_ICON_WRAP: Record<ConfirmTone, string> = {
  danger: 'bg-rose-500/10 text-rose-500 dark:bg-rose-500/20',
  primary: 'bg-indigo-500/10 text-indigo-500 dark:bg-indigo-500/20',
  warning: 'bg-amber-500/10 text-amber-500 dark:bg-amber-500/20',
};

const TONE_CONFIRM_BUTTON: Record<ConfirmTone, string> = {
  danger: 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800',
  primary: 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800',
  warning: 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800',
};

const TONE_DEFAULT_ICON: Record<ConfirmTone, React.ComponentType<{ className?: string }>> = {
  danger: AlertTriangle,
  warning: TriangleAlert,
  primary: Info,
};

export interface ConfirmDialogProps {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 附加内容（渲染在 description 与按钮区之间，如统计框） */
  children?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** 缺省用 tone 对应图标；传 null 可去掉图标 */
  icon?: React.ReactNode;
  /** 置真时确认/取消均不可点（异步确认进行中） */
  loading?: boolean;
  closeOnBackdrop?: boolean; // default: false —— 确认操作不因误触背板而静默取消
  onConfirm: () => void;
  onCancel: () => void;
}

/** 受控确认对话框：复合 base/Modal 原语，保持受控组件特性（不引 context/hooks） */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  children,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'primary',
  icon,
  loading = false,
  closeOnBackdrop = false,
  onConfirm,
  onCancel,
}) => {
  const Icon = icon === null ? null : icon !== undefined ? icon : React.createElement(TONE_DEFAULT_ICON[tone], { className: 'w-5 h-5' });

  const handleCancel = () => {
    if (loading) return;
    onCancel();
  };

  return (
    <Modal
      isOpen={open}
      onClose={handleCancel}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEsc
      showCloseButton={false}
      size="md"
      ariaLabel={typeof title === 'string' ? title : undefined}
    >
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          {Icon && (
            <div className={`p-2.5 rounded-xl shrink-0 ${TONE_ICON_WRAP[tone]}`}>{Icon}</div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h3>
            {description && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                {description}
              </p>
            )}
          </div>
        </div>

        {children}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={handleCancel}
            disabled={loading}
            className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-xl text-white text-xs font-semibold shadow-sm transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer ${TONE_CONFIRM_BUTTON[tone]}`}
          >
            {loading && (
              <span aria-hidden="true">
                <Spinner size="xs" className="text-white" />
              </span>
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
};
