import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Spinner } from '@/src/components/ui/base/Spinner';

describe('Spinner Component', () => {
  it.each([
    ['xs', 'w-2.5 h-2.5'],
    ['sm', 'w-3.5 h-3.5'],
    ['md', 'w-4 h-4'],
    ['lg', 'w-7 h-7'],
    ['xl', 'w-10 h-10'],
  ] as const)('maps size %s to %s', (size, expected) => {
    const { container } = render(<Spinner size={size} />);

    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain(expected);
    expect(el.className).toContain('animate-spin');
  });

  it('defaults to sm', () => {
    const { container } = render(<Spinner />);

    expect((container.firstElementChild as HTMLElement).className).toContain('w-3.5 h-3.5');
  });

  it('passes className through', () => {
    const { container } = render(<Spinner className="text-white" />);

    expect((container.firstElementChild as HTMLElement).className).toContain('text-white');
  });
});
