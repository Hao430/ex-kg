/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 「该画板已在另一个标签页中打开」的闸门（技术债 #0097）。
 *
 * 同一浏览器里两块画板共享同一份本地存储，两个标签同时编辑同一块板会互相覆盖，
 * 更糟的是会把对方刚保存的节点误判成「本地删除」并在云端真删掉。因此第二个标签
 * **不渲染编辑画布**，只给一个明确的说明与两条出路：接管编辑权，或去画板库。
 *
 * 文案口径：不出现任何内部术语（锁、同步、租户、覆盖策略…），只说用户能看懂的事实。
 */
import React from 'react';
import { MonitorSmartphone, LayoutGrid } from 'lucide-react';

interface BoardLockedNoticeProps {
  boardName: string;
  /** 在此标签页接管编辑（另一个标签页会变为只读提示） */
  onTakeOver: () => void;
  onOpenLibrary: () => void;
}

export const BoardLockedNotice: React.FC<BoardLockedNoticeProps> = ({
  boardName,
  onTakeOver,
  onOpenLibrary,
}) => (
  <div
    data-testid="board-locked-notice"
    className="w-full h-full flex items-center justify-center px-6"
  >
    <div className="max-w-md w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 shadow-sm p-7 text-center">
      <span className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
        <MonitorSmartphone className="w-5 h-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
        画板正在另一个标签页中编辑
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        「{boardName}」已在另一个标签页打开。为避免两个标签页互相覆盖内容，此标签页暂不显示编辑画布。
      </p>
      <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2.5">
        <button
          onClick={onTakeOver}
          className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 rounded-xl transition-all shadow-xs cursor-pointer"
        >
          在此标签页继续编辑
        </button>
        <button
          onClick={onOpenLibrary}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
        >
          <LayoutGrid className="w-4 h-4" />
          打开画板库
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
        继续编辑后，另一个标签页会转为只读提示。
      </p>
    </div>
  </div>
);
