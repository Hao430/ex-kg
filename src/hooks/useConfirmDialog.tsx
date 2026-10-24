/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog, type ConfirmTone } from '../components/ui/base/ConfirmDialog';

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  cancelLabel?: string;
  tone?: ConfirmTone;
  icon?: React.ReactNode;
}

export interface UseConfirmDialogResult {
  /** Promise 化确认：resolve(true) = 确认，resolve(false) = 取消/ESC/被新确认顶掉 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** 消费方必须把该元素挂进自己的 JSX（通常放根节点末尾） */
  element: React.ReactNode;
}

/**
 * window.confirm 的 promise 化替代：调用点由同步阻塞改为 await。
 * 卸载时兜底 resolve(false)，防调用方 await 悬挂。
 */
export function useConfirmDialog(): UseConfirmDialogResult {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const finish = useCallback((value: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOptions(null);
    resolve?.(value);
  }, []);

  useEffect(() => {
    return () => {
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(false);
    };
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    // 已有待决确认时按取消结算（后到覆盖，不叠加悬挂 Promise）
    const prev = resolveRef.current;
    resolveRef.current = null;
    prev?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const element = (
    <ConfirmDialog
      open={options !== null}
      title={options?.title ?? ''}
      description={options?.description}
      children={options?.children}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      tone={options?.tone}
      icon={options?.icon}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  );

  return { confirm, element };
}
