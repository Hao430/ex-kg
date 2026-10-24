import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeSearchDialog, NodeSearchResult } from '@/src/components/ui/topbar/NodeSearchDialog';

const MOCK_RESULTS: NodeSearchResult[] = [
  {
    id: 'node-chat-1',
    canvasId: 'board-alpha',
    title: 'React Architecture Analysis',
    question: 'How to design modular components?',
    answer: 'Extract pure UI base primitives',
    noteContent: '',
    depth: 1,
    model: 'gemini',
    type: 'chat',
  },
  {
    id: 'node-note-2',
    canvasId: 'board-alpha',
    title: 'Vitest Migration Notes',
    question: '',
    answer: '',
    noteContent: 'Configure happy-dom and mocks in setup.ts',
    depth: 2,
    model: '',
    type: 'note',
  },
];

describe('NodeSearchDialog Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders nothing when isOpen is false', () => {
    render(
      <NodeSearchDialog
        isOpen={false}
        onClose={vi.fn()}
        boardId="board-alpha"
      />
    );
    expect(screen.queryByPlaceholderText('搜索节点内容…')).not.toBeInTheDocument();
  });

  it('renders search input and placeholder when isOpen is true', () => {
    render(
      <NodeSearchDialog
        isOpen={true}
        onClose={vi.fn()}
        boardId="board-alpha"
      />
    );

    const input = screen.getByPlaceholderText('搜索节点内容…');
    expect(input).toBeInTheDocument();
    expect(screen.getByText('输入关键词，检索本画板的思考节点与便签')).toBeInTheDocument();
  });

  describe('300ms Debounce Behavior', () => {
    it('debounces search requests by 300ms', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: MOCK_RESULTS }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-alpha"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');

      // Type "r"
      fireEvent.change(input, { target: { value: 'r' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(mockFetch).not.toHaveBeenCalled();

      // Type "react" before 300ms elapsed
      fireEvent.change(input, { target: { value: 'react' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(mockFetch).not.toHaveBeenCalled();

      // Advance remaining 100ms (total 300ms from last keystroke)
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canvases/board-alpha/search?q=react',
        expect.objectContaining({
          credentials: 'include',
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('clears results and aborts requests immediately on empty input', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-alpha"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');

      fireEvent.change(input, { target: { value: 'test' } });
      expect(screen.getByLabelText('清空搜索')).toBeInTheDocument();

      // Clear input
      fireEvent.change(input, { target: { value: '   ' } });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(screen.getByText('输入关键词，检索本画板的思考节点与便签')).toBeInTheDocument();
    });
  });

  describe('Results Rendering & Badges', () => {
    it('renders result items with theme and note badges correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: MOCK_RESULTS }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-alpha"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'react' } });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(screen.getByText('React Architecture Analysis')).toBeInTheDocument();
      expect(screen.getByText('Vitest Migration Notes')).toBeInTheDocument();
      expect(screen.getByText('主题')).toBeInTheDocument();
      expect(screen.getByText('便签')).toBeInTheDocument();
      expect(screen.getByText('Extract pure UI base primitives')).toBeInTheDocument();
      expect(screen.getByText('Configure happy-dom and mocks in setup.ts')).toBeInTheDocument();
    });
  });

  describe('Arrow Navigation & Enter Selection', () => {
    it('navigates through items with ArrowDown / ArrowUp and selects on Enter', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: MOCK_RESULTS }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const handleSelectNode = vi.fn();
      const handleClose = vi.fn();

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={handleClose}
          boardId="board-alpha"
          onSelectNode={handleSelectNode}
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'notes' } });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      const buttons = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-active'));
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toHaveAttribute('data-active', 'true');
      expect(buttons[1]).toHaveAttribute('data-active', 'false');

      // Press ArrowDown -> moves to index 1
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(buttons[0]).toHaveAttribute('data-active', 'false');
      expect(buttons[1]).toHaveAttribute('data-active', 'true');

      // Press ArrowDown again -> wraps back to index 0
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(buttons[0]).toHaveAttribute('data-active', 'true');
      expect(buttons[1]).toHaveAttribute('data-active', 'false');

      // Press ArrowUp -> wraps backwards to index 1
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(buttons[0]).toHaveAttribute('data-active', 'false');
      expect(buttons[1]).toHaveAttribute('data-active', 'true');

      // Press Enter on item 1 ('node-note-2')
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(handleSelectNode).toHaveBeenCalledWith('node-note-2');
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('ignores Enter and Arrow keys during IME composition (isComposing 守卫)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: MOCK_RESULTS }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const handleSelectNode = vi.fn();
      const handleClose = vi.fn();

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={handleClose}
          boardId="board-alpha"
          onSelectNode={handleSelectNode}
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'notes' } });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // 组词态：Enter 确认候选词、方向键选候选，都不得触发搜索选中/关闭
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });

      expect(handleSelectNode).not.toHaveBeenCalled();
      expect(handleClose).not.toHaveBeenCalled();

      // 组词结束后恢复正常
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(handleSelectNode).toHaveBeenCalledTimes(1);
    });

    it('selects item on click directly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: MOCK_RESULTS }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const handleSelectNode = vi.fn();
      const handleClose = vi.fn();

      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={handleClose}
          boardId="board-alpha"
          onSelectNode={handleSelectNode}
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'arch' } });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      const firstItem = screen.getByText('React Architecture Analysis');
      fireEvent.click(firstItem);

      expect(handleSelectNode).toHaveBeenCalledWith('node-chat-1');
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Escape, Outside Click & Abort Cancellation', () => {
    it('closes on Escape key press and aborts pending timer/request', async () => {
      const handleClose = vi.fn();
      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={handleClose}
          boardId="board-alpha"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…');
      fireEvent.change(input, { target: { value: 'query' } });

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('clears query and refocuses input when clear button is clicked', async () => {
      render(
        <NodeSearchDialog
          isOpen={true}
          onClose={vi.fn()}
          boardId="board-alpha"
        />
      );

      const input = screen.getByPlaceholderText('搜索节点内容…') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'sample' } });
      expect(input.value).toBe('sample');

      const clearBtn = screen.getByLabelText('清空搜索');
      fireEvent.click(clearBtn);

      expect(input.value).toBe('');
      expect(screen.getByText('输入关键词，检索本画板的思考节点与便签')).toBeInTheDocument();
    });
  });
});
