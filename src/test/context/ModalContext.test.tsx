import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ModalProvider, useModal, defaultModalContextValue } from '@/src/context/ModalContext';

// Helper component that consumes useModal and exposes values/actions
const TestConsumer: React.FC<{
  onInspect?: (val: ReturnType<typeof useModal>) => void;
}> = ({ onInspect }) => {
  const modal = useModal();
  if (onInspect) {
    onInspect(modal);
  }
  return (
    <div>
      <span data-testid="auth-modal-state">{modal.authModalOpen ? 'open' : 'closed'}</span>
      <span data-testid="auth-modal-mode">{modal.authModalMode}</span>
      <span data-testid="user-profile-modal-state">{modal.userProfileModalOpen ? 'open' : 'closed'}</span>
      <span data-testid="feedback-modal-state">{modal.feedbackModalOpen ? 'open' : 'closed'}</span>
      <span data-testid="recharge-modal-state">{modal.rechargeModalOpen ? 'open' : 'closed'}</span>
      <span data-testid="recharge-canvas-id">{modal.rechargeCanvasId ?? 'none'}</span>
      <span data-testid="upgrade-reason">{modal.upgradeModalReason ?? 'none'}</span>
      <span data-testid="admin-modal-state">{modal.adminModalOpen ? 'open' : 'closed'}</span>
      <span data-testid="my-shares-modal-state">{modal.mySharesModalOpen ? 'open' : 'closed'}</span>
      <button data-testid="btn-open-auth" onClick={() => modal.openAuthModal('signup')}>Open Auth</button>
      <button data-testid="btn-close-auth" onClick={modal.closeAuthModal}>Close Auth</button>
      <button data-testid="btn-open-profile" onClick={modal.openUserProfileModal}>Open Profile</button>
      <button data-testid="btn-close-profile" onClick={modal.closeUserProfileModal}>Close Profile</button>
      <button data-testid="btn-open-feedback" onClick={modal.openFeedbackModal}>Open Feedback</button>
      <button data-testid="btn-close-feedback" onClick={modal.closeFeedbackModal}>Close Feedback</button>
      <button data-testid="btn-open-admin" onClick={modal.openAdminModal}>Open Admin</button>
      <button data-testid="btn-close-admin" onClick={modal.closeAdminModal}>Close Admin</button>
      <button data-testid="btn-open-shares" onClick={modal.openMySharesModal}>Open Shares</button>
      <button data-testid="btn-close-shares" onClick={modal.closeMySharesModal}>Close Shares</button>
    </div>
  );
};

