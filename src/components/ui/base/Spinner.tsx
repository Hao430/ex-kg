/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Loader2 } from 'lucide-react';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  xs: 'w-2.5 h-2.5',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-7 h-7',
  xl: 'w-10 h-10',
};

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
}

/** 统一加载指示器：收敛各处手写的 Loader2 + animate-spin 组合 */
export const Spinner: React.FC<SpinnerProps> = ({ size = 'sm', className = '' }) => (
  <Loader2
    role="status"
    aria-label="加载中"
    className={`${SIZE_CLASSES[size]} animate-spin ${className}`}
  />
);
