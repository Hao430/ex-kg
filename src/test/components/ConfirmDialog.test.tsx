import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from '@/src/components/ui/base/ConfirmDialog';

describe('ConfirmDialog Primitive Component', () => {
  it('renders title/description/buttons when open', () => {
    render(
      <ConfirmDialog
        open={true}
        title="确认删除？"
        description="该操作不可撤销"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('确认删除？')).toBeInTheDocument();
    expect(screen.getByText('该操作不可撤销')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('renders nothing when open is false', () => {
    render(
      <ConfirmDialog
        open={false}
        title="不可见"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByText('不可见')).not.toBeInTheDocument();
  });

  it('invokes onConfirm / onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open={true} title="T" onConfirm={onConfirm} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders children between description and buttons', () => {
    render(
      <ConfirmDialog open={true} title="T" onConfirm={vi.fn()} onCancel={vi.fn()}>
        <div>受影响节点总数</div>
      </ConfirmDialog>,
    );

    expect(screen.getByText('受影响节点总数')).toBeInTheDocument();
  });

  it('applies danger tone to confirm button', () => {
    render(
      <ConfirmDialog open={true} title="T" tone="danger" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: '确认' }).className).toContain('bg-rose-600');
  });

  it('disables buttons and blocks cancel while loading', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        title="T"
        loading={true}
        confirmLabel="删除中"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('button', { name: '删除中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes via Escape → onCancel by default', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open={true} title="T" onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not close on backdrop click by default', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open={true} title="T" onConfirm={vi.fn()} onCancel={onCancel} />);

    const dialog = screen.getByRole('dialog');
    // Modal 结构：背板是 dialog 的最近 fixed 祖先
    const backdrop = dialog.closest('.fixed');
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop as HTMLElement);
    fireEvent.click(backdrop as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('allows custom icon', () => {
    render(
      <ConfirmDialog
        open={true}
        title="T"
        icon={<span data-testid="custom-icon" />}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
  });
});
