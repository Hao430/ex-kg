/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ShieldAlert } from 'lucide-react';

export interface ModelWarningBannerProps {
  modelConfigured: boolean | null;
  onNavigateToModels?: () => void;
}

export const ModelWarningBanner: React.FC<ModelWarningBannerProps> = ({
  modelConfigured,
  onNavigateToModels,
}) => {
  if (modelConfigured !== false) return null;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 shadow-sm">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div className="text-xs text-red-800 dark:text-red-200 leading-relaxed">
          <span className="font-bold">模型未配置：全站 AI 推理当前不可用。</span>
          <span className="ml-1">用户提问将收到「模型未配置」错误，请在下方选择模型并保存。</span>
        </div>
      </div>
      {onNavigateToModels && (
        <button
          onClick={onNavigateToModels}
          className="shrink-0 px-3.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
        >
          立即配置模型
        </button>
      )}
    </div>
  );
};
