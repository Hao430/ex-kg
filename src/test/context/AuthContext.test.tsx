import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from '@/src/context/AuthContext';
import { AuthUser } from '@/src/types';

// Mock analytics trackEvent to avoid side effects
vi.mock('@/src/lib/analytics', () => ({
  trackEvent: vi.fn(),
}));

const AuthConsumer: React.FC<{
  onInspect?: (val: ReturnType<typeof useAuth>) => void;
}> = ({ onInspect }) => {
  const auth = useAuth();
  if (onInspect) {
    onInspect(auth);
  }
  return (
    <div>
      <span data-testid="auth-loading">{auth.loading ? 'loading' : 'ready'}</span>
      <span data-testid="auth-user-id">{auth.user?.id ?? 'anonymous'}</span>
      <span data-testid="auth-user-email">{auth.user?.email ?? 'none'}</span>
      <span data-testid="auth-user-role">{auth.user?.role ?? 'none'}</span>
      <span data-testid="auth-is-vip">{auth.isVip ? 'vip' : 'standard'}</span>
    </div>
  );
};

describe('AuthContext Empirical Stress Tests', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('1. Hook Safety and Boundary Constraint', () => {
    it('throws descriptive error if useAuth is consumed outside AuthProvider', () => {
      // Suppress React boundary console.error for expected thrown error
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<AuthConsumer />);
      }).toThrow('useAuth must be used within an AuthProvider');

      consoleError.mockRestore();
    });

    it('verifies AuthContext is strictly decoupled from ModalContext and tickets', async () => {
      // Modal-related fields must NOT exist on AuthContextType
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      let authVal: any;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });

      expect(authVal.authModalOpen).toBeUndefined();
      expect(authVal.openAuthModal).toBeUndefined();
      expect(authVal.rechargeModalOpen).toBeUndefined();
      expect(authVal.openRechargeModal).toBeUndefined();
      expect(authVal.feedbackModalOpen).toBeUndefined();
      expect(authVal.openFeedbackModal).toBeUndefined();
      expect(authVal.adminModalOpen).toBeUndefined();
      expect(authVal.openAdminModal).toBeUndefined();
      expect(authVal.mySharesModalOpen).toBeUndefined();
      expect(authVal.openMySharesModal).toBeUndefined();
      expect(authVal.userProfileModalOpen).toBeUndefined();
      expect(authVal.openUserProfileModal).toBeUndefined();
      expect(authVal.submitFeedback).toBeUndefined();
      expect(authVal.listMyFeedbacks).toBeUndefined();
    });
  });

  describe('2. Initial Mount & refreshUser', () => {
    it('initializes with loading: false and null user when /api/auth/me returns 401', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: false, status: 401 } as Response;
        }
        return { ok: false } as Response;
      });

      render(
        <AuthProvider>
          <AuthConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });
      expect(screen.getByTestId('auth-user-id').textContent).toBe('anonymous');
      expect(screen.getByTestId('auth-is-vip').textContent).toBe('standard');
    });

    it('initializes with user and calculates isVip correctly', async () => {
      const mockVipUser: AuthUser = {
        id: 'usr-1',
        email: 'vip@example.com',
        role: 'vip',
        name: 'VIP User',
        created_at: '2026-01-01',
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ user: mockVipUser }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      render(
        <AuthProvider>
          <AuthConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });
      expect(screen.getByTestId('auth-user-id').textContent).toBe('usr-1');
      expect(screen.getByTestId('auth-user-email').textContent).toBe('vip@example.com');
      expect(screen.getByTestId('auth-is-vip').textContent).toBe('vip');
    });

    it('recognizes admin role and active vip_expires_at as isVip', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const mockUserWithExpiration: AuthUser = {
        id: 'usr-2',
        email: 'timevip@example.com',
        name: 'Timed VIP',
        role: 'user',
        vip_expires_at: futureDate,
        created_at: '2026-01-01',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ user: mockUserWithExpiration }),
      } as Response);

      render(
        <AuthProvider>
          <AuthConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-is-vip').textContent).toBe('vip');
      });
    });

    it('treats hard-locked VIP (role=vip, entitlements.plan=trial) as NOT vip', async () => {
      // 权益以服务端 entitlements 为权威：role 列不随后过期翻转，
      // 超 7 天宽限期的用户（plan 降 trial + vipExpired）绝不能再按 role 短路显示 VIP
      const mockHardLockedUser: AuthUser = {
        id: 'usr-3',
        email: 'locked@example.com',
        name: 'Locked VIP',
        role: 'vip',
        vip_expires_at: new Date(Date.now() - 30 * 86400000).toISOString(),
        entitlements: { plan: 'trial', vipExpired: true, boardLimit: 3, nodeLimit: 10 },
        created_at: '2026-01-01',
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ user: mockHardLockedUser }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      render(
        <AuthProvider>
          <AuthConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });
      expect(screen.getByTestId('auth-is-vip').textContent).toBe('standard');
    });

    it('keeps grace-period VIP (plan=vip + vipExpired) as vip', async () => {
      // 宽限期内体验不中断仅提醒：徽章保持 VIP，由横幅负责提示续费
      const mockGraceUser: AuthUser = {
        id: 'usr-4',
        email: 'grace@example.com',
        name: 'Grace VIP',
        role: 'vip',
        vip_expires_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        entitlements: { plan: 'vip', vipExpired: true, vipGraceDaysRemaining: 4, boardLimit: null, nodeLimit: null },
        created_at: '2026-01-01',
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ user: mockGraceUser }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      render(
        <AuthProvider>
          <AuthConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });
      expect(screen.getByTestId('auth-is-vip').textContent).toBe('vip');
    });
  });

  describe('3. Login & Session Lifecycle', () => {
    it('executes login successfully and updates user state', async () => {
      const loggedInUser: AuthUser = {
        id: 'usr-login-1',
        email: 'login@test.com',
        name: 'Login User',
        role: 'user',
        created_at: '2026-10-10',
      };

      let sessionActive = false;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          if (sessionActive) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ user: loggedInUser }),
            } as Response;
          }
          return { ok: false, status: 401 } as Response;
        }
        if (url === '/api/auth/sign-in') {
          sessionActive = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ user: loggedInUser }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });

      let loginRes: any;
      await act(async () => {
        loginRes = await authVal?.login('login@test.com', 'password123');
      });

      expect(loginRes).toEqual({ success: true });
      await waitFor(() => {
        expect(screen.getByTestId('auth-user-id').textContent).toBe('usr-login-1');
      });
    });

    it('returns server error message on login failure', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: false, status: 401 } as Response;
        }
        if (url === '/api/auth/sign-in') {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: '邮箱或密码错误', remainingMinutes: 10 }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });

      let loginRes: any;
      await act(async () => {
        loginRes = await authVal?.login('wrong@test.com', 'badpass');
      });

      expect(loginRes).toEqual({
        success: false,
        error: '邮箱或密码错误',
        remainingMinutes: 10,
      });
      expect(screen.getByTestId('auth-user-id').textContent).toBe('anonymous');
    });

    it('handles network failure during login gracefully without uncaught exceptions', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: false, status: 401 } as Response;
        }
        if (url === '/api/auth/sign-in') {
          throw new Error('Connection refused');
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });

      let loginRes: any;
      await act(async () => {
        loginRes = await authVal?.login('test@test.com', 'pass');
      });

      expect(loginRes).toEqual({
        success: false,
        error: 'Connection refused',
      });
    });
  });

  describe('4. Registration & Code Verification Functions', () => {
    it('executes register successfully and sets user', async () => {
      const newUser: AuthUser = {
        id: 'usr-new-1',
        email: 'new@test.com',
        role: 'user',
        name: 'Newbie',
        created_at: '2026-10-10',
      };

      let sessionActive = false;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          if (sessionActive) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ user: newUser }),
            } as Response;
          }
          return { ok: false, status: 401 } as Response;
        }
        if (url === '/api/auth/sign-up') {
          sessionActive = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ user: newUser }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });

      let regRes: any;
      await act(async () => {
        regRes = await authVal?.register('new@test.com', 'pwd123', 'Newbie', '123456');
      });

      expect(regRes).toEqual({ success: true });
      await waitFor(() => {
        expect(screen.getByTestId('auth-user-id').textContent).toBe('usr-new-1');
      });
    });

    it('executes sendRegisterCode successfully', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') return { ok: false, status: 401 } as Response;
        if (url === '/api/auth/send-register-code') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: '验证码已发送，请查收' }),
          } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('ready');
      });

      let codeRes: any;
      await act(async () => {
        codeRes = await authVal?.sendRegisterCode('new@test.com');
      });

      expect(codeRes).toEqual({
        success: true,
        message: '验证码已发送，请查收',
      });
    });
  });

  describe('5. Profile Update, Password Change, Resend Verification, and Logout', () => {
    it('executes updateProfile and reflects changes in state', async () => {
      const initialUser: AuthUser = {
        id: 'usr-profile',
        email: 'prof@test.com',
        role: 'user',
        name: 'Old Name',
        created_at: '2026-10-10',
      };
      const updatedUser: AuthUser = {
        ...initialUser,
        name: 'New Name',
        avatar: 'https://example.com/avatar.png',
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: true, status: 200, json: async () => ({ user: initialUser }) } as Response;
        }
        if (url === '/api/auth/profile') {
          return { ok: true, status: 200, json: async () => ({ user: updatedUser }) } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-user-id').textContent).toBe('usr-profile');
      });

      let profileRes: any;
      await act(async () => {
        profileRes = await authVal?.updateProfile({ name: 'New Name', avatar: 'https://example.com/avatar.png' });
      });

      expect(profileRes).toEqual({ success: true });
      expect(authVal?.user?.name).toBe('New Name');
    });

    it('executes changePassword and signs out user locally', async () => {
      const activeUser: AuthUser = {
        id: 'usr-pwd',
        email: 'pwd@test.com',
        name: 'Password User',
        role: 'user',
        created_at: '2026-10-10',
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: true, status: 200, json: async () => ({ user: activeUser }) } as Response;
        }
        if (url === '/api/auth/change-password') {
          return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-user-id').textContent).toBe('usr-pwd');
      });

      let pwdRes: any;
      await act(async () => {
        pwdRes = await authVal?.changePassword('oldPass123', 'newPass456');
      });

      expect(pwdRes).toEqual({ success: true });
      // User must be cleared after password change
      expect(screen.getByTestId('auth-user-id').textContent).toBe('anonymous');
    });

    it('executes resendVerification successfully', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: true, status: 200, json: async () => ({ user: { id: 'u1', email: 'v@t.com' } }) } as Response;
        }
        if (url === '/api/auth/resend-verification') {
          return { ok: true, status: 200, json: async () => ({ message: '验证邮件已重新发送' }) } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-user-id').textContent).toBe('u1');
      });

      let resendRes: any;
      await act(async () => {
        resendRes = await authVal?.resendVerification();
      });

      expect(resendRes).toEqual({
        success: true,
        message: '验证邮件已重新发送',
      });
    });

    it('executes logout and resets user state to null', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') {
          return { ok: true, status: 200, json: async () => ({ user: { id: 'u1', email: 'v@t.com' } }) } as Response;
        }
        if (url === '/api/auth/sign-out') {
          return { ok: true, status: 200 } as Response;
        }
        return { ok: false } as Response;
      });

      let authVal: ReturnType<typeof useAuth> | undefined;
      render(
        <AuthProvider>
          <AuthConsumer onInspect={(v) => { authVal = v; }} />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-user-id').textContent).toBe('u1');
      });

      await act(async () => {
        await authVal?.logout();
      });

      expect(screen.getByTestId('auth-user-id').textContent).toBe('anonymous');
    });
  });
});
