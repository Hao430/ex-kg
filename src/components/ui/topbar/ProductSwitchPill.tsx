/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Brain, Compass } from 'lucide-react';

export type ProductId = 'canvas' | 'practice';

export interface ProductSwitchPillProps {
  activeProduct: ProductId;
  onSwitchProduct?: (product: ProductId) => void;
}

/** Spec R1：双产品切换胶囊（思维画布 ↔ AI 练习）。两条产品线头部共用的唯一入口。 */
export const ProductSwitchPill: React.FC<ProductSwitchPillProps> = ({
  activeProduct,
  onSwitchProduct,
}) => (
  <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-xl border border-slate-200/70 dark:border-slate-700/60 text-xs font-medium shrink-0">
    <button
      type="button"
      onClick={() => onSwitchProduct?.('canvas')}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
        activeProduct === 'canvas'
          ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm font-semibold'
          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
      }`}
    >
      <Compass className="w-3.5 h-3.5 text-indigo-500" />
      <span className="hidden xl:inline">思维画布</span>
    </button>
    <button
      type="button"
      onClick={() => onSwitchProduct?.('practice')}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
        activeProduct === 'practice'
          ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm font-semibold'
          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
      }`}
    >
      <Brain className="w-3.5 h-3.5 text-purple-500" />
      <span className="hidden xl:inline">AI 练习</span>
    </button>
  </div>
);
