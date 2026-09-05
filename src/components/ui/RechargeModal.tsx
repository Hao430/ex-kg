import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Coins, Zap, Check, Sparkles, X, ShieldCheck, Flame } from 'lucide-react';

const PACKAGES = [
  {
    id: 'starter',
    name: '敏捷探索包',
    points: 10000,
    price: '¥ 9.9',
    popular: false,
    desc: '适合初次体验，约可发起 30~50 次深度追问',
  },
  {
    id: 'pro',
    name: '学术智囊包',
    points: 50000,
    price: '¥ 39.0',
    popular: true,
    desc: '深度科研首选，约可生成 200 次大模型多轮思考',
  },
  {
    id: 'master',
    name: '企业智库包',
    points: 200000,
    price: '¥ 129.0',
    popular: false,
    desc: '全栈高阶知识图谱推演，支持多画布长上下文',
  },
];

export const RechargeModal: React.FC = () => {
  const { user, rechargeModalOpen, closeRechargeModal, recharge, openAuthModal } = useAuth();
  const [selectedPkg, setSelectedPkg] = useState(PACKAGES[1].id);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  if (!rechargeModalOpen) return null;

  const currentPkg = PACKAGES.find((p) => p.id === selectedPkg) || PACKAGES[1];

  const handleRecharge = async () => {
    if (!user) {
      closeRechargeModal();
      openAuthModal('signin');
      return;
    }

    setLoading(true);
    setFeedback(null);
    const res = await recharge(currentPkg.points);
    setLoading(false);

    if (res.success) {
      setFeedback(`充值成功！已到账 ${currentPkg.points.toLocaleString()} 点 AI 算力。`);
      setTimeout(() => {
        closeRechargeModal();
        setFeedback(null);
      }, 1200);
    } else {
      setFeedback(res.error || '充值失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500 text-white flex items-center justify-center font-bold text-base shadow-sm">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                AI 算力点数充值中心
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                实时扣费透明公开，1 Token ≈ 1 算力点
              </p>
            </div>
          </div>
          <button
            onClick={closeRechargeModal}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {/* Current Balance Bar */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 mb-5">
            <div className="flex items-center gap-2">
              <Coins className="w-4 h-4 text-amber-500" />
              <span className="text-xs text-slate-600 dark:text-slate-300">当前可用算力：</span>
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <span>{user ? user.credits_balance.toLocaleString() : 0}</span>
              <span className="text-xs font-normal text-slate-400">点</span>
            </div>
          </div>

          {feedback && (
            <div
              className={`mb-4 p-3 rounded-xl text-xs font-medium ${
                feedback.includes('成功')
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
              }`}
            >
              {feedback}
            </div>
          )}

          {/* Package Cards */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            {PACKAGES.map((pkg) => {
              const isSelected = selectedPkg === pkg.id;
              return (
                <div
                  key={pkg.id}
                  onClick={() => setSelectedPkg(pkg.id)}
                  className={`relative cursor-pointer p-4 rounded-xl border text-center transition-all ${
                    isSelected
                      ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30 ring-2 ring-indigo-500/20'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-white dark:bg-slate-850'
                  }`}
                >
                  {pkg.popular && (
                    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-indigo-600 text-white text-[10px] font-semibold tracking-wider uppercase shadow-sm flex items-center gap-1">
                      <Flame className="w-2.5 h-2.5" />
                      超值
                    </div>
                  )}
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {pkg.name}
                  </div>
                  <div className="text-lg font-bold text-slate-900 dark:text-white mb-0.5">
                    {pkg.points >= 10000 ? `${pkg.points / 10000}万` : pkg.points}
                    <span className="text-xs font-normal text-slate-500 ml-0.5">点</span>
                  </div>
                  <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                    {pkg.price}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 mb-6 bg-slate-50 dark:bg-slate-800/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800/60">
            <span className="font-semibold text-slate-700 dark:text-slate-300">当前选定：</span>{' '}
            {currentPkg.desc}
          </div>

          {/* Action button */}
          <button
            onClick={handleRecharge}
            disabled={loading}
            className="w-full py-2.5 px-4 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white rounded-xl text-sm font-medium transition-all shadow-sm flex items-center justify-center gap-2"
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <Zap className="w-4 h-4" />
                立即充值 {currentPkg.price} (测试环境即刻到账)
              </>
            )}
          </button>

          <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              商业级事务隔离
            </span>
            <span className="flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              永不过期
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
