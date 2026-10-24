import React, { useState } from 'react';
import { Sparkles, Key, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Spinner } from '../ui/base/Spinner';
import { StatusBanner } from '../ui/base/StatusBanner';
import { extractErrorMessage } from '../../lib/api';

/**
 * /reset-password?token=... 落地页（Spec F1 找回密码第二步）
 * 独立于主应用渲染（见 main.tsx 路径分流），提交后调用 /api/auth/reset-password。
 */
export const ResetPasswordPage: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const token = new URLSearchParams(window.location.search).get('token') || '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError('重置链接无效：缺少令牌，请从邮件中重新打开链接');
      return;
    }
    if (password.length < 6) {
      setError('新密码长度至少为 6 位');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        setError(await extractErrorMessage(res, '重置失败，请稍后重试'));
      } else {
        setSuccess(true);
      }
    } catch {
      setError('网络连接异常，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md bg-slate-900 rounded-2xl shadow-2xl border border-slate-800 overflow-hidden text-slate-100">
        <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold shadow-sm">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-semibold">重置密码</h3>
            <p className="text-xs text-slate-400">枝想 AI 账户安全中心</p>
          </div>
        </div>

        <div className="p-6">
          {error && (
            <StatusBanner
              type="error"
              unstyled
              icon={<AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
              className="mb-4 p-3 rounded-xl bg-rose-950/60 border border-rose-900/60 text-xs text-rose-300"
            >
              <p className="font-medium">{error}</p>
            </StatusBanner>
          )}

          {success ? (
            <div className="text-center py-4 space-y-4">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
              <div className="space-y-1">
                <p className="text-sm font-medium">密码已重置</p>
                <p className="text-xs text-slate-400">请使用新密码重新登录，旧会话已全部失效。</p>
              </div>
              <a
                href="/"
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition"
              >
                <Mail className="w-3.5 h-3.5" />
                去登录
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">新密码</label>
                <div className="relative">
                  <Key className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="至少 6 位安全字符"
                    autoComplete="new-password"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">确认新密码</label>
                <div className="relative">
                  <Key className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="再次输入新密码"
                    autoComplete="new-password"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-xl text-sm font-medium transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <Spinner size="md" />
                ) : (
                  <>
                    <Key className="w-4 h-4" />
                    重置密码
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * /verify-email?token=... 落地页（Spec D3 邮箱验证）
 * 调用 GET /api/auth/verify-email 并展示结果。
 */
export const VerifyEmailPage: React.FC = () => {
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>(() => 'pending');
  const [message, setMessage] = useState('');
  // Spec D3：错误态提供重发验证邮件入口（独立页面无 AuthProvider，直接裸 fetch）
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  React.useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    if (!token) {
      setStatus('error');
      setMessage('链接无效：缺少验证令牌，请从邮件中重新打开链接');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
          credentials: 'include',
        });
        if (!res.ok) {
          setStatus('error');
          setMessage(await extractErrorMessage(res, '验证链接无效或已过期'));
          return;
        }
        const data = await res.json().catch(() => null) as { message?: string } | null;
        setStatus('success');
        setMessage(data?.message || '邮箱验证成功');
      } catch {
        setStatus('error');
        setMessage('网络连接异常，请稍后重试');
      }
    })();
  }, []);

  const handleResend = async () => {
    setResendMessage(null);
    setResendState('sending');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setResendState('sent');
        setResendMessage(data?.message || '验证邮件已重新发送，请查收（注意检查垃圾邮件）');
        return;
      }
      setResendState('idle');
      if (res.status === 401) {
        setResendMessage('请先登录后再重发验证邮件');
      } else if (data?.code === 'EMAIL_ALREADY_VERIFIED') {
        // body 还要取 code（已验证特判），不走 extractErrorMessage 二次消费
        setResendMessage('该邮箱已完成验证，可直接返回首页登录');
      } else {
        setResendMessage(data?.error || '发送失败，请稍后重试');
      }
    } catch {
      setResendState('idle');
      setResendMessage('网络连接异常，请稍后重试');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md bg-slate-900 rounded-2xl shadow-2xl border border-slate-800 overflow-hidden text-slate-100">
        <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold shadow-sm">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-semibold">邮箱验证</h3>
            <p className="text-xs text-slate-400">枝想 AI 账户安全中心</p>
          </div>
        </div>
        <div className="p-6 text-center py-8 space-y-4">
          {status === 'pending' && <Spinner size="xl" className="text-indigo-400 mx-auto" />}
          {status === 'success' && <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />}
          {status === 'error' && <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />}
          <p className="text-sm text-slate-300">{message || '正在验证邮箱...'}</p>
          {status === 'error' && (
            <div className="space-y-2">
              {resendState !== 'sent' ? (
                <button
                  type="button"
                  onClick={() => void handleResend()}
                  disabled={resendState === 'sending'}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 rounded-lg transition disabled:opacity-50"
                >
                  {resendState === 'sending' ? (
                    <Spinner size="sm" />
                  ) : (
                    <Mail className="w-3.5 h-3.5" />
                  )}
                  重新发送验证邮件
                </button>
              ) : (
                <p className="text-xs text-emerald-400">{resendMessage}</p>
              )}
              {resendState !== 'sent' && resendMessage && (
                <p className="text-xs text-slate-400">{resendMessage}</p>
              )}
            </div>
          )}
          {status !== 'pending' && (
            <a href="/" className="inline-flex text-xs font-medium text-indigo-400 hover:text-indigo-300">
              返回首页
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
