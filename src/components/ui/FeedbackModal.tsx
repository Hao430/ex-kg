import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  X,
  MessageSquarePlus,
  Lightbulb,
  Bug,
  Sparkles,
  HelpCircle,
  Star,
  Mail,
  Send,
  CheckCircle2,
  Inbox,
  Clock,
} from 'lucide-react';
import { Modal } from './base/Modal';
import { Spinner } from './base/Spinner';
import { StatusBanner } from './base/StatusBanner';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { submitFeedback, listMyFeedbacks } from '../../services/feedback';
import { FeedbackType, MyFeedback } from '../../types';

const FEEDBACK_TYPES: { id: FeedbackType; label: string; icon: any; desc: string }[] = [
  { id: 'suggestion', label: '功能建议', icon: Lightbulb, desc: '希望增加的新功能或推演模式' },
  { id: 'bug', label: '问题反馈', icon: Bug, desc: '使用过程中遇到的异常或错误' },
  { id: 'ux', label: '体验优化', icon: Sparkles, desc: '界面布局、动画或交互细节改善' },
  { id: 'other', label: '其他想法', icon: HelpCircle, desc: '合作咨询、反馈交流或其他想法' },
];

/** Spec P1：工单状态徽章。文案面向用户，不出现内部术语。 */
const STATUS_META: Record<MyFeedback['status'], { label: string; className: string }> = {
  pending: { label: '待处理', className: 'bg-slate-800 text-slate-300 border-slate-700' },
  processing: { label: '处理中', className: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
  resolved: { label: '已解决', className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  rejected: { label: '已驳回', className: 'bg-slate-800 text-slate-400 border-slate-700' },
};

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface FeedbackModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const { user } = useAuth();
  const { feedbackModalOpen, closeFeedbackModal } = useModal();
  const isOpen = propIsOpen ?? feedbackModalOpen;

  const [view, setView] = useState<'submit' | 'mine'>('submit');
  const [type, setType] = useState<FeedbackType>('suggestion');
  const [rating, setRating] = useState<number>(5);
  const [content, setContent] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Spec P1：我的反馈列表（进入页签才拉取）
  const [mine, setMine] = useState<MyFeedback[]>([]);
  const [mineLoading, setMineLoading] = useState(false);
  const [mineError, setMineError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || view !== 'mine' || !user) return;
    let cancelled = false;
    setMineLoading(true);
    setMineError(null);
    listMyFeedbacks().then((res) => {
      if (cancelled) return;
      setMineLoading(false);
      if (res.success) setMine(res.feedbacks || []);
      else setMineError(res.error || '获取反馈记录失败');
    });
    return () => { cancelled = true; };
    // listMyFeedbacks 每次渲染都是新函数引用，不能进依赖（会把 effect 变成每帧重拉）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, view, user]);

  const handleClose = () => {
    if (propOnClose) propOnClose();
    else closeFeedbackModal();
    // Reset state after transition
    setTimeout(() => {
      setSuccess(false);
      setContent('');
      setErrorMsg(null);
      setView('submit');
    }, 250);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || content.trim().length < 3) {
      setErrorMsg('请详细描述您的反馈建议（至少 3 个字符）');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    const res = await submitFeedback({
      type,
      rating,
      content: content.trim(),
      contactInfo: contactInfo.trim() || user?.email || undefined,
    });

    setSubmitting(false);
    if (res.success) {
      setSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 2000);
    } else {
      setErrorMsg(res.error || '提交失败，请重试');
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="lg"
      showCloseButton={false}
      className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-100 p-0"
    >
      <div id="feedback-modal-container" className="flex flex-col w-full h-full">
        {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-slate-800/80 bg-slate-900/50">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <MessageSquarePlus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white tracking-tight">
                  {view === 'submit' ? '提交产品反馈与建议' : '我的反馈'}
                </h3>
                <p className="text-xs text-slate-400">
                  {view === 'submit' ? '您的每一个想法都是我们持续打磨产品的动力' : '这里可以看到我们给出的回复'}
                </p>
              </div>
            </div>
            <button
              id="feedback-close-btn"
              onClick={handleClose}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800/60 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* View switch（登录用户才提供「我的反馈」；游客只有提交页） */}
          {user && !success && (
            <div className="flex items-center gap-2 px-6 pt-4">
              {([
                { id: 'submit', label: '提交反馈' },
                { id: 'mine', label: '我的反馈' },
              ] as const).map((tab) => (
                <button
                  key={tab.id}
                  id={`feedback-tab-${tab.id}`}
                  type="button"
                  onClick={() => setView(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    view === tab.id
                      ? 'bg-indigo-600/20 border-indigo-500/60 text-white'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {view === 'mine' ? (
            <div className="p-6 space-y-3 max-h-[60vh] overflow-y-auto">
              {mineLoading && (
                <div className="py-10 text-center text-slate-400 text-xs flex items-center justify-center gap-2">
                  <Spinner size="md" />
                  加载中...
                </div>
              )}

              {!mineLoading && mineError && (
                <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs">
                  {mineError}
                </div>
              )}

              {!mineLoading && !mineError && mine.length === 0 && (
                <div className="py-10 text-center space-y-2">
                  <Inbox className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-xs text-slate-400">
                    还没有可查看的反馈。匿名提交的反馈无法在这里显示，如需跟进请留下联系方式。
                  </p>
                </div>
              )}

              {!mineLoading && mine.map((f) => {
                const meta = STATUS_META[f.status] || STATUS_META.pending;
                const typeLabel = FEEDBACK_TYPES.find((t) => t.id === f.type)?.label || '反馈';
                return (
                  <div key={f.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-slate-300 bg-slate-800/80 rounded-md px-2 py-0.5">
                          {typeLabel}
                        </span>
                        <span className={`text-[11px] border rounded-md px-2 py-0.5 ${meta.className}`}>
                          {meta.label}
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(f.created_at)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 whitespace-pre-wrap break-words">{f.content}</p>
                    {f.admin_reply ? (
                      <div className="rounded-lg bg-indigo-950/40 border border-indigo-900/50 p-2.5">
                        <div className="text-[11px] font-semibold text-indigo-300 mb-1">官方回复</div>
                        <p className="text-xs text-slate-200 whitespace-pre-wrap break-words">{f.admin_reply}</p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">暂无回复，我们会尽快处理。</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : success ? (
            <div className="p-10 text-center space-y-4">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center"
              >
                <CheckCircle2 className="w-8 h-8" />
              </motion.div>
              <div>
                <h4 className="text-lg font-bold text-white mb-1">反馈已成功送达！</h4>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  非常感谢您的宝贵建议，研发团队已收到并将认真评估与优化！
                </p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {/* Feedback Category */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-300">反馈类型</label>
                <div className="grid grid-cols-2 gap-2">
                  {FEEDBACK_TYPES.map((t) => {
                    const Icon = t.icon;
                    const isSelected = type === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setType(t.id)}
                        className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition-all ${
                          isSelected
                            ? 'bg-indigo-600/20 border-indigo-500/80 text-white shadow-sm'
                            : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                        }`}
                      >
                        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isSelected ? 'text-indigo-400' : 'text-slate-400'}`} />
                        <div>
                          <div className="text-xs font-semibold text-slate-200">{t.label}</div>
                          <div className="text-[11px] text-slate-500 leading-tight mt-0.5">{t.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Rating */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                  <span>产品满意度评分</span>
                  <span className="text-amber-400 text-xs font-semibold">{rating} 星好评</span>
                </label>
                <div className="flex items-center gap-2 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80 justify-center">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setRating(star)}
                      className="p-1 text-slate-600 hover:scale-110 transition"
                    >
                      <Star
                        className={`w-6 h-6 ${
                          star <= rating
                            ? 'text-amber-400 fill-amber-400'
                            : 'text-slate-600 hover:text-slate-400'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>

              {/* Content Textarea */}
              <div className="space-y-1.5">
                <label htmlFor="feedback-content-input" className="text-xs font-medium text-slate-300 flex items-center justify-between">
                  <span>详细描述</span>
                  <span className="text-slate-500 text-[11px]">{content.length} / 2000 字</span>
                </label>
                <textarea
                  id="feedback-content-input"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  maxLength={2000}
                  rows={4}
                  placeholder="请详细描述您遇到的问题、期望的功能或体验改进建议..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none transition"
                />
              </div>

              {/* Optional Contact Info */}
              <div className="space-y-1.5">
                <label htmlFor="feedback-contact-input" className="text-xs font-medium text-slate-300 flex items-center justify-between">
                  <span>联系方式 (选填)</span>
                  <span className="text-slate-500 text-[11px]">方便我们针对反馈向您沟通进展</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <Mail className="w-3.5 h-3.5" />
                  </div>
                  <input
                    id="feedback-contact-input"
                    type="text"
                    value={contactInfo}
                    onChange={(e) => setContactInfo(e.target.value)}
                    placeholder={user?.email ? `默认: ${user.email}` : '邮箱 / 微信 / 手机号'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  />
                </div>
              </div>

              {/* Error Alert */}
              {errorMsg && (
                <StatusBanner
                  type="error"
                  unstyled
                  icon={null}
                  className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs"
                >
                  {errorMsg}
                </StatusBanner>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  id="feedback-cancel-btn"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800 rounded-xl transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  id="feedback-submit-btn"
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-lg shadow-indigo-950/40 flex items-center gap-2 transition"
                >
                  {submitting ? (
                    <>
                      <Spinner size="sm" />
                      提交中...
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      提交反馈
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
      </div>
    </Modal>
  );
};
