/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Compass } from 'lucide-react';
import { Tooltip } from '../Tooltip';

export interface BrandLogoProps {
  onGoToLanding: () => void;
}

/** 品牌 Logo 块：思维画布 / AI 练习两条产品线共用的返回产品介绍首页入口。 */
export const BrandLogo: React.FC<BrandLogoProps> = ({ onGoToLanding }) => (
  <Tooltip content="返回产品介绍首页" side="bottom">
    <button
      onClick={onGoToLanding}
      className="flex items-center gap-2 group cursor-pointer focus:outline-none"
    >
      <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-sky-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 group-hover:scale-105 transition-transform">
        <Compass className="w-4 h-4 text-white" />
      </div>
      <span className="font-bold text-slate-850 dark:text-slate-100 text-sm tracking-tight hidden xl:inline group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
        枝想<span className="text-indigo-600 dark:text-indigo-400 font-semibold">Arborize</span>
      </span>
    </button>
  </Tooltip>
);
