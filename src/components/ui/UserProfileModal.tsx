import React, { useState, useEffect } from 'react';
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
  Loader2,
  Camera,
  Trash2,
  KeyRound,
  Share2,
  Copy,
  CheckCircle2,
  Layers,
  Globe2,
  FileDown,
  Lock,
  AlertTriangle,
  RefreshCw,
  Clock,
  Shield,
  BadgeCheck,
} from 'lucide-react';
import { Modal } from './base/Modal';
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

type ActiveTab = 'profile' | 'membership' | 'security';

export interface UserProfileModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const { user, isVip, updateProfile, changePassword, logout } = useAuth();
  const {
    userProfileModalOpen,
    closeUserProfileModal,
    openRechargeModal,
    openMySharesModal,
  } = useModal();

  const isOpen = (propIsOpen ?? userProfileModalOpen) && Boolean(user);
  const onClose = propOnClose ?? closeUserProfileModal;

  const [activeTab, setActiveTab] = useState<ActiveTab>('profile');
  const [name, setName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('🧠');
  const [customAvatarUrl, setCustomAvatarUrl] = useState('');
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
      setSelectedAvatar(user.avatar || '🧠');
      setCustomAvatarUrl(
        user.avatar?.startsWith('http') || user.avatar?.startsWith('data:') ? user.avatar : ''
      );
      setStatusMsg(null);
    }
  }, [user, userProfileModalOpen]);

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

    const avatarValue = customAvatarUrl.trim() || selectedAvatar;
    const res = await updateProfile({
      name: name.trim(),
      avatar: avatarValue,
    });

    setSaving(false);
    if (res.success) {
      setStatusMsg({ type: 'success', text: '个人资料已更新！' });
      setTimeout(() => {
        closeUserProfileModal();
      }, 1200);
    } else {
      setStatusMsg({ type: 'error', text: res.error || '保存失败，请重试' });
    }
  };

  const handleCustomAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      setStatusMsg({ type: 'error', text: '头像图片大小不能超过 1MB' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      setCustomAvatarUrl(base64);
      setSelectedAvatar(base64);
    };
    reader.readAsDataURL(file);
  };

  const handleClearCustomAvatar = () => {
    setCustomAvatarUrl('');
    setSelectedAvatar('🧠');
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
      alert('密码已修改，请使用新密码重新登录');
    } else {
      setStatusMsg({ type: 'error', text: res.error || '修改密码失败，请重试' });
    }
  };

  // Spec F4：自助注销账号（软删除，30 天内可联系管理员恢复）
  const handleDeleteAccount = async () => {
    if (!confirm('注销后 30 天内可联系管理员恢复，确认注销？')) return;

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
        const body = await res.json().catch(() => null);
        setStatusMsg({ type: 'error', text: body?.message || '注销失败，请稍后重试' });
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

  const isCustomAvatar = selectedAvatar.startsWith('data:') || selectedAvatar.startsWith('http');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      showCloseButton={false}
      className="relative w-full max-w-2xl bg-white dark:bg-[#0f172a] border border-slate-200/90 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-slate-900 dark:text-slate-100 p-0"
    >
      <div id="user-profile-modal-container" className="flex flex-col w-full h-full min-h-0 overflow-hidden">
        {user && (
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
                  <p className="text-[12px] text-slate-500 dark:text-slate-400">
                    管理您的个人偏好、身份标识与账户安全
                  </p>
                </div>
              </div>
              <button
                id="user-profile-close-btn"
                onClick={onClose}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title="关闭"
              >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* User Hero Overview Bar */}
          <div className="px-6 py-5 bg-gradient-to-b from-slate-50/50 to-white dark:from-slate-900/50 dark:to-[#0f172a] border-b border-slate-100 dark:border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {/* Avatar Preview Ring */}
              <div className="relative group shrink-0">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-purple-600 p-0.5 shadow-md">
                  <div className="w-full h-full rounded-[14px] bg-white dark:bg-slate-900 flex items-center justify-center overflow-hidden text-2xl font-bold">
                    {isCustomAvatar ? (
                      <img
                        src={selectedAvatar}
                        alt="avatar"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span>{selectedAvatar || '🧠'}</span>
                    )}
                  </div>
                </div>

                <label
                  htmlFor="avatar-upload-input"
                  className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 flex items-center justify-center shadow-md cursor-pointer hover:scale-110 active:scale-95 transition-all"
                  title="上传本地图片作为头像"
                >
                  <Camera className="w-3 h-3" />
                  <input
                    id="avatar-upload-input"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleCustomAvatarUpload}
                  />
                </label>
              </div>

              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                    {name || '思维探索者'}
                  </span>
                  {user.role === 'admin' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                      <ShieldCheck className="w-3 h-3" /> 管理员
                    </span>
                  ) : isVip ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60">
                      <Crown className="w-3 h-3 text-amber-500" /> VIP 尊享会员
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      免费体验版
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-1 text-xs text-slate-500 dark:text-slate-400">
                  <span className="flex items-center gap-1 font-mono">
                    <Mail className="w-3.5 h-3.5 text-slate-400" />
                    {user.email}
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
                    <span className="text-[11px] text-slate-400 font-normal">
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

                {/* 个性化头像精选 */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      选择专属思维徽标
                    </span>
                    {isCustomAvatar && (
                      <button
                        type="button"
                        onClick={handleClearCustomAvatar}
                        className="text-[11px] text-rose-500 hover:text-rose-600 dark:text-rose-400 font-medium hover:underline"
                      >
                        清除已上传图片，恢复图标头像
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2.5">
                    {PRESET_AVATARS.map((preset) => {
                      const isSelected = selectedAvatar === preset.emoji && !customAvatarUrl;
                      return (
                        <button
                          key={preset.emoji}
                          type="button"
                          onClick={() => {
                            setSelectedAvatar(preset.emoji);
                            setCustomAvatarUrl('');
                          }}
                          className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all ${
                            isSelected
                              ? 'bg-indigo-50 dark:bg-indigo-950/60 border-2 border-indigo-500 shadow-sm text-slate-900 dark:text-white scale-102'
                              : 'bg-slate-50 dark:bg-slate-900/60 hover:bg-slate-100 dark:hover:bg-slate-800/80 border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          <span className="text-2xl mb-1">{preset.emoji}</span>
                          <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
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
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-normal">
                      <BadgeCheck className="w-3.5 h-3.5" />
                      邮箱安全保护已激活
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="flex items-center justify-between p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800">
                      <span className="text-slate-500 dark:text-slate-400">用户 ID</span>
                      <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
                        <span>{user.id ? `${user.id.slice(0, 10)}...` : 'N/A'}</span>
                        {user.id && (
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
                        {user.role === 'admin'
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
                          {user.email}
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
                    user.role === 'admin'
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
                          user.role === 'admin'
                            ? 'bg-emerald-600 text-white'
                            : isVip
                            ? 'bg-amber-500 text-white'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {user.role === 'admin' ? (
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
                            {user.role === 'admin'
                              ? '超级管理员权益'
                              : isVip
                              ? 'VIP 尊享版会员'
                              : '基础免费探索版'}
                          </h4>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${
                              user.role === 'admin'
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300'
                                : isVip
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300'
                                : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            }`}
                          >
                            {user.role === 'admin'
                              ? '全量特权'
                              : isVip
                              ? '特权生效中'
                              : '受限体验'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          {user.role === 'admin'
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
                      <span className="text-[11px] text-slate-400 block mb-0.5">剩余有效期</span>
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
                      <span className="text-[11px] text-slate-400 block mb-0.5">到期日期</span>
                      <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        {user.role === 'admin' ? '永久有效' : vipExpDate || '永久基础版'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[11px] text-slate-400 block mb-0.5">推演通道</span>
                      <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                        {isVip ? 'VIP 独占高速集群' : '标准并发通道'}
                      </span>
                    </div>
                  </div>
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
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed block">
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
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed block">
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
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed block">
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
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed block">
                          一键生成超高清晰度架构全景图及分层 Markdown 文档
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: 安全与账号 */}
            {activeTab === 'security' && (
              <div className="space-y-6">
                {/* 防御性分支：服务端仍按账号派生 `has_password`（ADR-0022 时代为「微信自动建号
                    的账号没有可用口令」而设）。2026-09-16 撤销微信登录入口后，注册路径只有
                    邮箱 + 密码，该标记恒为 true，用户不会再看到这张卡；保留它是因为判据是
                    服务端字段而非前端常量——将来若再出现无口令的账号（例如新的第三方登录），
                    这里不会给出一个「点了必然失败」的改密表单。 */}
                {user.has_password === false ? (
                  <div className="p-4 rounded-xl bg-slate-50/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 flex items-start gap-3 text-xs">
                    <Shield className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <div className="space-y-1 text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                      <span className="font-semibold text-slate-800 dark:text-slate-200 block">
                        本账号通过微信登录
                      </span>
                      <p>账号未设置独立密码，登录凭据由微信提供，无需也无法在此修改密码。</p>
                    </div>
                  </div>
                ) : (
                <div className="p-5 rounded-xl bg-slate-50/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                        修改账号密码
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400">修改成功后需重新登录</span>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor="user-profile-old-password"
                        className="text-[11px] text-slate-500 dark:text-slate-400 block mb-1"
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
                          className="text-[11px] text-slate-500 dark:text-slate-400 block mb-1"
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
                          className="text-[11px] text-slate-500 dark:text-slate-400 block mb-1"
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
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          正在更新密码...
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
                )}

                {/* 会话安全与合规保护说明 */}
                <div className="p-4 rounded-xl bg-slate-50/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 flex items-start gap-3 text-xs">
                  <Shield className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                    <span className="font-semibold text-slate-800 dark:text-slate-200 block">
                      会话安全与多租户隔离规范
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
                    <span className="text-[11px] text-rose-600/80 dark:text-rose-400/70 leading-relaxed block">
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
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        注销中...
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
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${
                  statusMsg.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                    : 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                }`}
              >
                {statusMsg.type === 'success' ? (
                  <Check className="w-4 h-4 shrink-0 text-emerald-500" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                )}
                <span>{statusMsg.text}</span>
              </motion.div>
            </div>
          )}

          {/* Modal Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/30">
            <span className="text-[11px] text-slate-400">
              枝想 Arborize · 思维拓扑工作台
            </span>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                id="user-profile-cancel-btn"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl transition-colors"
              >
                取消
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
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      保存中...
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
        </>
      )}
    </div>
  </Modal>
);
};
