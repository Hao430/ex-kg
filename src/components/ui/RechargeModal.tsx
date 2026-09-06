import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Crown, Check, Sparkles, X, ShieldCheck, Flame, Infinity, Layers, Network, Calendar, AlertCircle, MessageCircle } from 'lucide-react';
import { SubscriptionPlan, SubscriptionPlanId } from '../../types';

// 一期过渡支付：客服微信人工充值（微信号经 .env 的 VITE_SUPPORT_WECHAT_ID 配置，为空时公告不显示微信号）
const SUPPORT_WECHAT_ID = import.meta.env.VITE_SUPPORT_WECHAT_ID?.trim() || '';

const PLANS: SubscriptionPlan[] = [
  {
    id: 'weekly',
    name: '周度 Pro 会员',
    durationDays: 7,
    price: '¥ 9.9',
    popular: false,
    desc: '短期深度调研首选，7 天无限量 AI 思维导图推演',
    badge: '灵活体验',
  },
  {
    id: 'monthly',
    name: '月度 Pro 会员',
    durationDays: 30,
    price: '¥ 24.9',
    popular: true,
    desc: '学者与高频创作者标配，30 天无限制画板与节点探索',
    badge: '最受欢迎',
  },
  {
    id: 'yearly',
    name: '年度 Pro 会员',
    durationDays: 365,
    price: '¥ 199',
    popular: false,
    desc: '365 天全量特权，折合仅 ¥16.6/月，较月卡立省 33%',
    badge: '立省 33%',
  },
];

export const RechargeModal: React.FC = () => {
  const { user, isVip, rechargeModalOpen, closeRechargeModal, subscribe, openAuthModal, upgradeModalReason } = useAuth();
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>('monthly');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  if (!rechargeModalOpen) return null;

  const currentPlan = PLANS.find((p) => p.id === selectedPlan) || PLANS[1];

  const handleSubscribe = async () => {
    if (!user) {
      closeRechargeModal();
      openAuthModal('signin');
      return;
    }

    setLoading(true);
    setFeedback(null);
    const res = await subscribe(currentPlan.id);
    setLoading(false);

    if (res.success) {
      setFeedback(res.message || '恭喜开通 Pro 会员！');
      setTimeout(() => {
        closeRechargeModal();
        setFeedback(null);
      }, 1500);
    } else {
      setFeedback(res.error || '开通会员失败');
    }
  };

  const formatExpiry = (dateStr?: string | null) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-amber-500/10 via-indigo-500/5 to-transparent dark:from-amber-500/20 dark:via-indigo-500/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
              <Crown className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                  升级 Pro 会员订阅
                </h3>
                {isVip && (
                  <span className="px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300 rounded-full">
                    已是会员
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                订阅制畅享，开通后解锁无限画板与无限节点多轮探索
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

        {/* Upgrade Trigger Banner if present */}
        {upgradeModalReason && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">升级提示：</span>
              {upgradeModalReason}
            </div>
          </div>
        )}

        {/* WeChat manual recharge announcement (Phase 1 transitional payment) */}
        <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 flex items-start gap-2.5 text-xs text-emerald-900 dark:text-emerald-200">
          <MessageCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">充值公告：</span>
            一期支持添加客服微信人工充值，微信转账时备注<strong>注册邮箱</strong>与所购档位，站长确认到账后 VIP 即刻开通。
            {SUPPORT_WECHAT_ID && (
              <span>
                客服微信号：<span className="font-semibold">{SUPPORT_WECHAT_ID}</span>
              </span>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          {/* Current VIP status if active */}
          {isVip && user?.vip_expires_at && (
            <div className="flex items-center justify-between p-3 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-900/40 mb-4 text-xs">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
                <Calendar className="w-4 h-4 text-amber-600" />
                <span>当前会员有效期至：</span>
              </div>
              <span className="font-semibold text-amber-900 dark:text-amber-200">
                {formatExpiry(user.vip_expires_at)}
              </span>
            </div>
          )}

          {feedback && (
            <div
              className={`mb-4 p-3 rounded-xl text-xs font-medium ${
                feedback.includes('恭喜') || feedback.includes('成功')
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
              }`}
            >
              {feedback}
            </div>
          )}

          {/* Plan Selection Cards */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {PLANS.map((plan) => {
              const isSelected = selectedPlan === plan.id;
              return (
                <div
                  key={plan.id}
                  onClick={() => setSelectedPlan(plan.id)}
                  className={`relative cursor-pointer p-4 rounded-xl border text-center transition-all ${
                    isSelected
                      ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20 shadow-sm'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-white dark:bg-slate-800/80'
                  }`}
                >
                  {plan.badge && (
                    <div
                      className={`absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase shadow-sm flex items-center gap-1 ${
                        plan.popular
                          ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white'
                          : 'bg-indigo-600 text-white'
                      }`}
                    >
                      {plan.popular && <Flame className="w-2.5 h-2.5" />}
                      {plan.badge}
                    </div>
                  )}
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {plan.name}
                  </div>
                  <div className="text-xl font-extrabold text-slate-900 dark:text-white mb-1">
                    {plan.price}
                  </div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500">
                    有效期 {plan.durationDays} 天
                  </div>
                </div>
              );
            })}
          </div>

          {/* Plan Description & Feature Comparison */}
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4 border border-slate-100 dark:border-slate-800 mb-5">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-3 flex items-center justify-between">
              <span>会员权益对比</span>
              <span className="text-[11px] text-indigo-600 dark:text-indigo-400 font-normal">
                {currentPlan.desc}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                <div className="font-semibold text-slate-800 dark:text-slate-200 mb-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-400" />
                  免费版
                </div>
                <ul className="space-y-1.5 text-[11px]">
                  <li className="flex items-center gap-1.5 text-slate-500">
                    <Layers className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    最多创建 3 个独立画板
                  </li>
                  <li className="flex items-center gap-1.5 text-slate-500">
                    <Network className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    单画板限制 10 个 AI 思考节点
                  </li>
                  <li className="flex items-center gap-1.5 text-slate-400">
                    常规响应队列
                  </li>
                </ul>
              </div>

              <div className="p-2.5 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-800/60 text-slate-700 dark:text-slate-300">
                <div className="font-semibold text-indigo-900 dark:text-indigo-200 mb-2 flex items-center gap-1.5">
                  <Crown className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                  Pro 会员
                </div>
                <ul className="space-y-1.5 text-[11px]">
                  <li className="flex items-center gap-1.5 font-medium text-indigo-900 dark:text-indigo-200">
                    <Infinity className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    无限画板数量（自由归档）
                  </li>
                  <li className="flex items-center gap-1.5 font-medium text-indigo-900 dark:text-indigo-200">
                    <Infinity className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    无限 AI 节点推演与多分支探讨
                  </li>
                  <li className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    支持子分支“导出为独立画板”
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* Action button */}
          <button
            onClick={handleSubscribe}
            disabled={loading}
            className="w-full py-3 px-4 bg-gradient-to-r from-amber-500 via-indigo-600 to-indigo-700 hover:from-amber-600 hover:to-indigo-600 text-white rounded-xl text-sm font-semibold transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 cursor-pointer disabled:opacity-70"
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <Crown className="w-4 h-4 text-amber-200" />
                {isVip ? `续费 ${currentPlan.name} (${currentPlan.price})` : `立即开通 ${currentPlan.name} (${currentPlan.price})`}
              </>
            )}
          </button>

          <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              随时续费延续有效期
            </span>
            <span className="flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              开通即刻生效
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

