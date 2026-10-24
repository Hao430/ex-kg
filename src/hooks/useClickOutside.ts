/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, type RefObject } from 'react';

export interface UseClickOutsideOptions {
  /** 视为「内部」的元素引用（点在这些元素里不触发） */
  refs: RefObject<HTMLElement | null>[];
  enabled: boolean;
  onOutside: () => void;
  /** 额外豁免判定（如触发按钮、上标引用等） */
  ignore?: (target: Element) => boolean;
  closeOnEscape?: boolean;
  /** 缺省复用 onOutside */
  onEscape?: () => void;
}

/**
 * 点击外部关闭（pointerdown capture 阶段）+ 可选 Escape 关闭。
 * 收敛 UserDropdown / BoardSelectorDropdown / NodeSearchDialog / ChatCardNode / Topbar
 * 各自手写的同一份监听逻辑。
 */
export function useClickOutside(options: UseClickOutsideOptions): void {
  const { enabled, closeOnEscape = false } = options;

  // 回调与 refs 走 ref 透传，避免消费方每次渲染的内联函数导致反复解绑/重绑
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      const { refs, onOutside, ignore } = optionsRef.current;
      if (ignore?.(target)) return;
      const inside = refs.some((ref) => ref.current && ref.current.contains(target));
      if (!inside) onOutside();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const { onOutside, onEscape } = optionsRef.current;
      (onEscape ?? onOutside)();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    if (closeOnEscape) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      if (closeOnEscape) {
        window.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [enabled, closeOnEscape]);
}