describe('ModalContext Empirical Stress Tests', () => {
  describe('1. Default Fallback when Consumed Outside ModalProvider', () => {
    it('returns defaultModalContextValue without throwing', () => {
      let inspectedValue: ReturnType<typeof useModal> | undefined;
      expect(() => {
        render(<TestConsumer onInspect={(val) => { inspectedValue = val; }} />);
      }).not.toThrow();

      expect(inspectedValue).toBeDefined();
      expect(inspectedValue?.authModalOpen).toBe(false);
      expect(inspectedValue?.authModalMode).toBe('signin');
      expect(inspectedValue?.userProfileModalOpen).toBe(false);
      expect(inspectedValue?.feedbackModalOpen).toBe(false);
      expect(inspectedValue?.rechargeModalOpen).toBe(false);
      expect(inspectedValue?.rechargeCanvasId).toBeUndefined();
      expect(inspectedValue?.upgradeModalReason).toBeUndefined();
      expect(inspectedValue?.adminModalOpen).toBe(false);
      expect(inspectedValue?.mySharesModalOpen).toBe(false);
    });

    it('safely invokes all fallback functions as no-ops without runtime exceptions', () => {
      let val: ReturnType<typeof useModal> | undefined;
      render(<TestConsumer onInspect={(v) => { val = v; }} />);

      expect(val).toBeDefined();
      if (!val) return;

      expect(() => val.openAuthModal()).not.toThrow();
      expect(() => val.openAuthModal('signup')).not.toThrow();
      expect(() => val.closeAuthModal()).not.toThrow();
      expect(() => val.openUserProfileModal()).not.toThrow();
      expect(() => val.closeUserProfileModal()).not.toThrow();
      expect(() => val.openFeedbackModal()).not.toThrow();
      expect(() => val.closeFeedbackModal()).not.toThrow();
      expect(() => val.openRechargeModal()).not.toThrow();
      expect(() => val.openRechargeModal('board-123')).not.toThrow();
      expect(() => val.openRechargeModal('board-123', 'reason')).not.toThrow();
      expect(() => val.closeRechargeModal()).not.toThrow();
      expect(() => val.openAdminModal()).not.toThrow();
      expect(() => val.closeAdminModal()).not.toThrow();
      expect(() => val.openMySharesModal()).not.toThrow();
      expect(() => val.closeMySharesModal()).not.toThrow();
    });

    it('matches exported defaultModalContextValue contract', () => {
      expect(defaultModalContextValue.authModalOpen).toBe(false);
      expect(defaultModalContextValue.authModalMode).toBe('signin');
      expect(typeof defaultModalContextValue.openAuthModal).toBe('function');
      expect(typeof defaultModalContextValue.closeAuthModal).toBe('function');
      expect(typeof defaultModalContextValue.openRechargeModal).toBe('function');
      expect(typeof defaultModalContextValue.closeRechargeModal).toBe('function');
    });
  });

  describe('2. ModalProvider State Transitions', () => {
    it('manages auth modal state and mode properly', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      expect(screen.getByTestId('auth-modal-state').textContent).toBe('closed');
      expect(screen.getByTestId('auth-modal-mode').textContent).toBe('signin');

      act(() => {
        modalVal?.openAuthModal('signup');
      });
      expect(screen.getByTestId('auth-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('auth-modal-mode').textContent).toBe('signup');

      act(() => {
        modalVal?.openAuthModal(); // default to signin
      });
      expect(screen.getByTestId('auth-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('auth-modal-mode').textContent).toBe('signin');

      act(() => {
        modalVal?.closeAuthModal();
      });
      expect(screen.getByTestId('auth-modal-state').textContent).toBe('closed');
    });

    it('manages user profile, feedback, admin, and my shares modals', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      // User Profile
      act(() => { modalVal?.openUserProfileModal(); });
      expect(screen.getByTestId('user-profile-modal-state').textContent).toBe('open');
      act(() => { modalVal?.closeUserProfileModal(); });
      expect(screen.getByTestId('user-profile-modal-state').textContent).toBe('closed');

      // Feedback
      act(() => { modalVal?.openFeedbackModal(); });
      expect(screen.getByTestId('feedback-modal-state').textContent).toBe('open');
      act(() => { modalVal?.closeFeedbackModal(); });
      expect(screen.getByTestId('feedback-modal-state').textContent).toBe('closed');

      // Admin
      act(() => { modalVal?.openAdminModal(); });
      expect(screen.getByTestId('admin-modal-state').textContent).toBe('open');
      act(() => { modalVal?.closeAdminModal(); });
      expect(screen.getByTestId('admin-modal-state').textContent).toBe('closed');

      // My Shares
      act(() => { modalVal?.openMySharesModal(); });
      expect(screen.getByTestId('my-shares-modal-state').textContent).toBe('open');
      act(() => { modalVal?.closeMySharesModal(); });
      expect(screen.getByTestId('my-shares-modal-state').textContent).toBe('closed');
    });
  });

  describe('3. openRechargeModal Argument Polymorphism Stress Tests', () => {
    it('handles standard convention: openRechargeModal(canvasId, reason)', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal('canvas_abc_123', '导出高清图片需要 VIP');
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('canvas_abc_123');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('导出高清图片需要 VIP');
    });

    it('handles inverted convention: openRechargeModal(reason, canvasId)', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal('导出高清图片需要 VIP', 'canvas_abc_123');
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('canvas_abc_123');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('导出高清图片需要 VIP');
    });

    it('handles single argument with canvasId (short ascii alphanumeric identifier)', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal('board_xyz_789');
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('board_xyz_789');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('none');
    });

    it('handles single argument with Chinese reason', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal('额度已耗尽，请充值');
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('none');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('额度已耗尽，请充值');
    });

    it('handles single argument with English sentence containing spaces', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal('AI reasoning quota exceeded for this session');
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('none');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('AI reasoning quota exceeded for this session');
    });

    it('handles English sentence reason when inverted: (English reason, canvasId)', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal('Upgrade required for 4K export', 'board_canvas_999');
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('board_canvas_999');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('Upgrade required for 4K export');
    });

    it('handles standard 36-char UUID canvasId with Chinese reason', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      const uuid = '123e4567-e89b-12d3-a456-426614174000'; // exactly 36 chars

      // Standard order: (uuid, reason)
      act(() => {
        modalVal?.openRechargeModal(uuid, '深度解析功能需开通会员');
      });
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe(uuid);
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('深度解析功能需开通会员');

      // Inverted order: (reason, uuid)
      act(() => {
        modalVal?.openRechargeModal('深度解析功能需开通会员', uuid);
      });
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe(uuid);
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('深度解析功能需开通会员');
    });

    it('handles openRechargeModal() with no arguments and resets correctly on close', () => {
      let modalVal: ReturnType<typeof useModal> | undefined;
      render(
        <ModalProvider>
          <TestConsumer onInspect={(v) => { modalVal = v; }} />
        </ModalProvider>
      );

      act(() => {
        modalVal?.openRechargeModal();
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('open');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('none');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('none');

      act(() => {
        modalVal?.closeRechargeModal();
      });

      expect(screen.getByTestId('recharge-modal-state').textContent).toBe('closed');
      expect(screen.getByTestId('recharge-canvas-id').textContent).toBe('none');
      expect(screen.getByTestId('upgrade-reason').textContent).toBe('none');
    });
  });

  describe('4. Isolated Component Consumption (Outside ModalProvider)', () => {
    it('allows components like UserDropdown to render and trigger callbacks without ModalProvider', async () => {
      // Mock /api/auth/me to return anonymous user
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: false, status: 401 } as Response;
        }
        return { ok: false } as Response;
      });

      const { UserDropdown } = await import('@/src/components/ui/topbar/UserDropdown');
      const { AuthProvider } = await import('@/src/context/AuthContext');

      // Render UserDropdown wrapped only in AuthProvider, strictly omitting ModalProvider
      render(
        <AuthProvider>
          <UserDropdown />
        </AuthProvider>
      );

      // Verify the login button renders
      const loginButton = await screen.findByRole('button', { name: /登录/i });
      expect(loginButton).toBeInTheDocument();

      // Triggering click executes openAuthModal() on defaultModalContextValue without throwing
      expect(() => {
        loginButton.click();
      }).not.toThrow();
    });
  });
});

