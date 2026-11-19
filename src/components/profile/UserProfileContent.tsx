/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 用户资料共享内容组件（单一维护点）。
 *
 * `/profile` 独立页与 `UserProfileModal` 弹窗渲染同一份本组件：三 Tab、表单状态、
 * 取数、保存、改密、注销、配额全部只有这一处实现。宿主差异只通过 props 注入：
 *   - onSaved：弹窗注入「1.2s 后关闭弹窗」，页面不传（保留内联成功提示）；
 *   - onClose / cancelLabel：页眉 X 与页脚按钮在两种宿主下的语义。
 *
 * 历史包袱已在此一次性清除：头像上传入口（仅 emoji 徽标头像）、安全页
 * `has_password === false` 微信死分支（改密表单无条件展示）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  X,
  User,
  Crown,
  ShieldCheck,
  Calendar,
  Mail,
  Check,
  Sparkles,
  Trash2,
  KeyRound,
  Share2,
  Copy,
  Layers,
  Globe2,
  FileDown,
  Shield,
  AlertTriangle,
  RefreshCw,
  BadgeCheck,
} from 'lucide-react';
import { Spinner } from '../ui/base/Spinner';
import { StatusBanner } from '../ui/base/StatusBanner';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { extractErrorMessage } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { copyTextToClipboard } from '../../lib/clipboard.js';

// Curated intellectual & aesthetic emoji avatar presets
const PRESET_AVATARS = [
  { emoji: '🧠', label: '深思' },
  { emoji: '💡', label: '灵感' },
  { emoji: '🚀', label: '探索' },
  { emoji: '⚡', label: '迅捷' },
  { emoji: '🎨', label: '创作' },
  { emoji: '🦉', label: '博学' },
  { emoji: '💎', label: '精粹' },
  { emoji: '🪐', label: '星宇' },
  { emoji: '🦊', label: '灵动' },
  { emoji: '🌲', label: '年轮' },
  { emoji: '🌟', label: '璀璨' },
  { emoji: '🔮', label: '洞见' },
];

/** 仅用于未选中画布时的节点上限展示占位，绝不作为「已用量」参与计算。 */
const NODE_LIMIT_FALLBACK = 10;

export type UserProfileTab = 'profile' | 'membership' | 'security';

export interface UserProfileContentProps {
  /** 保存成功后的宿主副作用。弹窗：1.2s 后关闭；页面：不传，保留内联提示。 */
  onSaved?: () => void;
  /** 页眉 X 与页脚按钮的行为宿主注入。 */
  onClose?: () => void;
  cancelLabel?: string;
  initialTab?: UserProfileTab;
}

export interface CanvasOption {
  id: string;
  title: string;
}

export interface QuotaCounter {
  used: number;
  limit: number | null;
}

export interface ProfileQuotaView {
  board: QuotaCounter;
  /** 未选择画布时为 null。 */
  node: QuotaCounter | null;
  canvases: CanvasOption[];
  selectedCanvasId: string | null;
  setSelectedCanvasId: (id: string | null) => void;
  loadingBoard: boolean;
  loadingCanvases: boolean;
  loadingNode: boolean;
  /** 配额区局部错误，不拖垮其他 Tab。 */
  error: string | null;
  reload: () => void;
}

/**
 * 内部取数 hook（与共享组件同文件，刻意不放 src/hooks/，避免反向依赖业务 UI 的规则冲突）。
 *
 * 画板：GET /api/quota；画布选项：GET /api/canvases；节点：GET /api/quota?canvasId=...
 * 节点数只认服务端 /api/quota（与 chat 闸门同口径），不用 canvases.nodeCount 顶替。
 * 切换画布用 AbortController + 请求序号双保险，避免旧响应覆盖新选中项。
 */
