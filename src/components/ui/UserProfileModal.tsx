import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
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
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

// 8 curated premium avatars (SVG/Emoji style)
const PRESET_AVATARS = [
  '⚡',
  '🚀',
  '🧠',
  '🎨',
  '🦊',
  '🦉',
  '💎',
  '🪐',
  '🐱',
  '🦁',
  '🌟',
  '🔮',
];

export const UserProfileModal: React.FC = () => {
  const { user, isVip, userProfileModalOpen, closeUserProfileModal, updateProfile, changePassword, openRechargeModal, logout } = useAuth();

  const [name, setName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('🧠');
  const [customAvatarUrl, setCustomAvatarUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 修改密码
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setSelectedAvatar(user.avatar || '🧠');
      setCustomAvatarUrl(user.avatar?.startsWith('http') || user.avatar?.startsWith('data:') ? user.avatar : '');
      setStatusMsg(null);
    }
  }, [user, userProfileModalOpen]);

  if (!userProfileModalOpen || !user) return null;

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

  const remainingVipDays = user.role === 'admin'
    ? '永久有效'
    : user.vip_expires_at
    ? Math.max(0, Math.ceil((new Date(user.vip_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  const vipExpDate = user.vip_expires_at
    ? new Date(user.vip_expires_at).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  return (
    <AnimatePresence>
      <div
        id="user-profile-modal-backdrop"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeUserProfileModal();
        }}
      >
        <motion.div
          id="user-profile-modal-container"
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl text-slate-100"
        >
          {/* Header Banner */}
          <div className="relative h-28 bg-gradient-to-r from-indigo-950 via-purple-950 to-slate-900 border-b border-slate-800/80 p-6 flex justify-between items-start">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-wide text-indigo-300">
                个人中心与账户设置
              </span>
            </div>
            <button
              id="user-profile-close-btn"
              onClick={closeUserProfileModal}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800/60 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form and Details */}
          <form onSubmit={handleSave} className="p-6 pt-0 space-y-6">
            {/* Avatar Row */}
            <div className="relative -mt-12 flex items-end gap-4 mb-2">
              <div className="relative group">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-600 to-purple-600 border-4 border-slate-900 flex items-center justify-center text-3xl shadow-xl overflow-hidden text-white font-bold">
                  {selectedAvatar.startsWith('data:') || selectedAvatar.startsWith('http') ? (
                    <img src={selectedAvatar} alt="avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span>{selectedAvatar || '🧠'}</span>
                  )}
                </div>
                <label
                  htmlFor="avatar-upload-input"
                  className="absolute bottom-0 right-0 p-1.5 bg-slate-800 text-slate-200 hover:text-white rounded-lg border border-slate-700 shadow-md cursor-pointer group-hover:scale-105 transition"
                  title="上传自定义图片头像"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <input
                    id="avatar-upload-input"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleCustomAvatarUpload}
                  />
                </label>
              </div>

              <div className="flex-1 pb-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-bold text-white tracking-tight">{name || '探索者'}</h3>
                  {user.role === 'admin' ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      <ShieldCheck className="w-3 h-3" /> 系统管理员
                    </span>
                  ) : isVip ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      <Crown className="w-3 h-3" /> VIP 会员
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
                      普通用户
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                  <Mail className="w-3 h-3 text-slate-500" />
                  {user.email}
                </p>
              </div>
            </div>

            {/* Avatar Selector Grid */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-300">选择个性化图标头像</label>
              <div className="grid grid-cols-6 gap-2 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80">
                {PRESET_AVATARS.map((avatar) => {
                  const isSelected = selectedAvatar === avatar && !customAvatarUrl;
                  return (
                    <button
                      key={avatar}
                      type="button"
                      onClick={() => {
                        setSelectedAvatar(avatar);
                        setCustomAvatarUrl('');
                      }}
                      className={`h-10 rounded-lg text-lg flex items-center justify-center transition-all ${
                        isSelected
                          ? 'bg-indigo-600/30 border-2 border-indigo-500 scale-105 shadow-md shadow-indigo-950/50'
                          : 'bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white'
                      }`}
                    >
                      {avatar}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Nickname Input */}
            <div className="space-y-1.5">
              <label htmlFor="user-profile-name-input" className="text-xs font-medium text-slate-300 flex items-center justify-between">
                <span>用户昵称</span>
                <span className="text-slate-500 text-[11px]">将在协作、分享与记录中展示</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="user-profile-name-input"
                  type="text"
                  autoComplete="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={30}
                  placeholder="请输入您的昵称"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
              </div>
            </div>

            {/* Change Password Card */}
            <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-indigo-400" />
                  <span className="text-sm font-semibold text-slate-200">修改密码</span>
                </div>
                <span className="text-[11px] text-slate-500">修改成功后需重新登录</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  id="user-profile-old-password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleChangePassword();
                    }
                  }}
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  placeholder="旧密码"
                  autoComplete="current-password"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
                <input
                  id="user-profile-new-password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleChangePassword();
                    }
                  }}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="新密码（至少 6 位）"
                  autoComplete="new-password"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
                <input
                  id="user-profile-confirm-password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleChangePassword();
                    }
                  }}
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="确认新密码"
                  autoComplete="new-password"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  id="user-profile-change-password-btn"
                  onClick={handleChangePassword}
                  disabled={changingPassword}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 rounded-lg transition"
                >
                  {changingPassword ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      提交中...
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-3.5 h-3.5" />
                      确认修改
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Membership & Rights Overview Card */}
            <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Crown className={`w-4 h-4 ${isVip ? 'text-amber-400' : 'text-slate-400'}`} />
                  <span className="text-sm font-semibold text-slate-200">
                    {isVip ? 'VIP 尊享特权生效中' : '升级至 VIP 享受全部特权'}
                  </span>
                </div>
                {!isVip && (
                  <button
                    type="button"
                    onClick={() => {
                      closeUserProfileModal();
                      openRechargeModal('升级 VIP 解锁全部高级功能');
                    }}
                    className="text-xs font-semibold text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 px-2.5 py-1 rounded-lg transition"
                  >
                    立即升级
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2.5 text-xs">
                <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block mb-0.5 text-[11px]">会员特权状态</span>
                  <span className="font-semibold text-slate-200 truncate block">
                    {user.role === 'admin'
                      ? '超级管理员'
                      : isVip
                      ? 'VIP 尊享版'
                      : '基础免费版'}
                  </span>
                </div>

                <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block mb-0.5 text-[11px]">会员剩余天数</span>
                  <span className={`font-semibold truncate block ${typeof remainingVipDays === 'number' && remainingVipDays > 0 ? 'text-amber-400' : 'text-slate-200'}`}>
                    {typeof remainingVipDays === 'number'
                      ? remainingVipDays > 0
                        ? `${remainingVipDays} 天`
                        : '已到期'
                      : remainingVipDays}
                  </span>
                </div>

                <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block mb-0.5 text-[11px]">会员到期时间</span>
                  <span className="font-medium text-slate-300 truncate block text-[11px]">
                    {user.role === 'admin' ? '永久有效' : vipExpDate || '免费基础版'}
                  </span>
                </div>
              </div>

              {isVip && (
                <div className="flex items-center gap-2 text-[11px] text-amber-300/80 pt-1">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  <span>已开启全节点无限制推演、高清长图/Markdown导出与多分支思维画布</span>
                </div>
              )}
            </div>

            {/* Status Message */}
            {statusMsg && (
              <div
                className={`p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${
                  statusMsg.type === 'success'
                    ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/60'
                    : 'bg-rose-950/60 text-rose-300 border border-rose-800/60'
                }`}
              >
                {statusMsg.type === 'success' ? (
                  <Check className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <X className="w-4 h-4 flex-shrink-0" />
                )}
                <span>{statusMsg.text}</span>
              </div>
            )}

            {/* Danger Zone */}
            <div className="flex items-center justify-between bg-rose-950/30 border border-rose-900/50 rounded-xl px-4 py-3">
              <div className="text-xs text-rose-300/80">
                <span className="font-semibold text-rose-300">危险操作</span>
                <span className="block text-[11px] mt-0.5">注销后账号将被停用，30 天内可联系管理员恢复</span>
              </div>
              <button
                type="button"
                id="user-profile-delete-btn"
                onClick={handleDeleteAccount}
                disabled={deleting}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 active:bg-rose-700 disabled:opacity-50 rounded-lg shadow-md shadow-rose-950/40 transition"
              >
                {deleting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    注销中...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    注销账号
                  </>
                )}
              </button>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                id="user-profile-cancel-btn"
                onClick={closeUserProfileModal}
                className="px-4 py-2.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800 rounded-xl transition"
              >
                取消
              </button>
              <button
                type="submit"
                id="user-profile-save-btn"
                disabled={saving}
                className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-lg shadow-indigo-950/40 flex items-center gap-2 transition"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    保存中...
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    保存更改
                  </>
                )}
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
