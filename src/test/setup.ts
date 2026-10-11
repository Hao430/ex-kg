import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// 1. Cleanup DOM and reset leaked styles
afterEach(() => {
  cleanup();
  if (typeof document !== 'undefined') {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
  vi.restoreAllMocks();
});

// 2. Mock window.matchMedia for Framer Motion / CSS media queries
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // 3. Mock ResizeObserver
  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: MockResizeObserver,
  });

  // 4. Mock scrollIntoView
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }

  // 5. Ensure requestAnimationFrame and cancelAnimationFrame
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      return setTimeout(callback, 0) as unknown as number;
    };
  }
  if (!window.cancelAnimationFrame) {
    window.cancelAnimationFrame = (id: number) => {
      clearTimeout(id);
    };
  }

  // 6. Handle happy-dom Animation cancel unhandled rejection in motion
  if (typeof Element !== 'undefined' && Element.prototype.animate) {
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function (...args: any[]) {
      const animation = originalAnimate.apply(this, args as any);
      if (animation && animation.finished) {
        animation.finished.catch(() => {});
      }
      return animation;
    };
  }
}