export function useProfileQuota(userId?: string, isVip?: boolean): ProfileQuotaView {
  const [board, setBoard] = useState<QuotaCounter>({ used: 0, limit: null });
  const [canvases, setCanvases] = useState<CanvasOption[]>([]);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [node, setNode] = useState<QuotaCounter | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [loadingCanvases, setLoadingCanvases] = useState(true);
  const [loadingNode, setLoadingNode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const selectedRef = useRef<string | null>(null);
  const nodeAbortRef = useRef<AbortController | null>(null);
  const nodeSeqRef = useRef(0);

  useEffect(() => {
    selectedRef.current = selectedCanvasId;
  }, [selectedCanvasId]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  // 挂载、登录主体或套餐变化时并行拉取画板配额与画布列表。
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setLoadingBoard(true);
    setLoadingCanvases(true);
    setError(null);

    (async () => {
      try {
        const [boardRes, canvasesRes] = await Promise.all([
          fetch('/api/quota', { credentials: 'include', signal: ac.signal }),
          fetch('/api/canvases', { credentials: 'include', signal: ac.signal }),
        ]);

        if (!boardRes.ok) {
          // 401 由 AuthProvider 的登录门禁统一处理，不在配额区重复提示。
          if (!cancelled && boardRes.status !== 401) {
            setError(await extractErrorMessage(boardRes, '配额加载失败，请重试'));
          }
        } else {
          const body = (await boardRes.json()) as any;
          if (!cancelled) {
            setBoard({
              used: Number(body?.board?.used) || 0,
              limit: body?.board?.limit == null ? null : Number(body.board.limit),
            });
          }
        }

        if (!canvasesRes.ok) {
          if (!cancelled && canvasesRes.status !== 401) {
            setError((prev) => prev ?? '画板列表加载失败，请重试');
          }
        } else {
          const body = (await canvasesRes.json()) as unknown;
          if (!cancelled) {
            const list = Array.isArray(body) ? body : [];
            const options: CanvasOption[] = list
              .map((item: any) => ({
                id: String(item?.id ?? ''),
                title: String(item?.title ?? '未命名画板'),
              }))
              .filter((item) => item.id);
            setCanvases(options);
            // 选中的画布若已不在属主列表中（他端删除），重置选择，避免展示陈旧节点数。
            if (selectedRef.current && !options.some((c) => c.id === selectedRef.current)) {
              setSelectedCanvasId(null);
            }
          }
        }
      } catch {
        if (!cancelled && !ac.signal.aborted) {
          setError((prev) => prev ?? '配额加载失败，请重试');
        }
      } finally {
        if (!cancelled) {
          setLoadingBoard(false);
          setLoadingCanvases(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [userId, isVip, reloadToken]);

  // 选中画布后取节点配额；未选择时只清空节点，不发请求。
  useEffect(() => {
    const seq = ++nodeSeqRef.current;
    nodeAbortRef.current?.abort();

    if (!selectedCanvasId) {
      setNode(null);
      setLoadingNode(false);
      return;
    }

    const ac = new AbortController();
    nodeAbortRef.current = ac;
    setLoadingNode(true);

    (async () => {
      try {
        const res = await fetch(
          `/api/quota?canvasId=${encodeURIComponent(selectedCanvasId)}`,
          { credentials: 'include', signal: ac.signal }
        );
        if (res.status === 403) {
          if (seq === nodeSeqRef.current) {
            setSelectedCanvasId(null);
            setNode(null);
            setError('无权查看该画板配额，已重置选择');
          }
          return;
        }
        if (!res.ok) {
          if (seq === nodeSeqRef.current) {
            setNode(null);
            setError(await extractErrorMessage(res, '节点配额加载失败，请重试'));
          }
          return;
        }
        const body = (await res.json()) as any;
        if (seq === nodeSeqRef.current) {
          const n = body?.node;
          setNode(
            n == null
              ? { used: 0, limit: null }
              : {
                  used: Number(n.used) || 0,
                  limit: n.limit == null ? null : Number(n.limit),
                }
          );
        }
      } catch {
        if (!ac.signal.aborted && seq === nodeSeqRef.current) {
          setNode(null);
          setError('节点配额加载失败，请重试');
        }
      } finally {
        if (seq === nodeSeqRef.current) setLoadingNode(false);
      }
    })();

    return () => {
      ac.abort();
    };
  }, [selectedCanvasId, reloadToken]);

  return {
    board,
    node,
    canvases,
    selectedCanvasId,
    setSelectedCanvasId,
    loadingBoard,
    loadingCanvases,
    loadingNode,
    error,
    reload,
  };
}

const formatCounter = (counter: QuotaCounter): string =>
  `${counter.used} / ${counter.limit === null ? '不限' : counter.limit}`;

export const UserProfileContent: React.FC<UserProfileContentProps> = ({
  onSaved,
  onClose,
  cancelLabel = '取消',
  initialTab = 'profile',
}) => {
  const { user, isVip, updateProfile, changePassword, logout } = useAuth();
  const { closeUserProfileModal, openRechargeModal, openMySharesModal } = useModal();
  const { confirm: confirmAction, element: confirmElement } = useConfirmDialog();
  const quota = useProfileQuota(user?.id, isVip);

  const [activeTab, setActiveTab] = useState<UserProfileTab>(initialTab);
  const [name, setName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('🧠');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // 修改密码
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      // 头像上传已彻底移除：只认 emoji 徽标，历史 http/data 头像一律回落默认徽标。
      setSelectedAvatar(PRESET_AVATARS.find((p) => p.emoji === user.avatar)?.emoji ?? '🧠');
      setStatusMsg(null);
    }
  }, [user]);

  const handleClose = onClose ?? closeUserProfileModal;

  const handleCopy = async (text: string, fieldName: string) => {
    const success = await copyTextToClipboard(text);
    if (success) {
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 1800);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setStatusMsg({ type: 'error', text: '用户昵称不能为空' });
      return;
    }

    setSaving(true);
    setStatusMsg(null);

    const res = await updateProfile({
      name: name.trim(),
      avatar: selectedAvatar,
    });

    setSaving(false);
    if (res.success) {
      setStatusMsg({ type: 'success', text: '个人资料已更新！' });
      // 关闭弹窗是宿主副作用，绝不写进共享逻辑（/profile 页面不传 onSaved）。
      onSaved?.();
    } else {
      setStatusMsg({ type: 'error', text: res.error || '保存失败，请重试' });
    }
  };

  // 已登录修改密码：成功后服务端踢全部会话，前端同步登出并回到登录态
  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword) {
      setStatusMsg({ type: 'error', text: '请填写旧密码与新密码' });
      return;
    }
    if (newPassword.length < 6) {
      setStatusMsg({ type: 'error', text: '新密码长度至少为 6 位' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatusMsg({ type: 'error', text: '两次输入的新密码不一致' });
      return;
    }

    setChangingPassword(true);
    setStatusMsg(null);
    const res = await changePassword(oldPassword, newPassword);
    setChangingPassword(false);

    if (res.success) {
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      closeUserProfileModal();
      await logout();
      // App 树外请求全局 toast：deepdive:toast 自定义事件（独立页无监听，无害）。
      window.dispatchEvent(
        new CustomEvent('deepdive:toast', {
          detail: { message: '密码已修改，请使用新密码重新登录' },
        }),
      );
    } else {
      setStatusMsg({ type: 'error', text: res.error || '修改密码失败，请重试' });
    }
  };

  // Spec F4：自助注销账号（软删除，30 天内可联系管理员恢复）
  const handleDeleteAccount = async () => {
    if (
      !(await confirmAction({
        title: '确认注销账号？',
        description: '注销后 30 天内可联系管理员恢复。',
        confirmLabel: '确认注销',
        tone: 'danger',
      }))
    )
      return;

    setDeleting(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/auth/account', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        closeUserProfileModal();
        await logout();
      } else {
        setStatusMsg({ type: 'error', text: await extractErrorMessage(res, '注销失败，请稍后重试') });
      }
    } catch {
      setStatusMsg({ type: 'error', text: '注销失败，请检查网络后重试' });
    } finally {
      setDeleting(false);
    }
  };

  const remainingVipDays = !user
    ? 0
    : user.role === 'admin'
    ? '永久有效'
    : user.vip_expires_at
    ? Math.max(0, Math.ceil((new Date(user.vip_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  const vipExpDate = user?.vip_expires_at
    ? new Date(user.vip_expires_at).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  const joinDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '2026年';

  return (
    <>
      {/* Header Bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-900/40">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-medium">
            <User className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              用户个人中心
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              管理您的个人偏好、身份标识与账户安全
            </p>
          </div>
        </div>
        <button
          id="user-profile-close-btn"
          onClick={handleClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* User Hero Overview Bar */}
      <div className="px-6 py-5 bg-gradient-to-b from-slate-50/50 to-white dark:from-slate-900/50 dark:to-[#0f172a] border-b border-slate-100 dark:border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {/* Avatar Preview Ring：仅 emoji 徽标，无上传入口 */}
          <div className="relative group shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-purple-600 p-0.5 shadow-md">
              <div className="w-full h-full rounded-[14px] bg-white dark:bg-slate-900 flex items-center justify-center overflow-hidden text-2xl font-bold">
                <span>{selectedAvatar || '🧠'}</span>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                {name || '思维探索者'}
              </span>
              {user?.role === 'admin' ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xxs font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                  <ShieldCheck className="w-3 h-3" /> 管理员
                </span>
              ) : isVip ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xxs font-semibold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60">
                  <Crown className="w-3 h-3 text-amber-500" /> VIP 尊享会员
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xxs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                  免费体验版
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1 font-mono">
                <Mail className="w-3.5 h-3.5 text-slate-400" />
                {user?.email}
              </span>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3 text-slate-400" />
                加入于 {joinDate}
              </span>
            </div>
          </div>
        </div>

        {/* Top Right Quick Action */}
        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
          {!isVip && (
            <button
              type="button"
              onClick={() => {
                closeUserProfileModal();
                openRechargeModal('升级 VIP 解锁全量特权');
              }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white shadow-sm shadow-amber-500/20 active:scale-98 transition-all"
            >
              <Crown className="w-3.5 h-3.5" />
              升级会员
            </button>
          )}
          <button
            type="button"
            id="user-profile-my-shares-btn"
            onClick={() => {
              closeUserProfileModal();
              openMySharesModal();
            }}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
            title="查看与管理我的画布分享链接"
          >
            <Share2 className="w-3.5 h-3.5 text-sky-500" />
            我的分享
          </button>
        </div>
      </div>

      {/* Segmented Navigation Tabs */}
      <div className="px-6 pt-3 pb-0 border-b border-slate-100 dark:border-slate-800/80 bg-white dark:bg-[#0f172a]">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`relative pb-3 text-xs font-semibold tracking-wide transition-colors ${
              activeTab === 'profile'
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            基本资料
            {activeTab === 'profile' && (
              <motion.div
                layoutId="userProfileTabIndicator"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full"
                transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('membership')}
            className={`relative pb-3 text-xs font-semibold tracking-wide transition-colors ${
              activeTab === 'membership'
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            会员权益与配额
            {activeTab === 'membership' && (
              <motion.div
                layoutId="userProfileTabIndicator"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full"
                transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('security')}
            className={`relative pb-3 text-xs font-semibold tracking-wide transition-colors ${
              activeTab === 'security'
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            安全与账号
            {activeTab === 'security' && (
              <motion.div
                layoutId="userProfileTabIndicator"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full"
                transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              />
            )}
          </button>
        </div>
      </div>

      {/* Tab Content Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* TAB 1: 基本资料 */}
        {activeTab === 'profile' && (
          <form onSubmit={handleSave} className="space-y-6">
            {/* 昵称设置 */}
            <div className="space-y-2">
              <label
                htmlFor="user-profile-name-input"
                className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between"
              >
                <span>用户昵称</span>
                <span className="text-xxs text-slate-400 font-normal">
                  最多 30 个字符，展示于画布协作与分享中
                </span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="user-profile-name-input"
                  type="text"
                  autoComplete="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={30}
                  placeholder="设置您的昵称"
                  className="w-full bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                />
              </div>
            </div>

            {/* 个性化头像精选：仅 emoji 徽标 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  选择专属思维徽标
                </span>
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2.5">
                {PRESET_AVATARS.map((preset) => {
                  const isSelected = selectedAvatar === preset.emoji;
                  return (
                    <button
                      key={preset.emoji}
                      type="button"
                      onClick={() => setSelectedAvatar(preset.emoji)}
                      className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all ${
                        isSelected
                          ? 'bg-indigo-50 dark:bg-indigo-950/60 border-2 border-indigo-500 shadow-sm text-slate-900 dark:text-white scale-102'
                          : 'bg-slate-50 dark:bg-slate-900/60 hover:bg-slate-100 dark:hover:bg-slate-800/80 border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <span className="text-2xl mb-1">{preset.emoji}</span>
                      <span className="text-xxs font-medium text-slate-500 dark:text-slate-400">
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 账号元信息卡片 */}
            <div className="p-4 rounded-xl bg-slate-50/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 space-y-2.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 flex items-center justify-between">
                <span>账号标识与绑定</span>
                <span className="inline-flex items-center gap-1 text-xxs text-emerald-600 dark:text-emerald-400 font-normal">
                  <BadgeCheck className="w-3.5 h-3.5" />
                  邮箱安全保护已激活
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">用户 ID</span>
                  <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
                    <span>{user?.id ? `${user.id.slice(0, 10)}...` : 'N/A'}</span>
                    {user?.id && (
                      <button
                        type="button"
                        onClick={() => handleCopy(user.id, 'id')}
                        className="p-1 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                        title="复制完整 ID"
                      >
                        {copiedField === 'id' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">账号类型</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    {user?.role === 'admin'
                      ? '平台最高管理员'
                      : isVip
                      ? '专业版会员 (VIP)'
                      : '标准体验版'}
                  </span>
                </div>
              </div>

              {/* 账号邮箱。登录方式只有「邮箱 + 密码」一种（2026-09-16 撤销微信登录入口）。 */}
              <div className="space-y-2 pt-0.5">
                <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-xs">
                  <div className="min-w-0 flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-slate-500 dark:text-slate-400 shrink-0">邮箱</span>
                    <span className="truncate font-medium text-slate-700 dark:text-slate-300">
                      {user?.email}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </form>
        )}

        {/* TAB 2: 会员与权益 */}
        {activeTab === 'membership' && (
          <div className="space-y-6">
            {/* 会员状态卡片 */}
            <div
              className={`p-5 rounded-2xl border transition-all ${
                user?.role === 'admin'
                  ? 'bg-emerald-500/5 dark:bg-emerald-950/20 border-emerald-500/30'
                  : isVip
                  ? 'bg-amber-500/5 dark:bg-amber-950/20 border-amber-500/30'
                  : 'bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold shadow-sm ${
                      user?.role === 'admin'
                        ? 'bg-emerald-600 text-white'
                        : isVip
                        ? 'bg-amber-500 text-white'
                        : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {user?.role === 'admin' ? (
                      <ShieldCheck className="w-5 h-5" />
                    ) : isVip ? (
                      <Crown className="w-5 h-5" />
                    ) : (
                      <Sparkles className="w-5 h-5" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-base font-bold text-slate-900 dark:text-white">
                        {user?.role === 'admin'
                          ? '超级管理员权益'
                          : isVip
                          ? 'VIP 尊享版会员'
                          : '基础免费探索版'}
                      </h4>
                      <span
                        className={`px-2 py-0.5 text-xxs font-semibold rounded-full ${
                          user?.role === 'admin'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300'
                            : isVip
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300'
                            : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {user?.role === 'admin'
                          ? '全量特权'
                          : isVip
                          ? '特权生效中'
                          : '受限体验'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {user?.role === 'admin'
                        ? '拥有系统全局所有权限与最高优先级模型推演'
                        : isVip
                        ? '享有无限制画板、无限推演节点与专属高速 AI 推理'
                        : '单画板限 10 个 AI 推演节点，最多创建 3 个画板'}
                    </p>
                  </div>
                </div>

                {!isVip && (
                  <button
                    type="button"
                    onClick={() => {
                      closeUserProfileModal();
                      openRechargeModal('升级 VIP 解锁全量特权');
                    }}
                    className="px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-amber-500 hover:bg-amber-600 shadow-sm transition"
                  >
                    立即升级
                  </button>
                )}
              </div>

              {/* 详细指标 */}
              <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-slate-200/60 dark:border-slate-800/60">
                <div>
                  <span className="text-xxs text-slate-400 block mb-0.5">剩余有效期</span>
                  <span
                    className={`text-sm font-bold ${
                      typeof remainingVipDays === 'number' && remainingVipDays > 0
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    {typeof remainingVipDays === 'number'
                      ? remainingVipDays > 0
                        ? `${remainingVipDays} 天`
                        : '已到期'
                      : remainingVipDays}
                  </span>
                </div>

                <div>
                  <span className="text-xxs text-slate-400 block mb-0.5">到期日期</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    {user?.role === 'admin' ? '永久有效' : vipExpDate || '永久基础版'}
                  </span>
                </div>

                <div>
                  <span className="text-xxs text-slate-400 block mb-0.5">推演通道</span>
                  <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                    {isVip ? 'VIP 独占高速集群' : '标准并发通道'}
                  </span>
                </div>
              </div>
            </div>

            {/* 实时配额卡片：画板 X/3 取 /api/quota，节点 Y/10 经画布选择器带 canvasId 取 /api/quota */}
            <div className="p-5 rounded-2xl border border-indigo-200/70 dark:border-indigo-900/50 bg-indigo-50/30 dark:bg-indigo-950/20 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                  <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  实时配额
                </h4>
                <button
                  type="button"
                  onClick={quota.reload}
                  disabled={quota.loadingBoard || quota.loadingCanvases}
                  className="flex items-center gap-1 text-xxs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 disabled:opacity-50 transition"
                  title="重新加载配额"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${quota.loadingBoard || quota.loadingCanvases ? 'animate-spin' : ''}`}
                  />
                  刷新
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">画板</span>
                  <span
                    data-testid="profile-quota-board"
                    className="font-semibold font-mono text-slate-800 dark:text-slate-200"
                  >
                    {quota.loadingBoard
                      ? '加载中…'
                      : formatCounter(quota.board)}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">节点</span>
                  <span
                    data-testid="profile-quota-node"
                    className="font-semibold font-mono text-slate-800 dark:text-slate-200"
                  >
                    {!quota.selectedCanvasId
                      ? `— / ${quota.node?.limit ?? NODE_LIMIT_FALLBACK}`
                      : quota.loadingNode
                      ? '加载中…'
                      : quota.node
                      ? formatCounter(quota.node)
                      : '—'}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="profile-quota-canvas"
                  className="text-xxs font-medium text-slate-500 dark:text-slate-400 block"
                >
                  选择画板查看节点配额（仅展示您自己的画板）
                </label>
                <select
                  id="profile-quota-canvas"
                  data-testid="profile-canvas-select"
                  value={quota.selectedCanvasId ?? ''}
                  onChange={(e) => quota.setSelectedCanvasId(e.target.value || null)}
                  disabled={quota.loadingCanvases || quota.canvases.length === 0}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 transition"
                >
                  <option value="">
                    {quota.loadingCanvases
                      ? '加载画板中…'
                      : quota.canvases.length === 0
                      ? '暂无画板'
                      : '选择画板查看节点配额'}
                  </option>
                  {quota.canvases.map((canvas) => (
                    <option key={canvas.id} value={canvas.id}>
                      {canvas.title}
                    </option>
                  ))}
                </select>
                {!quota.loadingCanvases && quota.canvases.length === 0 && (
                  <p className="text-xxs text-slate-500 dark:text-slate-400">
                    暂无画板，创建后即可查看节点配额。
                  </p>
                )}
              </div>

              {quota.error && (
                <div
                  data-testid="profile-quota-error"
                  className="flex items-center gap-2 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-xxs text-rose-700 dark:text-rose-300"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1">{quota.error}</span>
                  <button
                    type="button"
                    onClick={quota.reload}
                    className="inline-flex items-center gap-1 font-semibold hover:underline"
                  >
                    <RefreshCw className="w-3 h-3" />
                    重试
                  </button>
                </div>
              )}
            </div>

            {/* 权益对比矩阵卡片 */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                会员特权清单
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 block mb-0.5">
                      无限画板与思维节点
                    </span>
                    <span className="text-xxs text-slate-500 dark:text-slate-400 leading-relaxed block">
                      突破体验版 10 节点配额限制，支持超大二维知识图谱多分支发散
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 block mb-0.5">
                      前沿大模型优先推理
                    </span>
                    <span className="text-xxs text-slate-500 dark:text-slate-400 leading-relaxed block">
                      支持 VIP 白名单大模型，更深思考上下文，极速响应免排队
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                    <Globe2 className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 block mb-0.5">
                      实时联网检索与角标溯源
                    </span>
                    <span className="text-xxs text-slate-500 dark:text-slate-400 leading-relaxed block">
                      自动抓取最新权威网页文献，正文角标一一对应直达引用源
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                    <FileDown className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 block mb-0.5">
                      高清长图与 Markdown 导出
                    </span>
                    <span className="text-xxs text-slate-500 dark:text-slate-400 leading-relaxed block">
                      一键生成超高清晰度架构全景图及分层 Markdown 文档
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: 安全与账号 —— 改密表单无条件展示（has_password=false 微信死分支已删除） */}
        {activeTab === 'security' && (
          <div className="space-y-6">
            <div className="p-5 rounded-xl bg-slate-50/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    修改账号密码
                  </span>
                </div>
                <span className="text-xxs text-slate-400">修改成功后需重新登录</span>
              </div>

              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="user-profile-old-password"
                    className="text-xxs text-slate-500 dark:text-slate-400 block mb-1"
                  >
                    当前旧密码
                  </label>
                  <input
                    id="user-profile-old-password"
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="输入当前密码"
                    autoComplete="current-password"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="user-profile-new-password"
                      className="text-xxs text-slate-500 dark:text-slate-400 block mb-1"
                    >
                      新密码 (至少 6 位)
                    </label>
                    <input
                      id="user-profile-new-password"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="输入新密码"
                      autoComplete="new-password"
                      className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="user-profile-confirm-password"
                      className="text-xxs text-slate-500 dark:text-slate-400 block mb-1"
                    >
                      确认新密码
                    </label>
                    <input
                      id="user-profile-confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="再次输入新密码"
                      autoComplete="new-password"
                      className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  id="user-profile-change-password-btn"
                  onClick={handleChangePassword}
                  disabled={changingPassword || !oldPassword || !newPassword || !confirmPassword}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 disabled:pointer-events-none rounded-xl transition shadow-sm"
                >
                  {changingPassword ? (
                    <>
                      <Spinner size="sm" />
                      正在更新密码…
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-3.5 h-3.5" />
                      更新密码
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* 会话安全与合规保护说明 */}
            <div className="p-4 rounded-xl bg-slate-50/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 flex items-start gap-3 text-xs">
              <Shield className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
              <div className="space-y-1 text-slate-600 dark:text-slate-400 text-xxs leading-relaxed">
                <span className="font-semibold text-slate-800 dark:text-slate-200 block">
                  会话安全与数据隔离说明
                </span>
                <p>
                  密码使用工业级高强度 scrypt 算法加盐散列。密码修改后，服务端将即刻注销所有历史终端会话以防凭证泄露。
                </p>
              </div>
            </div>

            {/* 危险操作区 (注销账号) */}
            <div className="p-4 rounded-xl bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/80 dark:border-rose-900/40 flex items-center justify-between gap-4">
              <div className="text-xs">
                <span className="font-semibold text-rose-700 dark:text-rose-400 block mb-0.5">
                  注销账号
                </span>
                <span className="text-xxs text-rose-600/80 dark:text-rose-400/70 leading-relaxed block">
                  注销后账号将立即停用，个人画板数据保留 30 天，期内可联系管理员恢复。
                </span>
              </div>

              <button
                type="button"
                id="user-profile-delete-btn"
                onClick={handleDeleteAccount}
                disabled={deleting}
                className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:text-white hover:bg-rose-600 active:bg-rose-700 border border-rose-300 dark:border-rose-800 rounded-xl transition-all disabled:opacity-50"
              >
                {deleting ? (
                  <>
                    <Spinner size="sm" />
                    注销中…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    注销此账号
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Status Toast Banner */}
      {statusMsg && (
        <div className="px-6 py-2">
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
            <StatusBanner
              type={statusMsg.type}
              unstyled
              icon={
                statusMsg.type === 'success' ? (
                  <Check className="w-4 h-4 shrink-0 text-emerald-500" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                )
              }
              className={`p-3 rounded-xl text-xs font-medium ${
                statusMsg.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
              }`}
            >
              <span>{statusMsg.text}</span>
            </StatusBanner>
          </motion.div>
        </div>
      )}

      {/* Footer：文案与关闭行为由宿主注入（弹窗「取消」，页面「返回首页」） */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/30">
        <span className="text-xxs text-slate-400">枝想 Arborize · 思维拓扑工作台</span>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            id="user-profile-cancel-btn"
            onClick={handleClose}
            className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl transition-colors"
          >
            {cancelLabel}
          </button>
          {activeTab === 'profile' && (
            <button
              type="button"
              id="user-profile-save-btn"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-sm flex items-center gap-1.5 transition-all"
            >
              {saving ? (
                <>
                  <Spinner size="sm" />
                  保存中…
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  保存资料
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Promise 化确认框（注销账号等）随共享组件一起维护 */}
      {confirmElement}
    </>
  );
};
