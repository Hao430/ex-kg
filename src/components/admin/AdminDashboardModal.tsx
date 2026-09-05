import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  AdminOverview,
  CreditTransaction,
  AuthUser,
} from '../../types';
import {
  ShieldAlert,
  Users,
  BarChart3,
  Receipt,
  Search,
  CheckCircle2,
  XCircle,
  Coins,
  RefreshCw,
  X,
  PlusCircle,
  MinusCircle,
  Database,
  Cpu,
  Lock,
  Unlock,
  Sparkles,
} from 'lucide-react';

export const AdminDashboardModal: React.FC = () => {
  const { adminModalOpen, closeAdminModal, user } = useAuth();
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'transactions'>('overview');

  // Overview state
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);

  // Users state
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('all');
  const [userStatusFilter, setUserStatusFilter] = useState('all');
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Adjust credit modal state
  const [adjustTargetUser, setAdjustTargetUser] = useState<AuthUser | null>(null);
  const [adjustAmount, setAdjustAmount] = useState<number>(10000);
  const [adjustReason, setAdjustReason] = useState('运营补偿赠送');
  const [submittingAdjust, setSubmittingAdjust] = useState(false);

  // Transactions state
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txPage, setTxPage] = useState(1);
  const [loadingTx, setLoadingTx] = useState(false);

  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const [ovRes, dbRes] = await Promise.all([
        fetch('/api/admin/overview', { credentials: 'include' }),
        fetch('/api/db/status', { credentials: 'include' }),
      ]);
      if (ovRes.ok) {
        const d = await ovRes.json();
        setOverview(d.overview);
      }
      if (dbRes.ok) {
        const d = await dbRes.json();
        setDbInfo(d);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const params = new URLSearchParams({
        page: String(userPage),
        limit: '8',
      });
      if (userSearch.trim()) params.set('search', userSearch.trim());
      if (userRoleFilter !== 'all') params.set('role', userRoleFilter);
      if (userStatusFilter !== 'all') params.set('status', userStatusFilter);

      const res = await fetch(`/api/admin/users?${params.toString()}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const d = await res.json();
        setUsers(d.users || []);
        setUserTotal(d.total || 0);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingUsers(false);
    }
  }, [userPage, userSearch, userRoleFilter, userStatusFilter]);

  const fetchTransactions = useCallback(async () => {
    setLoadingTx(true);
    try {
      const res = await fetch(`/api/admin/transactions?page=${txPage}&limit=12`, {
        credentials: 'include',
      });
      if (res.ok) {
        const d = await res.json();
        setTransactions(d.transactions || []);
        setTxTotal(d.total || 0);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingTx(false);
    }
  }, [txPage]);

  useEffect(() => {
    if (adminModalOpen) {
      if (activeTab === 'overview') fetchOverview();
      else if (activeTab === 'users') fetchUsers();
      else if (activeTab === 'transactions') fetchTransactions();
    }
  }, [adminModalOpen, activeTab, fetchOverview, fetchUsers, fetchTransactions]);

  if (!adminModalOpen) return null;

  const handleToggleFreeze = async (targetUser: AuthUser) => {
    const nextStatus = !targetUser.is_active;
    const actionName = nextStatus ? '解封' : '冻结并强制踢下线';
    if (!window.confirm(`确定要${actionName}用户 ${targetUser.email} 吗？`)) return;

    try {
      const res = await fetch(`/api/admin/users/${targetUser.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: nextStatus }),
      });
      const d = await res.json();
      if (res.ok) {
        setFeedback(`已成功${actionName}`);
        fetchUsers();
      } else {
        setFeedback(d.error || '操作失败');
      }
    } catch (e: any) {
      setFeedback(e?.message || '网络异常');
    }
  };

  const handleAdjustCredits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustTargetUser) return;

    setSubmittingAdjust(true);
    try {
      const res = await fetch(`/api/admin/users/${adjustTargetUser.id}/credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          amount: adjustAmount,
          reason: adjustReason,
        }),
      });
      const d = await res.json();
      if (res.ok) {
        setFeedback(d.message);
        setAdjustTargetUser(null);
        fetchUsers();
      } else {
        setFeedback(d.error || '调账失败');
      }
    } catch (e: any) {
      setFeedback(e?.message || '操作失败');
    } finally {
      setSubmittingAdjust(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-5xl h-[85vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                  DeepDive 运营管理控制台
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                  商业级 RBAC
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                当前管理员：{user?.email} · 具备全局用户管控与商业对账权限
              </p>
            </div>
          </div>
          <button
            onClick={closeAdminModal}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/30 shrink-0">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'overview'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            运营大盘概览
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'users'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            用户与算力管控
          </button>
          <button
            onClick={() => setActiveTab('transactions')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'transactions'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Receipt className="w-3.5 h-3.5" />
            商业流水与计量账单
          </button>
        </div>

        {/* Feedback banner */}
        {feedback && (
          <div className="mx-6 mt-3 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between text-xs text-indigo-700 dark:text-indigo-300">
            <span>{feedback}</span>
            <button onClick={() => setFeedback(null)} className="text-indigo-400 hover:text-indigo-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Stat Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">总注册用户</div>
                  <div className="text-xl font-bold text-slate-900 dark:text-white">
                    {overview?.totalUsers ?? '...'}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">近7日活跃 (WAU)</div>
                  <div className="text-xl font-bold text-indigo-600 dark:text-indigo-400">
                    {overview?.activeUsers7d ?? '...'}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">VIP 高阶会员</div>
                  <div className="text-xl font-bold text-amber-600 dark:text-amber-400">
                    {overview?.vipUsers ?? '...'}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">活跃思维画布数</div>
                  <div className="text-xl font-bold text-slate-900 dark:text-white">
                    {overview?.totalCanvases ?? '...'}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">今日消耗 Token</div>
                  <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
                    {(overview?.todayTokens || 0).toLocaleString()}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">当月消耗 Token</div>
                  <div className="text-xl font-bold text-slate-900 dark:text-white">
                    {(overview?.monthlyTokens || 0).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Database & Infrastructure Status */}
              <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-850 border border-slate-200/80 dark:border-slate-800">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-indigo-600" />
                    <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                      底座数据存储与事务状态
                    </h4>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      dbInfo?.connected
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {dbInfo?.type === 'postgresql' ? 'PostgreSQL 数据库在线' : '高性能内存镜像'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
                  {dbInfo?.message || '正在检测存储状态...'}
                </p>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60">
                    <span className="text-slate-500">多租户画板总数：</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 ml-1">
                      {dbInfo?.canvasCount ?? 0}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60">
                    <span className="text-slate-500">思维节点总数：</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 ml-1">
                      {dbInfo?.nodeCount ?? 0}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60">
                    <span className="text-slate-500">租户隔离状态：</span>
                    <span className="font-semibold text-emerald-600 ml-1">WHERE user_id = $1 (Strict IDOR Protected)</span>
                  </div>
                </div>
              </div>

              {/* Model Distribution */}
              <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-850 border border-slate-200/80 dark:border-slate-800">
                <div className="flex items-center gap-2 mb-4">
                  <Cpu className="w-4 h-4 text-indigo-600" />
                  <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    大模型调用热度分布
                  </h4>
                </div>
                <div className="space-y-3">
                  {overview?.modelDistribution && Object.keys(overview.modelDistribution).length > 0 ? (
                    Object.entries(overview.modelDistribution).map(([modelName, count]) => {
                      const totalCount = Object.values(overview.modelDistribution).reduce((a, b) => a + b, 0) || 1;
                      const pct = Math.round((count / totalCount) * 100);
                      return (
                        <div key={modelName} className="space-y-1">
                          <div className="flex justify-between text-xs font-medium">
                            <span className="text-slate-700 dark:text-slate-300">{modelName}</span>
                            <span className="text-slate-500">
                              {count} 次 ({pct}%)
                            </span>
                          </div>
                          <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-indigo-600 dark:bg-indigo-500 transition-all duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-xs text-slate-400 py-4 text-center">暂无调用记录</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: USERS */}
          {activeTab === 'users' && (
            <div className="space-y-4">
              {/* Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60">
                <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={userSearch}
                    onChange={(e) => {
                      setUserSearch(e.target.value);
                      setUserPage(1);
                    }}
                    placeholder="按邮箱或昵称搜索..."
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
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 focus:outline-none"
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
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="all">所有状态</option>
                    <option value="active">正常</option>
                    <option value="frozen">已冻结</option>
                  </select>
                  <button
                    onClick={fetchUsers}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Users Table */}
              <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/75 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <tr>
                      <th className="py-3 px-4 font-semibold">用户 / 邮箱</th>
                      <th className="py-3 px-3 font-semibold">角色权限</th>
                      <th className="py-3 px-3 font-semibold">算力余额</th>
                      <th className="py-3 px-3 font-semibold">画布数</th>
                      <th className="py-3 px-3 font-semibold">消耗 Token</th>
                      <th className="py-3 px-3 font-semibold">账号状态</th>
                      <th className="py-3 px-4 font-semibold text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                    {loadingUsers ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          正在加载用户列表...
                        </td>
                      </tr>
                    ) : users.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          未找到匹配的用户
                        </td>
                      </tr>
                    ) : (
                      users.map((u) => (
                        <tr key={u.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-800 dark:text-slate-100">
                              {u.name || '未命名'}
                            </div>
                            <div className="text-[11px] text-slate-400">{u.email}</div>
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                u.role === 'admin'
                                  ? 'bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300'
                                  : u.role === 'vip'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                                  : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                              }`}
                            >
                              {u.role.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-3 px-3 font-medium">
                            <span className="text-indigo-600 dark:text-indigo-400">
                              {u.credits_balance.toLocaleString()}
                            </span>{' '}
                            <span className="text-[10px] text-slate-400">点</span>
                          </td>
                          <td className="py-3 px-3">{u.canvas_count ?? 0} 个</td>
                          <td className="py-3 px-3">{(u.total_tokens_used ?? 0).toLocaleString()}</td>
                          <td className="py-3 px-3">
                            {u.is_active ? (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="w-3 h-3" />
                                正常
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-semibold">
                                <XCircle className="w-3 h-3" />
                                已冻结
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => {
                                  setAdjustTargetUser(u);
                                  setAdjustAmount(10000);
                                  setAdjustReason('运营调账赠送');
                                }}
                                title="手动增加/扣减算力"
                                className="px-2 py-1 rounded bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 text-[11px] font-medium"
                              >
                                调账
                              </button>
                              {u.id !== user?.id && (
                                <button
                                  onClick={() => handleToggleFreeze(u)}
                                  className={`px-2 py-1 rounded text-[11px] font-medium ${
                                    u.is_active
                                      ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 hover:bg-rose-100'
                                      : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 hover:bg-emerald-100'
                                  }`}
                                >
                                  {u.is_active ? '冻结' : '解封'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
                <span>共 {userTotal} 名用户</span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={userPage <= 1}
                    onClick={() => setUserPage((p) => p - 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span>第 {userPage} 页</span>
                  <button
                    disabled={userPage * 8 >= userTotal}
                    onClick={() => setUserPage((p) => p + 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: TRANSACTIONS */}
          {activeTab === 'transactions' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  每笔 AI 推理调用与充值调账均有不可篡改的流水凭据（共 {txTotal} 笔记录）
                </p>
                <button
                  onClick={fetchTransactions}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/75 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <tr>
                      <th className="py-3 px-4 font-semibold">时间</th>
                      <th className="py-3 px-3 font-semibold">用户邮箱</th>
                      <th className="py-3 px-3 font-semibold">业务类型</th>
                      <th className="py-3 px-3 font-semibold">模型/原因</th>
                      <th className="py-3 px-3 font-semibold">变动点数</th>
                      <th className="py-3 px-4 font-semibold text-right">变动后余额</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                    {loadingTx ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          正在加载流水账单...
                        </td>
                      </tr>
                    ) : transactions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          暂无对账流水
                        </td>
                      </tr>
                    ) : (
                      transactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                          <td className="py-3 px-4 text-slate-500 text-[11px]">
                            {new Date(tx.created_at).toLocaleString('zh-CN', { hour12: false })}
                          </td>
                          <td className="py-3 px-3 font-medium text-slate-800 dark:text-slate-200">
                            {tx.user_email || '未知用户'}
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                tx.action_type === 'ai_chat'
                                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                              }`}
                            >
                              {tx.action_type === 'ai_chat' ? 'AI 推理扣减' : '系统调账/充值'}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-600 dark:text-slate-400 truncate max-w-[200px]">
                            {tx.model_name}
                          </td>
                          <td className="py-3 px-3 font-medium">
                            {tx.tokens_consumed > 0 ? (
                              <span className="text-rose-600 dark:text-rose-400">
                                -{tx.tokens_consumed.toLocaleString()}
                              </span>
                            ) : (
                              <span className="text-emerald-600 dark:text-emerald-400">
                                +{Math.abs(tx.tokens_consumed).toLocaleString()}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-slate-900 dark:text-white">
                            {tx.balance_after.toLocaleString()} 点
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
                <span>共 {txTotal} 笔流水</span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={txPage <= 1}
                    onClick={() => setTxPage((p) => p - 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span>第 {txPage} 页</span>
                  <button
                    disabled={txPage * 12 >= txTotal}
                    onClick={() => setTxPage((p) => p + 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal for Adjust Credits */}
        {adjustTargetUser && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
            <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-5">
              <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-1">
                人工调账点数
              </h4>
              <p className="text-xs text-slate-500 mb-4">
                目标用户：{adjustTargetUser.email} (当前余额：{adjustTargetUser.credits_balance} 点)
              </p>

              <form onSubmit={handleAdjustCredits} className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
                    调整数值 (正数为增加，负数为扣减)
                  </label>
                  <input
                    type="number"
                    value={adjustAmount}
                    onChange={(e) => setAdjustAmount(parseInt(e.target.value, 10) || 0)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
                    调账原因与审计备注
                  </label>
                  <input
                    type="text"
                    required
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    placeholder="如：测试环境加点 / 运营补偿"
                    className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setAdjustTargetUser(null)}
                    className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={submittingAdjust}
                    className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium"
                  >
                    {submittingAdjust ? '提交中...' : '确认执行调账'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
