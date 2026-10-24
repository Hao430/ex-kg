import React, { useRef, useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useClickOutside } from '@/src/hooks/useClickOutside';

function Harness(props: {
  onOutside: () => void;
  enabled?: boolean;
  ignore?: (target: Element) => boolean;
  closeOnEscape?: boolean;
  onEscape?: () => void;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useClickOutside({
    refs: [innerRef],
    enabled: props.enabled ?? true,
    onOutside: () => {
      props.onOutside();
      setVisible(false);
    },
    ignore: props.ignore,
    closeOnEscape: props.closeOnEscape,
    onEscape: props.onEscape,
  });

  return (
    <div>
      <button type="button">trigger</button>
      {visible && (
        <div ref={innerRef} data-testid="inner">
          inner
        </div>
      )}
      <div data-testid="outside">outside</div>
    </div>
  );
}

describe('useClickOutside Hook', () => {
  it('fires onOutside when pointerdown lands outside refs', () => {
    const onOutside = vi.fn();
    const { getByTestId } = render(<Harness onOutside={onOutside} />);

    fireEvent.pointerDown(getByTestId('outside'));
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('does not fire when pointerdown lands inside refs', () => {
    const onOutside = vi.fn();
    const { getByTestId } = render(<Harness onOutside={onOutside} />);

    fireEvent.pointerDown(getByTestId('inner'));
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('respects the ignore predicate (e.g. trigger button)', () => {
    const onOutside = vi.fn();
    const { getByText } = render(
      <Harness
        onOutside={onOutside}
        ignore={(target) => (target as HTMLElement).textContent === 'trigger'}
      />,
    );

    fireEvent.pointerDown(getByText('trigger'));
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('does not listen when enabled=false', () => {
    const onOutside = vi.fn();
    const { getByTestId } = render(<Harness onOutside={onOutside} enabled={false} />);

    fireEvent.pointerDown(getByTestId('outside'));
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('does not listen by default for Escape', () => {
    const onOutside = vi.fn();
    render(<Harness onOutside={onOutside} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('fires onEscape via closeOnEscape (defaults to onOutside)', () => {
    const onOutside = vi.fn();
    render(<Harness onOutside={onOutside} closeOnEscape />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('uses dedicated onEscape when provided', () => {
    const onOutside = vi.fn();
    const onEscape = vi.fn();
    render(
      <Harness onOutside={onOutside} closeOnEscape onEscape={onEscape} />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onOutside).not.toHaveBeenCalled();
  });
});
