import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AuthUser, FeedbackPayload } from '../types';
import { trackEvent } from '../lib/analytics';

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
  /** 触发升级时的画板上下文（Spec K7：用于拉取当前画板节点余量） */
  rechargeCanvasId: string | null;
  upgradeModalReason: string | null;
  openRechargeModal: (reason?: string, canvasId?: string) => void;
  closeRechargeModal: () => void;
  adminModalOpen: boolean;
  openAdminModal: () => void;
  closeAdminModal: () => void;
  mySharesModalOpen: boolean;
  openMySharesModal: () => void;
  closeMySharesModal: () => void;
  refreshUser: () => Promise<void>;
  /** ADR-0022：微信登录渠道是否已配置（由 GET /api/auth/wechat/status 决定是否渲染入口） */
  wechatEnabled: boolean;
  /** 微信回调失败原因（已本地化为中文）；非空时由 AuthModal 以内联错误展示 */
  wechatError: string | null;
  clearWechatError: () => void;
  /** ADR-0023：补绑邮箱（只绑邮箱，不设密码） */
  sendBindEmailCode: (email: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  bindEmail: (email: string, code: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  /** ADR-0023：绑定流程的轻提示（成功/失败）。**与 wechatError 分开**：绑定失败不该弹登录框 */
  bindNotice: { type: 'success' | 'error'; text: string } | null;
  clearBindNotice: () => void;
}

/** 微信回调失败码 → 面向用户的文案（服务端只回可枚举的原因码，不回显微信原始 errmsg） */
const WECHAT_ERROR_MESSAGES: Record<string, string> = {
  NOT_CONFIGURED: '微信登录暂未开放，请使用邮箱登录',
  STATE: '登录会话已过期，请返回重新扫码',
  EXCHANGE: '微信授权已失效，请重新扫码',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  ACCOUNT_FROZEN: '账号已被冻结，请联系客服',
  WECHAT_IDENTITY_CONFLICT: '登录冲突，请重试',
  SERVER: '微信登录失败，请稍后重试或改用邮箱登录',
};

/**
 * 绑定流程的失败码 → 文案。**独立于上面那张表**：绑定失败时打开「登录」弹窗是错的引导
 * （用户本来就是登录状态），所以走「轻提示」而非登录弹窗。
 */
const WECHAT_BIND_ERROR_MESSAGES: Record<string, string> = {
  WECHAT_ALREADY_BOUND: '该微信已绑定其他账号，或当前账号已绑定其他微信',
  STATE: '绑定会话已过期，请重试',
  EXCHANGE: '微信授权已失效，请重试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  SERVER: '绑定失败，请稍后重试',
};

function wechatErrorMessage(code: string): string {
  return WECHAT_ERROR_MESSAGES[code] || '微信登录失败，请稍后重试或改用邮箱登录';
}

function wechatBindErrorMessage(code: string): string {
  return WECHAT_BIND_ERROR_MESSAGES[code] || '微信绑定失败，请稍后重试';
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
  // Spec K7：升级触发时的画板上下文（配额墙触发点传入，弹窗据此展示节点余量）
  const [rechargeCanvasId, setRechargeCanvasId] = useState<string | null>(null);
  const [upgradeModalReason, setUpgradeModalReason] = useState<string | null>(null);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [mySharesModalOpen, setMySharesModalOpen] = useState(false);
  // ADR-0022：微信登录渠道开关与回调失败原因
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const [wechatError, setWechatError] = useState<string | null>(null);
  // ADR-0023：绑定流程的轻提示（成功/失败），与 wechatError 分属两条通道
  const [bindNotice, setBindNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  // ADR-0022：微信登录渠道是否可用（未配置时前端不渲染入口，而不是让按钮点了报错）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/wechat/status');
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled) setWechatEnabled(Boolean(data?.enabled));
      } catch {
        // 探活失败按「不可用」处理：宁可不显示入口，也不给出一个必然失败的按钮
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * ADR-0022 / ADR-0023：消费微信回调带回的查询参数。
   *
   * 参数必须**同步**读走并从地址栏剥离，否则：
   *   1) React 18 StrictMode 在开发下会跑两遍 effect，`login_success` 会被上报两次；
   *   2) 用户手动刷新会再上报一次。
   * 剥离放在任何 `await` 之前，上述两种情况就都读不到参数了。
   * 阶段一（同步）与阶段二（异步）刻意分开写，顺序不能合并。
   *
   * ⚠️ 三个通道**不能合并**：`wechat`（登录）/ `wechat_error`（登录失败 → 弹登录框）/
   * `wechat_bind_error`（绑定失败 → 只给轻提示，**绝不弹登录框**，用户本来就是登录态）。
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('wechat');
    const errorCode = params.get('wechat_error');
    const bindErrorCode = params.get('wechat_bind_error');
    if (!ok && !errorCode && !bindErrorCode) return;

    params.delete('wechat');
    params.delete('wechat_error');
    params.delete('wechat_bind_error');
    const rest = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`
    );

    if (ok === 'ok') {
      void refreshUser();
      trackEvent('login_success'); // K4 事件 4：与邮箱登录同一漏斗节点（本路径不经过 login()，不会重复）
      return;
    }
    if (ok === 'bound') {
      // ADR-0023：绑定成功——会话未变，只需刷新用户拿到 wechat_bound
      void refreshUser();
      setBindNotice({ type: 'success', text: '微信绑定成功，之后可直接用微信扫码登录本账号' });
      return;
    }
    if (errorCode) {
      setWechatError(wechatErrorMessage(errorCode));
      setAuthModalMode('signin');
      setAuthModalOpen(true);
      return;
    }
    if (bindErrorCode) {
      void refreshUser();
      setBindNotice({ type: 'error', text: wechatBindErrorMessage(bindErrorCode) });
    }
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
      trackEvent('login_success'); // K4 事件 4：登录成功（不携带任何账号标识）
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
      trackEvent('register_success'); // K4 事件 3：注册成功（漏斗关键节点）
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
      trackEvent('register_code_sent'); // K4 事件 2：注册验证码发送成功（进入注册漏斗）
      return { success: true, message: data?.message || '验证码已发送，请查收' };
    } catch (e: any) {
      return { success: false, error: e?.message || '网络连接异常' };
    }
  };

  // ADR-0023：补绑邮箱——发码（仅占位邮箱账号可用）
  const sendBindEmailCode = async (email: string) => {
    try {
      const res = await fetch('/api/auth/bind-email/send-code', {
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

  // ADR-0023：补绑邮箱——提交（成功返回更新后的用户，直接 setUser 即可，会话未变）
  const bindEmail = async (email: string, code: string) => {
    try {
      const res = await fetch('/api/auth/bind-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { success: false, error: data?.error || '绑定失败，请稍后重试' };
      }
      if (data?.user) setUser(data.user);
      void refreshUser(); // 拉回 wechat_bound / entitlements 等派生字段
      return { success: true, message: data?.message || '邮箱绑定成功' };
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
    setWechatError(null); // 关闭即视为已读，避免下次打开弹窗再看到上一次的失败提示
  }, []);

  const clearWechatError = useCallback(() => setWechatError(null), []);
  const clearBindNotice = useCallback(() => setBindNotice(null), []);

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

  const openRechargeModal = useCallback((reason?: string, canvasId?: string) => {
    setUpgradeModalReason(reason || null);
    setRechargeCanvasId(canvasId || null);
    setRechargeModalOpen(true);
  }, []);

  const closeRechargeModal = useCallback(() => {
    setRechargeModalOpen(false);
    setRechargeCanvasId(null);
    setUpgradeModalReason(null);
  }, []);

  const openAdminModal = useCallback(() => {
    setAdminModalOpen(true);
  }, []);

  const closeAdminModal = useCallback(() => {
    setAdminModalOpen(false);
  }, []);

  const openMySharesModal = useCallback(() => {
    setMySharesModalOpen(true);
  }, []);

  const closeMySharesModal = useCallback(() => {
    setMySharesModalOpen(false);
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
        rechargeCanvasId,
        upgradeModalReason,
        openRechargeModal,
        closeRechargeModal,
        adminModalOpen,
        openAdminModal,
        closeAdminModal,
        mySharesModalOpen,
        openMySharesModal,
        closeMySharesModal,
        refreshUser,
        wechatEnabled,
        wechatError,
        clearWechatError,
        sendBindEmailCode,
        bindEmail,
        bindNotice,
        clearBindNotice,
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
