/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { createPortal } from 'react-dom';

export interface ToastProps {
  message: React.ReactNode;
  /**
   * 缺省 z-[70]：需盖过 z-50 弹窗与 z-60 admin 子弹窗（弹窗内操作的反馈必须可见），
   * 低于 z-[80] 示例画布沉浸层。
   */
  zIndex?: string;
}

/** 全局浮动操作反馈（portal 到 body，脱离任何局部堆叠上下文） */
export const Toast: React.FC<ToastProps> = ({ message, zIndex = 'z-[70]' }) => {
  if (!message || typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="status"
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 ${zIndex} bg-slate-900/90 text-white px-4 py-2 rounded-full text-xs font-medium shadow-2xl backdrop-blur-md border border-slate-700/80 animate-in fade-in slide-in-from-bottom-2 duration-200`}
    >
      {message}
    </div>,
    document.body,
  );
};
