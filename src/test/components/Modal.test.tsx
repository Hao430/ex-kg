import React, { useRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Modal } from '@/src/components/ui/base/Modal';

describe('Modal Primitive Component', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  });

  describe('Portal Mounting & Container', () => {
    it('mounts into document.body by default when isOpen is true', async () => {
      const { unmount } = render(
        <Modal isOpen={true} onClose={vi.fn()} title="Test Modal">
          <div>Modal Body Content</div>
        </Modal>
      );

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(document.body).toContainElement(dialog);
      expect(screen.getByText('Test Modal')).toBeInTheDocument();
      expect(screen.getByText('Modal Body Content')).toBeInTheDocument();

      unmount();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders nothing when isOpen is false', () => {
      render(
        <Modal isOpen={false} onClose={vi.fn()} title="Hidden Modal">
          <div>Hidden Content</div>
        </Modal>
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Hidden Modal')).not.toBeInTheDocument();
    });

    it('mounts into custom container when provided', async () => {
      const customContainer = document.createElement('div');
      customContainer.id = 'custom-portal-root';
      document.body.appendChild(customContainer);

      render(
        <Modal isOpen={true} onClose={vi.fn()} container={customContainer}>
          <div>Custom Portal Content</div>
        </Modal>
      );

      const dialog = await screen.findByRole('dialog');
      expect(customContainer).toContainElement(dialog);
    });

    it('renders close button by default and triggers onClose when clicked', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} title="With Close Button">
          <div>Content</div>
        </Modal>
      );

      const closeButton = await screen.findByLabelText('关闭');
      expect(closeButton).toBeInTheDocument();
      fireEvent.click(closeButton);
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('hides close button when showCloseButton is false', () => {
      render(
        <Modal isOpen={true} onClose={vi.fn()} title="No Close" showCloseButton={false}>
          <div>Content</div>
        </Modal>
      );

      expect(screen.queryByLabelText('关闭')).not.toBeInTheDocument();
    });
  });

  describe('Escape Key Listener', () => {
    it('calls onClose when Escape key is pressed and closeOnEsc is true', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnEsc={true}>
          <div>Content</div>
        </Modal>
      );

      await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose when Escape key is pressed and closeOnEsc is false', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnEsc={false}>
          <div>Content</div>
        </Modal>
      );

      await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).not.toHaveBeenCalled();
    });

    it('ignores other keys like Enter or Space on window', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnEsc={true}>
          <div>Content</div>
        </Modal>
      );

      await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Enter' });
      fireEvent.keyDown(window, { key: ' ' });
      expect(handleClose).not.toHaveBeenCalled();
    });
  });

  describe('Backdrop Click & Drag Guard', () => {
    it('closes on backdrop click when mouseDown and mouseUp occur on backdrop', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnBackdrop={true}>
          <div>Modal Inner Content</div>
        </Modal>
      );

      const dialog = await screen.findByRole('dialog');
      const backdrop = dialog.parentElement as HTMLElement;
      expect(backdrop).toBeInTheDocument();

      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT close when selecting text starts inside modal and drags onto backdrop', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnBackdrop={true}>
          <div data-testid="modal-text">Draggable Text Content</div>
        </Modal>
      );

      const textElement = await screen.findByTestId('modal-text');
      const dialog = screen.getByRole('dialog');
      const backdrop = dialog.parentElement as HTMLElement;

      // Mouse down inside modal text
      fireEvent.mouseDown(textElement);
      // Mouse up / click finishes on backdrop
      fireEvent.click(backdrop);

      expect(handleClose).not.toHaveBeenCalled();
    });

    it('does not close on backdrop click when closeOnBackdrop is false', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnBackdrop={false}>
          <div>Content</div>
        </Modal>
      );

      const dialog = await screen.findByRole('dialog');
      const backdrop = dialog.parentElement as HTMLElement;

      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);

      expect(handleClose).not.toHaveBeenCalled();
    });

    it('does not close when clicking inside the dialog container', async () => {
      const handleClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} closeOnBackdrop={true}>
          <button type="button">Inside Button</button>
        </Modal>
      );

      const dialog = await screen.findByRole('dialog');
      fireEvent.mouseDown(dialog);
      fireEvent.click(dialog);

      expect(handleClose).not.toHaveBeenCalled();
    });
  });

  describe('Focus Trap & Cycling', () => {
    it('focuses initialFocusRef element if provided', async () => {
      const TestWrapper = () => {
        const inputRef = useRef<HTMLInputElement>(null);
        return (
          <Modal isOpen={true} onClose={vi.fn()} initialFocusRef={inputRef}>
            <input ref={inputRef} data-testid="target-input" />
            <button type="button">Other Button</button>
          </Modal>
        );
      };

      render(<TestWrapper />);
      const input = await screen.findByTestId('target-input');

      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    });

    it('traps Tab navigation within modal elements', async () => {
      render(
        <Modal isOpen={true} onClose={vi.fn()} showCloseButton={true}>
          <input data-testid="first-input" />
          <button type="button" data-testid="last-btn">Submit</button>
        </Modal>
      );

      const dialog = await screen.findByRole('dialog');
      const closeBtn = screen.getByLabelText('关闭');
      const firstInput = screen.getByTestId('first-input');
      const lastBtn = screen.getByTestId('last-btn');

      // Focus last element
      lastBtn.focus();
      expect(document.activeElement).toBe(lastBtn);

      // Press Tab on dialog container -> should wrap to first focusable element (closeBtn)
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(document.activeElement).toBe(closeBtn);

      // Press Shift+Tab on first element (closeBtn) -> should wrap to last focusable element (lastBtn)
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(lastBtn);
    });
  });

  describe('Body Scroll Lock Reference Counting', () => {
    it('locks body scroll on open and unlocks on close', async () => {
      expect(document.body.style.overflow).toBe('');

      const { rerender } = render(
        <Modal isOpen={true} onClose={vi.fn()}>
          <div>Content</div>
        </Modal>
      );

      await screen.findByRole('dialog');
      expect(document.body.style.overflow).toBe('hidden');

      rerender(
        <Modal isOpen={false} onClose={vi.fn()}>
          <div>Content</div>
        </Modal>
      );

      expect(document.body.style.overflow).toBe('');
    });

    it('handles nested / multiple modals correctly via ref-counting', async () => {
      const { rerender } = render(
        <>
          <Modal isOpen={true} onClose={vi.fn()}>Modal 1</Modal>
          <Modal isOpen={false} onClose={vi.fn()}>Modal 2</Modal>
        </>
      );

      expect(document.body.style.overflow).toBe('hidden');

      // Open Modal 2 as well
      rerender(
        <>
          <Modal isOpen={true} onClose={vi.fn()}>Modal 1</Modal>
          <Modal isOpen={true} onClose={vi.fn()}>Modal 2</Modal>
        </>
      );
      expect(document.body.style.overflow).toBe('hidden');

      // Close Modal 2, Modal 1 still open
      rerender(
        <>
          <Modal isOpen={true} onClose={vi.fn()}>Modal 1</Modal>
          <Modal isOpen={false} onClose={vi.fn()}>Modal 2</Modal>
        </>
      );
      expect(document.body.style.overflow).toBe('hidden');

      // Close Modal 1
      rerender(
        <>
          <Modal isOpen={false} onClose={vi.fn()}>Modal 1</Modal>
          <Modal isOpen={false} onClose={vi.fn()}>Modal 2</Modal>
        </>
      );
      expect(document.body.style.overflow).toBe('');
    });
  });
});
