import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AuthUser, FeedbackPayload } from '../types';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  isVip: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; remainingMinutes?: number }>;
  register: (email: string, password: string, name: string | undefined, code: string) => Promise<{ success: boolean; error?: string }>;
  sendRegisterCode: (email: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  logout: () => Promise<void>;
  updateProfile: (data: { name?: string; avatar?: string }) => Promise<{ success: boolean; error?: string }>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  resendVerification: () => Promise<{ success: boolean; message?: string; error?: string }>;
  submitFeedback: (data: FeedbackPayload) => Promise<{ success: boolean; message?: string; error?: string }>;
  // Modals state
  authModalOpen: boolean;
  authModalMode: 'signin' | 'signup';
  openAuthModal: (mode?: 'signin' | 'signup') => void;
  closeAuthModal: () => void;
  userProfileModalOpen: boolean;
  openUserProfileModal: () => void;
  closeUserProfileModal: () => void;
  feedbackModalOpen: boolean;
  openFeedbackModal: () => void;
  closeFeedbackModal: () => void;
  rechargeModalOpen: boolean;
  upgradeModalReason: string | null;
  openRechargeModal: (reason?: string) => void;
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
  const [userProfileModalOpen, setUserProfileModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [rechargeModalOpen, setRechargeModalOpen] = useState(false);
  const [upgradeModalReason, setUpgradeModalReason] = useState<string | null>(null);
  const [adminModalOpen, setAdminModalOpen] = useState(false);

  // Determine VIP active status
  const isVip = Boolean(
    user &&
      (user.role === 'admin' ||
        user.role === 'vip' ||
        (user.vip_expires_at && new Date(user.vip_expires_at).getTime() > Date.now()))
  );

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
      void refreshUser(); // 拉取 entitlements（Spec B3/B4）
      setAuthModalOpen(false);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  // 注册（验证码先行：需先 sendRegisterCode 获取 6 位验证码，后端校验通过才建号，出生即 email_verified=true）
  const register = async (email: string, password: string, name: string | undefined, code: string) => {
    try {
      const res = await fetch('/api/auth/sign-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, name, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || '注册失败' };
      }
      setUser(data.user);
      void refreshUser(); // 拉取 entitlements（Spec B3/B4）
      setAuthModalOpen(false);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  // 发送注册邮箱验证码（409 已注册 / 429 冷却限流 / 400 校验失败的消息直接透出）
  const sendRegisterCode = async (email: string) => {
    try {
      const res = await fetch('/api/auth/send-register-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { success: false, error: data?.error || '发送失败，请稍后重试' };
      }
      return { success: true, message: data?.message || '验证码已发送，请查收' };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  const updateProfile = async (data: { name?: string; avatar?: string }) => {
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      const resData = await res.json();
      if (!res.ok) {
        return { success: false, error: resData.error || '更新失败' };
      }
      if (resData.user) {
        setUser(resData.user);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  const changePassword = async (oldPassword: string, newPassword: string) => {
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || '修改密码失败' };
      }
      // 服务端已踢全部会话，前端同步登出
      setUser(null);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  // Spec D3：重发验证邮件（需已登录；后端限流 3 次/10 分钟）
  const resendVerification = async () => {
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { success: false, error: data?.error || '发送失败，请稍后重试' };
      }
      return { success: true, message: data?.message || '验证邮件已重新发送，请查收' };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  const submitFeedback = async (payload: FeedbackPayload) => {
    try {
      const res = await fetch('/api/auth/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || '提交反馈失败' };
      }
      return { success: true, message: data.message };
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

  const openAuthModal = useCallback((mode: 'signin' | 'signup' = 'signin') => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
  }, []);

  const openUserProfileModal = useCallback(() => {
    setUserProfileModalOpen(true);
  }, []);

  const closeUserProfileModal = useCallback(() => {
    setUserProfileModalOpen(false);
  }, []);

  const openFeedbackModal = useCallback(() => {
    setFeedbackModalOpen(true);
  }, []);

  const closeFeedbackModal = useCallback(() => {
    setFeedbackModalOpen(false);
  }, []);

  const openRechargeModal = useCallback((reason?: string) => {
    setUpgradeModalReason(reason || null);
    setRechargeModalOpen(true);
  }, []);

  const closeRechargeModal = useCallback(() => {
    setRechargeModalOpen(false);
    setUpgradeModalReason(null);
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
        isVip,
        login,
        register,
        sendRegisterCode,
        logout,
        updateProfile,
        changePassword,
        resendVerification,
        submitFeedback,
        authModalOpen,
        authModalMode,
        openAuthModal,
        closeAuthModal,
        userProfileModalOpen,
        openUserProfileModal,
        closeUserProfileModal,
        feedbackModalOpen,
        openFeedbackModal,
        closeFeedbackModal,
        rechargeModalOpen,
        upgradeModalReason,
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
