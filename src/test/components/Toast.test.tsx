import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Toast } from '@/src/components/ui/base/Toast';

describe('Toast Component', () => {
  it('renders nothing when message is empty', () => {
    const { container } = render(<Toast message={null} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders message into document.body portal with role=status', () => {
    render(<Toast message="操作成功" />);

    const toast = screen.getByRole('status');
    expect(toast).toBeInTheDocument();
    expect(toast.textContent).toBe('操作成功');
    expect(toast.className).toContain('z-[70]');
    expect(toast.className).toContain('fixed');
  });

  it('supports zIndex override', () => {
    render(<Toast message="置顶" zIndex="z-[90]" />);

    expect(screen.getByRole('status').className).toContain('z-[90]');
  });
});
