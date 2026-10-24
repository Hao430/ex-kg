import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useConfirmDialog } from '@/src/hooks/useConfirmDialog';

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirm, element } = useConfirmDialog();

  const ask = () => {
    void confirm({ title: '确认操作？', tone: 'danger' }).then(onResult);
  };

  return (
    <div>
      <button type="button" onClick={ask}>
        ask
      </button>
      {element}
    </div>
  );
}

describe('useConfirmDialog Hook', () => {
  it('resolves true on confirm', async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);

    fireEvent.click(screen.getByText('ask'));
    expect(await screen.findByText('确认操作？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(results).toEqual([true]));
    // 关闭后对话框卸载（等 AnimatePresence 退场动画结束）
    await waitFor(() => expect(screen.queryByText('确认操作？')).not.toBeInTheDocument());
  });

  it('resolves false on cancel', async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);

    fireEvent.click(screen.getByText('ask'));
    await screen.findByText('确认操作？');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('resolves false on Escape', async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);

    fireEvent.click(screen.getByText('ask'));
    await screen.findByText('确认操作？');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('resolves the pending promise as false when a new confirm supersedes it', async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);

    fireEvent.click(screen.getByText('ask'));
    await screen.findByText('确认操作？');
    fireEvent.click(screen.getByText('ask')); // 第二次提问顶掉第一次

    await waitFor(() => expect(results).toEqual([false]));
    expect(screen.getByText('确认操作？')).toBeInTheDocument();
  });

  it('resolves false when the component unmounts with a pending dialog', async () => {
    const results: boolean[] = [];
    const { unmount } = render(<Harness onResult={(v) => results.push(v)} />);

    fireEvent.click(screen.getByText('ask'));
    await screen.findByText('确认操作？');

    unmount();
    await waitFor(() => expect(results).toEqual([false]));
  });
});
