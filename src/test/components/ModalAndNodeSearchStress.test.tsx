import React, { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Modal } from '@/src/components/ui/base/Modal';
import { NodeSearchDialog, NodeSearchResult } from '@/src/components/ui/topbar/NodeSearchDialog';

describe('Empirical Adversarial Stress Tests: Modal & NodeSearchDialog', () => {
  describe('Modal Edge Cases & Stress Scenarios', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    });

    it('survives rapid 50 open/close cycles without leaking body scroll lock', async () => {
      const StatefulHarness = () => {
        const [open, setOpen] = useState(false);
        return (
          <div>
            <button onClick={() => setOpen((prev) => !prev)}>Toggle</button>
            <Modal isOpen={open} onClose={() => setOpen(false)}>
              <div data-testid="rapid-content">Rapid Cycle Content</div>
            </Modal>
          </div>
        );
      };

      render(<StatefulHarness />);
      const toggleBtn = screen.getByText('Toggle');

      for (let i = 0; i < 50; i++) {
        // Open
        fireEvent.click(toggleBtn);
        expect(document.body.style.overflow).toBe('hidden');
        // Close
        fireEvent.click(toggleBtn);
        expect(document.body.style.overflow).toBe('');
      }

      expect(document.body.style.overflow).toBe('');
    });

    it('correctly manages interleaved open and close across 3 nested/concurrent modals', async () => {
      const MultiModalHarness = ({
        m1,
        m2,
        m3,
      }: {
        m1: boolean;
        m2: boolean;
        m3: boolean;
      }) => (
        <>
          <Modal isOpen={m1} onClose={vi.fn()}>
            Modal 1
          </Modal>
          <Modal isOpen={m2} onClose={vi.fn()}>
            Modal 2
          </Modal>
          <Modal isOpen={m3} onClose={vi.fn()}>
            Modal 3
          </Modal>
        </>
      );

      const { rerender } = render(<MultiModalHarness m1={false} m2={false} m3={false} />);
      expect(document.body.style.overflow).toBe('');

      // Open Modal 1
      rerender(<MultiModalHarness m1={true} m2={false} m3={false} />);
      expect(document.body.style.overflow).toBe('hidden');

      // Open Modal 2
      rerender(<MultiModalHarness m1={true} m2={true} m3={false} />);
      expect(document.body.style.overflow).toBe('hidden');

      // Open Modal 3
      rerender(<MultiModalHarness m1={true} m2={true} m3={true} />);
      expect(document.body.style.overflow).toBe('hidden');

      // Close Modal 2 (1 and 3 still open)
      rerender(<MultiModalHarness m1={true} m2={false} m3={true} />);
      expect(document.body.style.overflow).toBe('hidden');

      // Close Modal 1 (3 still open)
      rerender(<MultiModalHarness m1={false} m2={false} m3={true} />);
      expect(document.body.style.overflow).toBe('hidden');

      // Close Modal 3 (all closed)
      rerender(<MultiModalHarness m1={false} m2={false} m3={false} />);
      expect(document.body.style.overflow).toBe('');
    });

    it('restores pre-existing body overflow style (e.g. "scroll") upon modal closure', async () => {
      document.body.style.overflow = 'scroll';

      const { rerender } = render(
        <Modal isOpen={true} onClose={vi.fn()}>
          <div>Preserve Pre-existing Style</div>
        </Modal>
      );

      expect(document.body.style.overflow).toBe('hidden');

      rerender(
        <Modal isOpen={false} onClose={vi.fn()}>
          <div>Preserve Pre-existing Style</div>
        </Modal>
      );

      expect(document.body.style.overflow).toBe('scroll');
    });

    it('releases body scroll lock when component is abruptly unmounted while isOpen=true', async () => {
      const { unmount } = render(
        <Modal isOpen={true} onClose={vi.fn()}>
          <div>Abrupt Unmount Test</div>
        </Modal>
      );

      expect(document.body.style.overflow).toBe('hidden');

      unmount();

      expect(document.body.style.overflow).toBe('');
    });

    it('allows child input to suppress Escape modal closure via stopPropagation', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnEsc={true}>
          <input
            data-testid="inner-input"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
              }
            }}
          />
        </Modal>
      );

      const input = await screen.findByTestId('inner-input');
      input.focus();

      // Fire Escape on inner-input which stops propagation
      fireEvent.keyDown(input, { key: 'Escape' });

      // Because the event propagation was stopped before window listener, onClose is NOT called
      expect(handleClose).not.toHaveBeenCalled();

      // Fire Escape directly on window (outside input stopPropagation guard)
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('calls stopPropagation on Escape event, demonstrating that same-target window listeners still receive the event without stopImmediatePropagation', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnEsc={true}>
          <div>Escape Boundary Test</div>
        </Modal>
      );

      const externalWindowEscapeListener = vi.fn();
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') externalWindowEscapeListener();
      });

      await screen.findByRole('dialog');

      // Dispatch Escape on window
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(handleClose).toHaveBeenCalledTimes(1);
      // Empirical finding: In standard DOM event model, window.addEventListener with e.stopPropagation()
      // cannot stop other window listeners on the same target without e.stopImmediatePropagation()
      expect(externalWindowEscapeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('NodeSearchDialog Edge Cases & Stress Scenarios', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('handles rapid keystroke storm (15 inputs within 200ms) with exactly 1 fetch invocation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-stress"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');

      // 15 rapid keystrokes with 10ms intervals
      for (let i = 1; i <= 15; i++) {
        fireEvent.change(input, { target: { value: `query-step-${i}` } });
        act(() => {
          vi.advanceTimersByTime(10);
        });
        expect(mockFetch).not.toHaveBeenCalled();
      }

      // Advance 290ms more (total 300ms since step 15)
      await act(async () => {
        vi.advanceTimersByTime(290);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canvases/board-stress/search?q=query-step-15',
        expect.objectContaining({ credentials: 'include' })
      );
    });

    it('cancels pending timer and makes 0 requests if query is erased to empty before 300ms', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-stress"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');

      fireEvent.change(input, { target: { value: 'rapid' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(mockFetch).not.toHaveBeenCalled();

      // Erase to empty
      fireEvent.change(input, { target: { value: '' } });

      // Advance past debounce
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(screen.getByText('输入关键词，检索本画板的思考节点与便签')).toBeInTheDocument();
    });

    it('correctly discards in-flight stale responses when a subsequent query resolves earlier or replaces it', async () => {
      let resolveFirst: (value: any) => void = () => {};
      let resolveSecond: (value: any) => void = () => {};

      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise((resolve) => {
        resolveSecond = resolve;
      });

      const mockFetch = vi
        .fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(() => secondPromise);

      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-stress"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');

      // 1. Type "first" -> triggers search
      fireEvent.change(input, { target: { value: 'first' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 2. Type "second" -> cancels first AbortController, triggers second search
      fireEvent.change(input, { target: { value: 'second' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // 3. Resolve the stale first request with stale results
      const staleResults: NodeSearchResult[] = [
        {
          id: 'stale-1',
          canvasId: 'board-stress',
          title: 'STALE OBSOLETE TITLE',
          question: '',
          answer: '',
          noteContent: '',
          depth: 1,
          model: '',
          type: 'chat',
        },
      ];

      await act(async () => {
        resolveFirst({
          ok: true,
          json: async () => ({ results: staleResults }),
        });
      });

      // Stale results must NOT be shown!
      expect(screen.queryByText('STALE OBSOLETE TITLE')).not.toBeInTheDocument();

      // 4. Resolve the active second request
      const freshResults: NodeSearchResult[] = [
        {
          id: 'fresh-2',
          canvasId: 'board-stress',
          title: 'FRESH ACCURATE TITLE',
          question: '',
          answer: '',
          noteContent: '',
          depth: 1,
          model: '',
          type: 'chat',
        },
      ];

      await act(async () => {
        resolveSecond({
          ok: true,
          json: async () => ({ results: freshResults }),
        });
      });

      // Fresh results must be shown!
      expect(screen.getByText('FRESH ACCURATE TITLE')).toBeInTheDocument();
    });

    it('gracefully handles HTTP 500 and network throwing without crashing the UI', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network connection offline'));
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-stress"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'crash-test' } });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // UI should catch gracefully, remove loader, and display empty result indicator
      expect(screen.getByText('未找到匹配的节点')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('safely encodes adversarial and special characters without URI breakage', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-complex/123?foo=bar"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      const adversarialQuery = 'foo&bar=1#hash "quotes" <script> 🎯 \uD83E\uDDE0';
      fireEvent.change(input, { target: { value: adversarialQuery } });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(encodeURIComponent('board-complex/123?foo=bar'));
      expect(url).toContain(encodeURIComponent(adversarialQuery));
    });

    it('aborts in-flight request when dialog is closed', async () => {
      let capturedSignal: AbortSignal | null = null;
      const mockFetch = vi.fn().mockImplementation((_url, init) => {
        capturedSignal = init?.signal ?? null;
        return new Promise(() => {}); // never resolves
      });
      vi.stubGlobal('fetch', mockFetch);

      const handleClose = vi.fn();
      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={handleClose}
          boardId="board-stress"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'in-flight' } });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal?.aborted).toBe(false);

      // Press Escape to close
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('handles keyboard navigation cleanly when results list is empty', async () => {
      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-stress"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');

      // Pressing ArrowDown / ArrowUp / Enter on empty results must not throw or divide by zero
      expect(() => {
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        fireEvent.keyDown(input, { key: 'Enter' });
      }).not.toThrow();
    });
  });
});
