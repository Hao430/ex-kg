/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'deepdive_theme';

export interface UseThemeOptions {
  /** Optional callback fired when theme is toggled (e.g. for toast notices) */
  onToggleNotice?: (nextTheme: Theme) => void;
  /** Backward-compatible alias for onToggleNotice */
  onToggle?: (nextTheme: Theme) => void;
}

export interface UseThemeReturn {
  theme: Theme;
  isDark: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme | ((prev: Theme) => Theme)) => void;
}

/**
 * Safely resolves initial theme from localStorage -> prefers-color-scheme -> 'light'.
 * Gracefully handles SSR or environments where localStorage access is restricted.
 */
export function getInitialTheme(): Theme {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === 'light' || savedTheme === 'dark') {
        return savedTheme;
      }
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    }
  } catch {
    // Ignore storage quota or cross-origin access exceptions
  }
  return 'light';
}

/**
 * Unified theme management hook.
 * Synchronizes 'dark' class on document.documentElement and persists to localStorage.
 */
export function useTheme(options?: UseThemeOptions): UseThemeReturn {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  // Keep a mutable ref to options to guarantee stable toggleTheme callback reference
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Synchronize 'dark' class on <html> documentElement & persist to localStorage
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      }
    } catch {
      // Ignore storage write errors (e.g. storage disabled)
    }
  }, [theme]);

  // Synchronize across multiple browser tabs
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        const next = event.newValue;
        if (next === 'light' || next === 'dark') {
          setTheme(next);
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'light' ? 'dark' : 'light';
      const notify = optionsRef.current?.onToggleNotice ?? optionsRef.current?.onToggle;
      notify?.(next);
      return next;
    });
  }, []);

  return {
    theme,
    isDark: theme === 'dark',
    toggleTheme,
    setTheme,
  };
}
