import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { LogIn, UserPlus, Shield, Sparkles, Key, Mail, AlertCircle, X, CheckCircle2 } from 'lucide-react';

export const AuthModal: React.FC = () => {
  const { authModalOpen, authModalMode, closeAuthModal, login, register, openAuthModal } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null);

  if (!authModalOpen) return null;

  const isSignUp = authModalMode === 'signup';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setLockoutMinutes(null);

    if (isSignUp) {
      const res = await register(email, password, name);
      setSubmitting(false);
      if (!res.success) {
        setError(res.error || '注册失败');
      }
    } else {
      const res = await login(email, password);
      setSubmitting(false);
      if (!res.success) {
        setError(res.error || '登录失败');
        if (res.remainingMinutes) {
          setLockoutMinutes(res.remainingMinutes);
        }
      }
    }
  };

  const fillQuickAccount = (quickEmail: string, quickPass: string) => {
    setEmail(quickEmail);
    setPassword(quickPass);
    setError(null);
    setLockoutMinutes(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {isSignUp ? '注册 枝想 AI 账户' : '登录 枝想 AI 商业工作台'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isSignUp ? '注册即可开始无限画板深度探索' : '多租户沙箱隔离与商业级会话鉴权'}
              </p>
            </div>
          </div>
          <button
            onClick={closeAuthModal}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-700 dark:text-rose-300">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{error}</p>
                {lockoutMinutes && (
                  <p className="mt-1 text-rose-600 dark:text-rose-400">
                    账户触发防爆破机制，请于 {lockoutMinutes} 分钟后再尝试。
                  </p>
                )}
              </div>
            </div>
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
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                账户密码
              </label>
              <div className="relative">
                <Key className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位安全字符"
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
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
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

          {/* Quick Demo Pre-seed Accounts (Spec Requirement) */}
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                <Shield className="w-3 h-3 text-indigo-500" />
                验收测试内置账号 (1键填充)
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  fillQuickAccount('admin@deepdive.ai', 'Admin123456!');
                  openAuthModal('signin');
                }}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/60 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 hover:bg-purple-100 transition-colors text-left"
              >
                <div className="font-semibold text-[11px]">系统管理员</div>
                <div className="text-[10px] opacity-75 truncate">admin@deepdive.ai</div>
              </button>
              <button
                type="button"
                onClick={() => {
                  fillQuickAccount('vip@deepdive.ai', 'Vip123456!');
                  openAuthModal('signin');
                }}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 transition-colors text-left"
              >
                <div className="font-semibold text-[11px]">VIP 高级智囊</div>
                <div className="text-[10px] opacity-75 truncate">vip@deepdive.ai</div>
              </button>
              <button
                type="button"
                onClick={() => {
                  fillQuickAccount('user@deepdive.ai', 'User123456!');
                  openAuthModal('signin');
                }}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 transition-colors text-left"
              >
                <div className="font-semibold text-[11px]">普通探索者</div>
                <div className="text-[10px] opacity-75 truncate">user@deepdive.ai</div>
              </button>
            </div>
          </div>

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
        </div>
      </div>
    </div>
  );
};
