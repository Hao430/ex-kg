import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { LogIn, UserPlus, Sparkles, Key, Mail, AlertCircle, X, CheckCircle2, ArrowLeft, ShieldCheck } from 'lucide-react';
import { Modal } from '../ui/base/Modal';
import { Spinner } from '../ui/base/Spinner';
import { StatusBanner } from '../ui/base/StatusBanner';
import { extractErrorMessage } from '../../lib/api';

export interface AuthModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  authModalMode?: 'signin' | 'signup';
  onSuccess?: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
  authModalMode: propAuthModalMode,
  onSuccess,
}) => {
  const auth = useAuth();
  const modal = useModal();
  const isOpen = propIsOpen ?? modal.authModalOpen;
  const onClose = propOnClose ?? modal.closeAuthModal;
  const authModalMode = propAuthModalMode ?? modal.authModalMode;
  const { login, register, sendRegisterCode } = auth;
  const { openAuthModal } = modal;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  // 注册验证码（验证先行才建号）
  const [code, setCode] = useState('');
  const [codeSending, setCodeSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null);
  const [view, setView] = useState<'auth' | 'forgot'>('auth');
  const [forgotSent, setForgotSent] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setView('auth');
      setForgotSent(false);
      setError(null);
      setLockoutMinutes(null);
      setCode('');
      setCooldown(0);
    }
  }, [isOpen, authModalMode]);

  // 60s 重发倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const isSignUp = authModalMode === 'signup';

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setError(await extractErrorMessage(res, '发送失败，请稍后重试'));
      } else {
        setForgotSent(true);
      }
    } catch {
      setError('网络连接异常，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendCode = async () => {
    setError(null);
    if (!email || !email.includes('@')) {
      setError('请先填写有效的邮箱地址');
      return;
    }
    setCodeSending(true);
    try {
      const res = await sendRegisterCode(email.trim());
      if (res.success) {
        setCooldown(60);
      } else {
        setError(res.error || '发送失败，请稍后重试');
      }
    } finally {
      setCodeSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setLockoutMinutes(null);

    if (isSignUp) {
      const res = await register(email, password, name || undefined, code);
      setSubmitting(false);
      if (!res.success) {
        setError(res.error || '注册失败');
      } else {
        onSuccess?.();
        onClose();
      }
    } else {
      const res = await login(email, password);
      setSubmitting(false);
      if (!res.success) {
        setError(res.error || '登录失败');
        if (res.remainingMinutes) {
          setLockoutMinutes(res.remainingMinutes);
        }
      } else {
        onSuccess?.();
        onClose();
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      showCloseButton={false}
      className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden p-0"
    >
      <div id="auth-modal-container" className="flex flex-col w-full">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {isSignUp ? '注册 枝想 AI 账户' : '登录 枝想 AI 工作台'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isSignUp ? '注册即可开始无限画板深度探索' : '你的画板数据独立安全，仅自己可见'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6">
          {view === 'forgot' ? (
            <>
              {error && (
                <StatusBanner
                  type="error"
                  unstyled
                  icon={<AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                  className="mb-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-xs text-rose-700 dark:text-rose-300"
                >
                  <p className="font-medium">{error}</p>
                </StatusBanner>
              )}

              {forgotSent ? (
                <div className="text-center py-4 space-y-4">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">重置邮件已发送</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      若该邮箱已注册，重置链接已发送，请前往邮箱查收（注意检查垃圾邮件）。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setView('auth');
                      setForgotSent(false);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    返回登录
                  </button>
                </div>
              ) : (
                <>
                  <div className="mb-4 space-y-1">
                    <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">找回密码</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      输入注册邮箱，我们将发送密码重置链接。
                    </p>
                  </div>
                  <form onSubmit={handleForgotSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        注册邮箱
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                          type="email"
                          required
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="name@example.com"
                          className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-sm font-medium transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {submitting ? (
                        <Spinner size="md" className="text-white" />
                      ) : (
                        <>
                          <Mail className="w-4 h-4" />
                          发送重置链接
                        </>
                      )}
                    </button>
                  </form>
                  <div className="mt-4 text-center">
                    <button
                      type="button"
                      onClick={() => setView('auth')}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      返回登录
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
          <>
          {error && (
            <StatusBanner
              type="error"
              unstyled
              icon={<AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
              className="mb-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-xs text-rose-700 dark:text-rose-300"
            >
              <p className="font-medium">{error}</p>
              {lockoutMinutes && (
                <p className="mt-1 text-rose-600 dark:text-rose-400">
                  账户触发防爆破机制，请于 {lockoutMinutes} 分钟后再尝试。
                </p>
              )}
            </StatusBanner>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  显示昵称 (可选)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    autoComplete="nickname"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：苏格拉底探索者"
                    className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                登录邮箱
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                <span className="flex items-center justify-between">
                  <span>账户密码</span>
                  {!isSignUp && (
                    <button
                      type="button"
                      onClick={() => {
                        setView('forgot');
                        setError(null);
                      }}
                      className="font-normal text-xxs text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                    >
                      忘记密码?
                    </button>
                  )}
                </span>
              </label>
              <div className="relative">
                <Key className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  required
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位安全字符"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400"
                />
              </div>
            </div>

            {isSignUp && (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  邮箱验证码
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <ShieldCheck className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      inputMode="numeric"
                      required
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="6 位数字验证码"
                      autoComplete="one-time-code"
                      className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400 tracking-widest"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSendCode()}
                    disabled={cooldown > 0 || codeSending}
                    className="shrink-0 px-3 py-2 text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-xl transition-colors disabled:opacity-50"
                  >
                    {codeSending ? '发送中…' : cooldown > 0 ? `${cooldown}s 后重发` : '发送验证码'}
                  </button>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-sm font-medium transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? (
                <Spinner size="md" className="text-white" />
              ) : isSignUp ? (
                <>
                  <UserPlus className="w-4 h-4" />
                  立即注册，开启探索之旅
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  安全登录
                </>
              )}
            </button>
          </form>

          {/* Toggle Tab */}
          <div className="mt-4 text-center">
            {isSignUp ? (
              <p className="text-xs text-slate-500">
                已有账号？{' '}
                <button
                  type="button"
                  onClick={() => openAuthModal('signin')}
                  className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 underline underline-offset-2"
                >
                  前往登录
                </button>
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                还没有账号？{' '}
                <button
                  type="button"
                  onClick={() => openAuthModal('signup')}
                  className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 underline underline-offset-2"
                >
                  免费注册
                </button>
              </p>
            )}
          </div>
          </>
          )}
        </div>
      </div>
    </Modal>
  );
};
