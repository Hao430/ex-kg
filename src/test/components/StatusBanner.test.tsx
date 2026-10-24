import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StatusBanner } from '@/src/components/ui/base/StatusBanner';

describe('StatusBanner Component', () => {
  it('defaults to info tone', () => {
    render(<StatusBanner>提示内容</StatusBanner>);

    const banner = screen.getByText('提示内容').parentElement!;
    expect(banner.className).toContain('indigo');
    expect(banner.getAttribute('role')).toBe('status');
  });

  it.each([
    ['success', 'emerald'],
    ['error', 'rose'],
    ['info', 'indigo'],
  ] as const)('applies %s tone classes', (type, color) => {
    render(<StatusBanner type={type}>内容</StatusBanner>);

    const banner = screen.getByText('内容').parentElement!;
    expect(banner.className).toContain(color);
  });

  it('marks error tone as alert role', () => {
    render(<StatusBanner type="error">出错了</StatusBanner>);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('has no dismiss button by default', () => {
    render(<StatusBanner>内容</StatusBanner>);

    expect(screen.queryByLabelText('关闭提示')).not.toBeInTheDocument();
  });

  it('shows dismiss button and calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<StatusBanner dismissible onDismiss={onDismiss}>内容</StatusBanner>);

    fireEvent.click(screen.getByLabelText('关闭提示'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('passes className through', () => {
    render(<StatusBanner className="my-custom-class">内容</StatusBanner>);

    const banner = screen.getByText('内容').parentElement!;
    expect(banner.className).toContain('my-custom-class');
  });

  it('skips tone skin in unstyled mode (皮肤由 className 提供)', () => {
    render(<StatusBanner unstyled className="my-skin">内容</StatusBanner>);

    const banner = screen.getByText('内容').parentElement!;
    expect(banner.className).toContain('my-skin');
    expect(banner.className).not.toContain('indigo');
    expect(banner.className).toContain('flex items-start gap-2');
  });

  it('renders custom icon and hides icon with icon={null}', () => {
    const { rerender } = render(
      <StatusBanner icon={<span data-testid="custom-icon" />}>内容</StatusBanner>,
    );

    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();

    rerender(<StatusBanner icon={null}>内容</StatusBanner>);
    expect(screen.queryByTestId('custom-icon')).not.toBeInTheDocument();
  });
});
