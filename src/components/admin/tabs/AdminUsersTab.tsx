/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  CheckCircle2,
  XCircle,
  Crown,
  Mail,
  Lock,
  Unlock,
  RefreshCw,
} from 'lucide-react';
import { AuthUser } from '../../../types';
import { Tooltip } from '../../ui/Tooltip';
import { VipGrantModal } from '../modals/VipGrantModal';
import { UserEmailModal } from '../modals/UserEmailModal';

export interface AdminUsersTabProps {
  currentUserId?: string;
  onFeedback: (message: string) => void;
}

export const AdminUsersTab: React.FC<AdminUsersTabProps> = ({
  currentUserId,
  onFeedback,
}) => {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('all');
  const [userStatusFilter, setUserStatusFilter] = useState('all');
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Sub-modal states
  const [vipTargetUser, setVipTargetUser] = useState<AuthUser | null>(null);
  const [emailTargetUser, setEmailTargetUser] = useState<AuthUser | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const params = new URLSearchParams({
        page: userPage.toString(),
        limit: '10',
        search: userSearch,
        role: userRoleFilter,
        status: userStatusFilter,
      });
      const res = await fetch(`/api/admin/users?${params.toString()}`, { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        setUsers(data.users || []);
        setUserTotal(data.total || 0);
      }
    } catch (e) {
      console.error('Fetch users error:', e);
    } finally {
      setLoadingUsers(false);
    }
  }, [userPage, userSearch, userRoleFilter, userStatusFilter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleToggleUserStatus = async (targetUser: AuthUser) => {
    const nextStatus = !targetUser.is_active;
    const actionName = nextStatus ? '解冻账号' : '冻结账号';
    if (!window.confirm(`确定要${actionName} "${targetUser.email}" 吗？`)) return;

    try {
      const res = await fetch(`/api/admin/users/${targetUser.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: nextStatus }),
      });
      const d = await res.json();
      if (res.ok) {
        onFeedback(`已成功${actionName}`);
        fetchUsers();
      } else {
        onFeedback(d.error || '操作失败');
      }
    } catch (e: any) {
      onFeedback(e?.message || '网络异常');
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={userSearch}
            onChange={(e) => {
              setUserSearch(e.target.value);
              setUserPage(1);
            }}
            placeholder="按邮箱或昵称搜索用户..."
            className="w-full bg-transparent text-xs text-slate-800 dark:text-slate-100 focus:outline-none placeholder-slate-400"
          />
        </div>
        <div className="flex items-center gap-2">
          <select
            value={userRoleFilter}
            onChange={(e) => {
              setUserRoleFilter(e.target.value);
              setUserPage(1);
            }}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none"
          >
            <option value="all">所有角色</option>
            <option value="user">普通用户 (user)</option>
            <option value="vip">VIP 高阶用户 (vip)</option>
            <option value="admin">系统管理员 (admin)</option>
          </select>
          <select
            value={userStatusFilter}
            onChange={(e) => {
              setUserStatusFilter(e.target.value);
              setUserPage(1);
            }}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none"
          >
            <option value="all">所有状态</option>
            <option value="active">正常</option>
            <option value="frozen">已冻结</option>
          </select>
          <Tooltip content="刷新用户列表">
            <button
              onClick={fetchUsers}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Users Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700/80">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th className="py-3 px-4 font-semibold">用户 / 邮箱</th>
              <th className="py-3 px-3 font-semibold">角色</th>
              <th className="py-3 px-3 font-semibold">状态</th>
              <th className="py-3 px-3 font-semibold">会员状态 / 剩余天数</th>
              <th className="py-3 px-3 font-semibold">画板数</th>
              <th className="py-3 px-4 font-semibold text-right">特权与管控</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
            {loadingUsers ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-400">
                  正在加载用户列表...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-400">
                  未检索到符合条件的用户
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const remainingDays = u.role === 'admin'
                  ? '永久有效'
                  : u.vip_expires_at
                  ? Math.max(0, Math.ceil((new Date(u.vip_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
                  : 0;

                return (
                  <tr key={u.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{u.name}</div>
                      <div className="text-[11px] text-slate-400 font-mono truncate max-w-[180px]">
                        {u.email}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          u.role === 'admin'
                            ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/80 dark:text-rose-300'
                            : u.role === 'vip'
                            ? 'bg-purple-100 text-purple-700 dark:bg-purple-950/80 dark:text-purple-300'
                            : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {u.role.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      {u.is_active !== false ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5" /> 正常
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-500 text-[11px]">
                          <XCircle className="w-3.5 h-3.5" /> 已冻结
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      {u.role === 'admin' ? (
                        <span className="font-medium text-rose-600 dark:text-rose-400 text-xs">
                          永久有效 (Admin)
                        </span>
                      ) : typeof remainingDays === 'number' && remainingDays > 0 ? (
                        <div className="space-y-0.5">
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400 text-xs">
                            <Crown className="w-3.5 h-3.5" /> 剩余 {remainingDays} 天
                          </span>
                          {u.vip_expires_at && (
                            <div className="text-[10px] text-slate-400">
                              至 {new Date(u.vip_expires_at).toLocaleDateString('zh-CN')}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400 text-xs">
                          基础免费版 (0天)
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-slate-500">{u.canvas_count ?? 0} 个</td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Tooltip content="授权或增减 VIP 会员天数">
                          <button
                            onClick={() => setVipTargetUser(u)}
                            className="px-2.5 py-1 rounded bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/60 dark:hover:bg-amber-900/80 text-amber-700 dark:text-amber-300 text-xs font-semibold transition-colors inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Crown className="w-3 h-3" />
                            <span>授权VIP</span>
                          </button>
                        </Tooltip>
                        <Tooltip content="修改用户登录邮箱（需重新验证）">
                          <button
                            onClick={() => setEmailTargetUser(u)}
                            className="px-2.5 py-1 rounded bg-sky-50 hover:bg-sky-100 dark:bg-sky-950/60 dark:hover:bg-sky-900/80 text-sky-700 dark:text-sky-300 text-xs font-semibold transition-colors inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Mail className="w-3 h-3" />
                            <span>改邮箱</span>
                          </button>
                        </Tooltip>
                        {u.id !== currentUserId && (
                          <Tooltip content={u.is_active !== false ? '冻结该用户登录与调用' : '解冻恢复该用户'}>
                            <button
                              onClick={() => handleToggleUserStatus(u)}
                              className={`p-1 rounded text-xs transition-colors cursor-pointer ${
                                u.is_active !== false
                                  ? 'text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50'
                                  : 'text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50'
                              }`}
                            >
                              {u.is_active !== false ? (
                                <Lock className="w-3.5 h-3.5" />
                              ) : (
                                <Unlock className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-2">
        <span>共 {userTotal} 位用户</span>
        <div className="flex items-center gap-2">
          <button
            disabled={userPage <= 1}
            onClick={() => setUserPage((p) => p - 1)}
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span>第 {userPage} 页</span>
          <button
            disabled={userPage * 10 >= userTotal}
            onClick={() => setUserPage((p) => p + 1)}
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      </div>

      {/* Sub-modals */}
      <VipGrantModal
        targetUser={vipTargetUser}
        onClose={() => setVipTargetUser(null)}
        onSuccess={(msg) => {
          onFeedback(msg);
          setVipTargetUser(null);
          fetchUsers();
        }}
      />

      <UserEmailModal
        targetUser={emailTargetUser}
        onClose={() => setEmailTargetUser(null)}
        onSuccess={(msg) => {
          onFeedback(msg);
          setEmailTargetUser(null);
          fetchUsers();
        }}
      />
    </div>
  );
};
