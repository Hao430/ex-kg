import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { Crown, Check, Sparkles, X, ShieldCheck, Flame, Infinity, Layers, Network, Calendar, AlertCircle, Loader2 } from 'lucide-react';
import { Modal } from './base/Modal';
import { SubscriptionPlan, SubscriptionPlanId } from '../../types';

/** GET /api/quota 返回的余量形状（Spec J2/K7，仅取本弹窗所需字段） */
interface QuotaInfo {
  plan: 'trial' | 'vip' | 'admin';
  board: { used: number; limit: number | null };
  node: { used: number; limit: number | null; remaining: number | null } | null;
  vipOnlyModelCount: number;
}

/** 配额接口失败时的兜底口径（与服务端 BOARD_LIMIT/NODE_LIMIT 常量一致） */
const FALLBACK_BOARD_LIMIT = 3;
const FALLBACK_NODE_LIMIT = 10;

/** 在线支付轮询参数（ADR-0014）：3s 间隔、5 分钟超时；到账判定以服务端为准 */
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type PayStage = 'idle' | 'creating' | 'awaiting' | 'paid';

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
];

export interface RechargeModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  rechargeCanvasId?: string;
  upgradeModalReason?: string;
}

export const RechargeModal: React.FC<RechargeModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
  rechargeCanvasId: propRechargeCanvasId,
  upgradeModalReason: propUpgradeModalReason,
}) => {
  const { user, isVip, refreshUser } = useAuth();
  const modal = useModal();
  const isOpen = propIsOpen ?? modal.rechargeModalOpen;
  const onClose = propOnClose ?? modal.closeRechargeModal;
  const rechargeCanvasId = propRechargeCanvasId ?? modal.rechargeCanvasId;
  const upgradeModalReason = propUpgradeModalReason ?? modal.upgradeModalReason;
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>('monthly');
  // Spec K7（D3）：真实权益数据——打开弹窗时拉取 /api/quota（余量与配额口径同源），
  // 触发点带画板上下文时一并返回当前画板节点余量；失败时为 null，
  // 权益对比回退到默认常量、用量行隐藏，绝不展示虚构数字
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  // 在线支付状态机（ADR-0014）：idle → creating → awaiting → paid；错误回 idle
  const [payStage, setPayStage] = useState<PayStage>('idle');
  const [payError, setPayError] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollStartRef = useRef<number>(0);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // 弹窗关闭即停止轮询
  useEffect(() => {
    if (!isOpen) stopPolling();
    return stopPolling;
  }, [isOpen]);

  const pollOrderStatus = (orderNo: string) => {
    stopPolling();
    pollStartRef.current = Date.now();
    pollTimerRef.current = window.setInterval(async () => {
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        setPayStage('idle');
        setPayError('等待支付超时。如已完成付款，会员将自动开通，可稍后刷新页面查看');
        return;
      }
      try {
        const res = await fetch(`/api/subscriptions/orders/${encodeURIComponent(orderNo)}`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        if (body?.status !== 'paid') return;
        stopPolling();
        await refreshUser();
        setPayStage('paid');
        setPayError(null);
      } catch {
        // 网络抖动：继续等下一轮
      }
    }, POLL_INTERVAL_MS);
  };

  const handlePay = async () => {
    setPayError(null);
    setPayStage('creating');
    try {
      const res = await fetch('/api/subscriptions/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plan: selectedPlan }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 503) {
        setPayStage('idle');
        setPayError('在线支付暂未开放，请稍后再试');
        return;
      }
      if (!res.ok || !body?.payUrl) {
        setPayStage('idle');
        setPayError(body?.error || '下单失败，请稍后重试');
        return;
      }
      const win = window.open(body.payUrl, '_blank');
      if (!win) window.location.href = body.payUrl; // 弹窗被拦截：当前页跳转收银台
      setPayStage('awaiting');
      pollOrderStatus(String(body.orderNo));
    } catch {
      setPayStage('idle');
      setPayError('网络异常，请稍后重试');
    }
  };

  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setQuota(null);
    (async () => {
      try {
        const url = rechargeCanvasId
          ? `/api/quota?canvasId=${encodeURIComponent(rechargeCanvasId)}`
          : '/api/quota';
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as QuotaInfo;
        if (!cancelled) setQuota(body);
      } catch {
        // 静默降级：权益对比使用默认常量
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, rechargeCanvasId]);

  // 免费版权益数值：优先服务端真实口径，接口失败回退常量
  const boardLimit = quota?.board.limit ?? FALLBACK_BOARD_LIMIT;
  const nodeLimit = quota?.node?.limit ?? FALLBACK_NODE_LIMIT;
  // VIP 专享模型行仅在管理员实际配置后展示（未配置 → 不展示空气权益）
  const vipOnlyModelCount = quota?.vipOnlyModelCount ?? 0;

  const currentPlan = PLANS.find((p) => p.id === selectedPlan) || PLANS[1];

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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      showCloseButton={false}
      className="relative w-full max-w-xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden p-0"
    >
      <div id="recharge-modal-container" className="flex flex-col w-full">
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
            onClick={onClose}
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

          {/* Plan Selection Cards */}
          <div className="grid grid-cols-2 gap-3 mb-5">
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

            {/* Spec K7（D3）：真实使用量（体验版；数据来自 /api/quota，与后端拦截同口径） */}
            {quota && quota.plan === 'trial' && (
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300">
                  画板 <span className="font-semibold text-slate-900 dark:text-white">{quota.board.used}</span>
                  <span className="text-slate-400"> / {quota.board.limit ?? '∞'}</span>
                </span>
                {quota.node && (
                  <span className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300">
                    当前画板节点 <span className="font-semibold text-slate-900 dark:text-white">{quota.node.used}</span>
                    <span className="text-slate-400"> / {quota.node.limit ?? '∞'}</span>
                  </span>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                <div className="font-semibold text-slate-800 dark:text-slate-200 mb-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-400" />
                  免费版
                </div>
                <ul className="space-y-1.5 text-[11px]">
                  <li className="flex items-center gap-1.5 text-slate-500">
                    <Layers className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    最多创建 {boardLimit} 个独立画板
                  </li>
                  <li className="flex items-center gap-1.5 text-slate-500">
                    <Network className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    单画板 {nodeLimit} 个 AI 思考节点
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
                  {/* Spec K7（D3）：仅当管理员配置了 VIP 专享模型时才展示，未配置不画大饼 */}
                  {vipOnlyModelCount > 0 && (
                    <li className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      专享 {vipOnlyModelCount} 个高级模型
                    </li>
                  )}
                  <li className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    支持子分支“导出为独立画板”
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* 在线支付操作区（ADR-0014）：下单 → 跳转收银台 → 轮询到账自动更新 */}
          {payError && (
            <div className="mb-3 px-3 py-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {payError}
            </div>
          )}

          {payStage === 'paid' ? (
            <div className="w-full py-3 px-4 rounded-xl text-sm font-medium flex items-center justify-center gap-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800/60">
              <Check className="w-4 h-4" />
              支付成功，会员已开通
              {isVip && user?.vip_expires_at && (
                <span className="text-xs">（有效期至 {formatExpiry(user.vip_expires_at)}）</span>
              )}
            </div>
          ) : payStage === 'awaiting' ? (
            <div className="w-full py-3 px-4 rounded-xl text-sm font-medium flex flex-col items-center gap-1.5 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200 border border-indigo-200 dark:border-indigo-800/60">
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                已跳转支付，等待支付完成…
              </span>
              <span className="text-[11px] text-indigo-500 dark:text-indigo-300/80">
                完成付款后本弹窗将自动更新，无需其他操作
              </span>
            </div>
          ) : (
            <button
              onClick={() => void handlePay()}
              disabled={payStage === 'creating'}
              className="w-full py-3 px-4 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white shadow-sm transition-all active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {payStage === 'creating' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在创建支付订单…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  支付宝支付 {currentPlan.price}
                </>
              )}
            </button>
          )}

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
    </Modal>
  );
};

