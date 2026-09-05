import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AuthUser } from '../types';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; remainingMinutes?: number }>;
  register: (email: string, password: string, name?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  recharge: (amount: number) => Promise<{ success: boolean; newBalance?: number; error?: string }>;
  updateCredits: (newBalance: number) => void;
  // Modals state
  authModalOpen: boolean;
  authModalMode: 'signin' | 'signup';
  openAuthModal: (mode?: 'signin' | 'signup') => void;
  closeAuthModal: () => void;
  rechargeModalOpen: boolean;
  openRechargeModal: () => void;
  closeRechargeModal: () => void;
  adminModalOpen: boolean;
  openAdminModal: () => void;
  closeAdminModal: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Modals
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup'>('signin');
  const [rechargeModalOpen, setRechargeModalOpen] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);

  const refreshUser = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.user) {
          setUser(data.user);
          return;
        }
      }
      setUser(null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          success: false,
          error: data.error || '登录失败',
          remainingMinutes: data.remainingMinutes,
        };
      }
      setUser(data.user);
      setAuthModalOpen(false);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  const register = async (email: string, password: string, name?: string) => {
    try {
      const res = await fetch('/api/auth/sign-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || '注册失败' };
      }
      setUser(data.user);
      setAuthModalOpen(false);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {}
    setUser(null);
  };

  const recharge = async (amount: number) => {
    try {
      const res = await fetch('/api/auth/recharge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || '充值失败' };
      }
      if (typeof data.credits_balance === 'number') {
        setUser((prev) => (prev ? { ...prev, credits_balance: data.credits_balance } : null));
      }
      return { success: true, newBalance: data.credits_balance };
    } catch (e: any) {
      return { success: false, error: e?.message || '充值异常' };
    }
  };

  const updateCredits = useCallback((newBalance: number) => {
    setUser((prev) => (prev ? { ...prev, credits_balance: newBalance } : null));
  }, []);

  const openAuthModal = useCallback((mode: 'signin' | 'signup' = 'signin') => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
  }, []);

  const openRechargeModal = useCallback(() => {
    setRechargeModalOpen(true);
  }, []);

  const closeRechargeModal = useCallback(() => {
    setRechargeModalOpen(false);
  }, []);

  const openAdminModal = useCallback(() => {
    setAdminModalOpen(true);
  }, []);

  const closeAdminModal = useCallback(() => {
    setAdminModalOpen(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        recharge,
        updateCredits,
        authModalOpen,
        authModalMode,
        openAuthModal,
        closeAuthModal,
        rechargeModalOpen,
        openRechargeModal,
        closeRechargeModal,
        adminModalOpen,
        openAdminModal,
        closeAdminModal,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
