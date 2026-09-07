import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  AdminOverview,
  AuthUser,
  AiModelConfig,
} from '../../types';
import {
  ShieldAlert,
  Users,
  BarChart3,
  Search,
  CheckCircle2,
  XCircle,
  Coins,
  Crown,
  Calendar,
  RefreshCw,
  X,
  PlusCircle,
  MinusCircle,
  Database,
  Cpu,
  Lock,
  Unlock,
  Sparkles,
  Settings2,
  Check,
  Eye,
  EyeOff,
  Activity,
  Zap,
  Sliders,
  ExternalLink,
  Mail,
} from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

export const AdminDashboardModal: React.FC = () => {
  const { adminModalOpen, closeAdminModal, user } = useAuth();
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'orders' | 'models'>('overview');

  // Overview state
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  // Spec E4：模型配置状态（false = 全站推理不可用，需醒目告警）；null = 尚未拉取
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);

  // Users state
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('all');
  const [userStatusFilter, setUserStatusFilter] = useState('all');
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Orders state (Spec E3)
  const [orders, setOrders] = useState<any[]>([]);
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderPage, setOrderPage] = useState(1);
  const [orderStatusFilter, setOrderStatusFilter] = useState('all');
  const [loadingOrders, setLoadingOrders] = useState(false);

  // VIP days management modal state
  const [vipTargetUser, setVipTargetUser] = useState<AuthUser | null>(null);
  const [vipDaysToAdd, setVipDaysToAdd] = useState<number>(30);
  const [submittingVip, setSubmittingVip] = useState(false);

  // Email change modal state
  const [emailTargetUser, setEmailTargetUser] = useState<AuthUser | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [submittingEmail, setSubmittingEmail] = useState(false);

  // AI Model Configuration state
  const [modelConfig, setModelConfig] = useState<AiModelConfig>({
    provider: 'gemini',
    openai_base_url: 'https://api.openai.com/v1',
    openai_api_key: '',
    openai_model: 'deepseek-chat',
    gemini_model: '', // 默认模型由管理员显式选择，不预置任何模型
    temperature: 0.7,
    max_tokens: 4096,
    custom_system_prompt: '',
  });
  const [rawApiKeyInput, setRawApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadingModelConfig, setLoadingModelConfig] = useState(false);
  const [savingModelConfig, setSavingModelConfig] = useState(false);
  const [testingModelConnection, setTestingModelConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    reply?: string;
    latencyMs?: number;
    modelUsed?: string;
    endpoint?: string;
    error?: string;
  } | null>(null);

  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const res = await fetch('/api/admin/overview', { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        setOverview(data.overview);
        setDbInfo(data.database);
        setModelConfigured(typeof data.modelConfigured === 'boolean' ? data.modelConfigured : null);
      }
    } catch (e) {
      console.error('Fetch overview error:', e);
    } finally {
      setLoadingOverview(false);
    }
  }, []);

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
        setUsers(data.users);
        setUserTotal(data.total);
      }
    } catch (e) {
      console.error('Fetch users error:', e);
    } finally {
      setLoadingUsers(false);
    }
  }, [userPage, userSearch, userRoleFilter, userStatusFilter]);

  const fetchOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const params = new URLSearchParams({
        page: orderPage.toString(),
        limit: '10',
        status: orderStatusFilter,
      });
      const res = await fetch(`/api/admin/orders?${params.toString()}`, { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        setOrders(data.orders || []);
        setOrderTotal(data.total || 0);
      }
    } catch (e) {
      console.error('Fetch orders error:', e);
    } finally {
      setLoadingOrders(false);
    }
  }, [orderPage, orderStatusFilter]);

  const fetchModelConfig = useCallback(async () => {
    setLoadingModelConfig(true);
    try {
      const res = await fetch('/api/admin/model-config', { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        if (data.config) {
          setModelConfig(data.config);
          setRawApiKeyInput(data.config.openai_api_key || '');
        }
      }
    } catch (e) {
      console.error('Fetch model-config error:', e);
    } finally {
      setLoadingModelConfig(false);
    }
  }, []);

  useEffect(() => {
    if (adminModalOpen && activeTab === 'orders') {
      fetchOrders();
    }
  }, [adminModalOpen, activeTab, fetchOrders]);

  useEffect(() => {
    if (adminModalOpen) {
      fetchOverview();
      fetchUsers();
      fetchModelConfig();
    }
  }, [adminModalOpen, fetchOverview, fetchUsers, fetchModelConfig]);

  if (!adminModalOpen) return null;

  // Spec E4：模型未配置 = 全站推理不可用，醒目告警横幅（Overview 与 Models 页共用）。
  // modelConfigured === null（尚未拉取）时不展示，避免闪报。
  const modelWarningBanner = modelConfigured === false ? (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 shadow-sm">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div className="text-xs text-red-800 dark:text-red-200 leading-relaxed">
          <span className="font-bold">模型未配置：全站 AI 推理当前不可用。</span>
          <span className="ml-1">用户提问将收到「模型未配置」错误，请在下方选择模型并保存。</span>
        </div>
      </div>
      <button
        onClick={() => setActiveTab('models')}
        className="shrink-0 px-3.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-sm transition-colors"
      >
        立即配置模型
      </button>
    </div>
  ) : null;

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
        setFeedback(`已成功${actionName}`);
        fetchUsers();
      } else {
        setFeedback(d.error || '操作失败');
      }
    } catch (e: any) {
      setFeedback(e?.message || '网络异常');
    }
  };

  const handleGrantVipDays = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vipTargetUser) return;

    setSubmittingVip(true);
    try {
      const res = await fetch(`/api/admin/users/${vipTargetUser.id}/vip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          days: vipDaysToAdd,
        }),
      });
      const d = await res.json();
      if (res.ok) {
        setFeedback(d.message);
        setVipTargetUser(null);
        fetchUsers();
      } else {
        setFeedback(d.error || 'VIP 授权设置失败');
      }
    } catch (e: any) {
      setFeedback(e?.message || '操作失败');
    } finally {
      setSubmittingVip(false);
    }
  };

  const handleUpdateUserEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailTargetUser) return;

    setSubmittingEmail(true);
    try {
      const res = await fetch(`/api/admin/users/${emailTargetUser.id}/email`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: newEmail.trim() }),
      });
      const d = await res.json();
      if (res.ok) {
        setFeedback(d.message);
        setEmailTargetUser(null);
        setNewEmail('');
        fetchUsers();
      } else {
        setFeedback(d.error || '修改邮箱失败');
      }
    } catch (e: any) {
      setFeedback(e?.message || '网络异常');
    } finally {
      setSubmittingEmail(false);
    }
  };

  const handleSaveModelConfig = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSavingModelConfig(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: modelConfig.provider,
          openai_base_url: modelConfig.openai_base_url,
          openai_api_key: rawApiKeyInput,
          openai_model: modelConfig.openai_model,
          gemini_model: modelConfig.gemini_model,
          temperature: modelConfig.temperature,
          max_tokens: modelConfig.max_tokens,
          custom_system_prompt: modelConfig.custom_system_prompt,
        }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setFeedback('AI 模型与接口配置已成功保存并立即生效！');
        // Spec E4：保存成功后同步刷新告警横幅状态（模型已配置 → 横幅消失）
        setModelConfigured(true);
        if (d.config) {
          setModelConfig(d.config);
          setRawApiKeyInput(d.config.openai_api_key || '');
        }
      } else {
        setFeedback(d.error || '保存失败');
      }
    } catch (e: any) {
      setFeedback(e?.message || '网络异常，保存失败');
    } finally {
      setSavingModelConfig(false);
    }
  };

  const handleTestModelConnection = async () => {
    setTestingModelConnection(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/model-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: modelConfig.provider,
          openai_base_url: modelConfig.openai_base_url,
          openai_api_key: rawApiKeyInput,
          openai_model: modelConfig.openai_model,
          gemini_model: modelConfig.gemini_model,
        }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setTestResult({
          success: true,
          message: d.message || '连接测试成功',
          reply: d.reply,
          latencyMs: d.latencyMs,
          modelUsed: d.modelUsed,
          endpoint: d.endpoint,
        });
      } else {
        setTestResult({
          success: false,
          message: '接口连接失败',
          error: d.error || '未知错误',
          latencyMs: d.latencyMs,
          endpoint: d.endpoint,
        });
      }
    } catch (e: any) {
      setTestResult({
        success: false,
        message: '网络异常，无法连接接口',
        error: e?.message || '连接超时',
      });
    } finally {
      setTestingModelConnection(false);
    }
  };

  const applyPreset = (preset: {
    provider: 'openai' | 'gemini';
    name: string;
    baseUrl: string;
    model: string;
  }) => {
    setModelConfig((prev) => ({
      ...prev,
      provider: preset.provider,
      openai_base_url: preset.baseUrl,
      openai_model: preset.model,
    }));
    setFeedback(`已载入预设: ${preset.name}（请填入对应的 API Key）`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-5xl h-[88vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/80 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-600 dark:bg-indigo-500 text-white flex items-center justify-center font-bold text-base shadow-sm">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                  枝想 运营管理与模型控制台
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                当前管理员：{user?.email} · 负责用户管理、模型配置与订阅管理
              </p>
            </div>
          </div>
          <Tooltip content="关闭管理面板" side="left">
            <button
              onClick={closeAdminModal}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/40 shrink-0">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'overview'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            运营大盘概览
          </button>
          <button
            onClick={() => setActiveTab('models')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'models'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            AI 模型与接口配置
            {modelConfig.provider === 'openai' && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'users'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            用户与会员管控
          </button>
          <button
            onClick={() => setActiveTab('orders')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'orders'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Coins className="w-3.5 h-3.5" />
            订单管理
          </button>
        </div>

        {/* Feedback Alert */}
        {feedback && (
          <div className="mx-6 mt-3 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 text-xs flex items-center justify-between animate-in fade-in">
            <span>{feedback}</span>
            <button onClick={() => setFeedback(null)} className="text-xs hover:opacity-70">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Tab Contents */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Spec E4：模型未配置醒目告警（置顶） */}
              {modelWarningBanner}
              {/* Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">注册总用户量</div>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white">
                    {overview?.totalUsers ?? '-'}
                  </div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                    近7日活跃: {overview?.activeUsers7d ?? 0}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">VIP 尊享用户</div>
                  <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                    {overview?.vipUsers ?? '-'}
                  </div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                    占比: {overview?.totalUsers ? Math.round(((overview.vipUsers || 0) / overview.totalUsers) * 100) : 0}%
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">今日消耗 Token</div>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {(overview?.todayTokens || 0).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">实时计费扣减</div>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">当月消耗 Token</div>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white">
                    {(overview?.monthlyTokens || 0).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">全站累计额度</div>
                </div>
              </div>

              {/* Database & Infrastructure Status */}
              <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      底座数据存储与事务状态
                    </h4>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      dbInfo?.connected
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300 dark:border dark:border-emerald-800/60'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-950/80 dark:text-amber-300 dark:border dark:border-amber-800/60'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {dbInfo?.type === 'postgresql' ? 'PostgreSQL 数据库在线' : '高性能内存镜像'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 mb-3">
                  {dbInfo?.message || '正在检测存储状态...'}
                </p>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80">
                    <span className="text-slate-500 dark:text-slate-400">画板总数：</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 ml-1">
                      {dbInfo?.canvasCount ?? 0}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80">
                    <span className="text-slate-500 dark:text-slate-400">思维节点总数：</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 ml-1">
                      {dbInfo?.nodeCount ?? 0}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80">
                    <span className="text-slate-500 dark:text-slate-400">数据隔离状态：</span>
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400 ml-1">已按用户严格隔离</span>
                  </div>
                </div>
              </div>

              {/* Model Distribution */}
              <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
                <div className="flex items-center gap-2 mb-4">
                  <Cpu className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
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
                            <span className="text-slate-700 dark:text-slate-200">{modelName}</span>
                            <span className="text-slate-500 dark:text-slate-400">
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

          {/* TAB: AI MODEL & API PROVIDER CONFIG */}
          {activeTab === 'models' && (
            <div className="space-y-6">
              {/* Spec E4：未配置时页内同步告警，保存成功后自动消失 */}
              {modelWarningBanner}
              <form onSubmit={handleSaveModelConfig} className="space-y-6">
                {/* Provider Selector */}
                <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                        AI 核心调用引擎与接口协议
                      </h4>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        自由切换原生 Google Gemini 或通用 OpenAI 兼容格式接口（如 DeepSeek、SiliconFlow、Moonshot、Qwen 等）
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Gemini Option */}
                    <div
                      onClick={() => setModelConfig((prev) => ({ ...prev, provider: 'gemini' }))}
                      className={`cursor-pointer p-4 rounded-xl border-2 transition-all flex items-start gap-3.5 ${
                        modelConfig.provider === 'gemini'
                          ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 shadow-xs'
                          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:border-slate-300 dark:hover:border-slate-600'
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                          modelConfig.provider === 'gemini'
                            ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-600 dark:bg-indigo-500 text-white'
                            : 'border-slate-300 dark:border-slate-600'
                        }`}
                      >
                        {modelConfig.provider === 'gemini' && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                          Google Gemini 原生引擎
                          <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                            内嵌 Google 搜索
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                          采用官方 GoogleGenAI SDK，深度支持多模态及原生 Google Search Grounding 实时检索。
                        </p>
                      </div>
                    </div>

                    {/* OpenAI Option */}
                    <div
                      onClick={() => setModelConfig((prev) => ({ ...prev, provider: 'openai' }))}
                      className={`cursor-pointer p-4 rounded-xl border-2 transition-all flex items-start gap-3.5 ${
                        modelConfig.provider === 'openai'
                          ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 shadow-xs'
                          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:border-slate-300 dark:hover:border-slate-600'
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                          modelConfig.provider === 'openai'
                            ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-600 dark:bg-indigo-500 text-white'
                            : 'border-slate-300 dark:border-slate-600'
                        }`}
                      >
                        {modelConfig.provider === 'openai' && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                          OpenAI 格式兼容协议
                          <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            DeepSeek / GPT-4o 等
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                          兼容标准 <code className="font-mono text-indigo-600 dark:text-indigo-400">/v1/chat/completions</code> 流式协议，支持主流大模型提供商及私有化部署。
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quick Presets */}
                {modelConfig.provider === 'openai' && (
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
                    <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-amber-500" />
                      一键载入主流服务商预设:
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        {
                          name: 'DeepSeek 官方 (deepseek-chat)',
                          provider: 'openai' as const,
                          baseUrl: 'https://api.deepseek.com',
                          model: 'deepseek-chat',
                        },
                        {
                          name: 'SiliconFlow 硅基流动',
                          provider: 'openai' as const,
                          baseUrl: 'https://api.siliconflow.cn/v1',
                          model: 'deepseek-ai/DeepSeek-V3',
                        },
                        {
                          name: 'OpenAI 官方 (gpt-4o)',
                          provider: 'openai' as const,
                          baseUrl: 'https://api.openai.com/v1',
                          model: 'gpt-4o',
                        },
                        {
                          name: 'Moonshot Kimi',
                          provider: 'openai' as const,
                          baseUrl: 'https://api.moonshot.cn/v1',
                          model: 'moonshot-v1-8k',
                        },
                        {
                          name: '阿里通义千问 (Qwen-Plus)',
                          provider: 'openai' as const,
                          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                          model: 'qwen-plus',
                        },
                        {
                          name: '本地 Ollama (DeepSeek-R1)',
                          provider: 'openai' as const,
                          baseUrl: 'http://localhost:11434/v1',
                          model: 'deepseek-r1',
                        },
                      ].map((preset) => (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() => applyPreset(preset)}
                          className="px-2.5 py-1 text-xs rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 transition-colors"
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Main Config Form */}
                <div className="p-5 rounded-2xl bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 space-y-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    接口连接与模型参数配置
                  </h4>

                  {modelConfig.provider === 'openai' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Base URL */}
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          API 接口地址 (Base URL) <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={modelConfig.openai_base_url}
                          onChange={(e) =>
                            setModelConfig((prev) => ({ ...prev, openai_base_url: e.target.value }))
                          }
                          placeholder="例如: https://api.deepseek.com 或 https://api.openai.com/v1"
                          className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                        />
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">无需手动拼接 /chat/completions，系统将自动路由</p>
                      </div>

                      {/* Model Name */}
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          调用模型名称 (Model ID) <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={modelConfig.openai_model}
                          onChange={(e) =>
                            setModelConfig((prev) => ({ ...prev, openai_model: e.target.value }))
                          }
                          placeholder="例如: deepseek-chat, gpt-4o, qwen-max"
                          className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                        />
                      </div>

                      {/* API Key */}
                      <div className="space-y-1 md:col-span-2">
                        <div className="flex items-center justify-between">
                          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                            API 密钥 (API Key / Token) <span className="text-rose-500">*</span>
                          </label>
                          {modelConfig.has_openai_key && (
                            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> 当前已配置密钥
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <input
                            type={showApiKey ? 'text' : 'password'}
                            value={rawApiKeyInput}
                            onChange={(e) => setRawApiKeyInput(e.target.value)}
                            placeholder={modelConfig.has_openai_key ? '已配置 (留空或保持掩码表示不更改)' : 'sk-xxxxxxxx...'}
                            className="w-full px-3 py-2 pr-10 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                          >
                            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Gemini Model */}
                      <div className="space-y-1 md:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          Gemini 默认调用模型
                        </label>
                        <select
                          value={modelConfig.gemini_model || ''}
                          onChange={(e) =>
                            setModelConfig((prev) => ({ ...prev, gemini_model: e.target.value }))
                          }
                          className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="">请选择模型（必选，保存后生效）</option>
                          <option value="gemini-3.8-flash">gemini-3.8-flash (极速推理)</option>
                          <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (轻量高并发)</option>
                          <option value="gemini-flash-latest">gemini-flash-latest (持续最新版本)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Hyperparameters: Temperature & Max Tokens */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                        <span>生成发散度 (Temperature):</span>
                        <span className="font-mono text-indigo-600 dark:text-indigo-400">{modelConfig.temperature}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1.5"
                        step="0.05"
                        value={modelConfig.temperature}
                        onChange={(e) =>
                          setModelConfig((prev) => ({ ...prev, temperature: parseFloat(e.target.value) }))
                        }
                        className="w-full accent-indigo-600 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400 dark:text-slate-500">
                        <span>精确收敛 (0.0)</span>
                        <span>标准平衡 (0.7)</span>
                        <span>高度创意 (1.5)</span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        单次生成最大 Token (Max Tokens)
                      </label>
                      <input
                        type="number"
                        min="512"
                        max="32768"
                        step="512"
                        value={modelConfig.max_tokens}
                        onChange={(e) =>
                          setModelConfig((prev) => ({ ...prev, max_tokens: parseInt(e.target.value, 10) || 4096 }))
                        }
                        className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                      />
                    </div>
                  </div>

                  {/* System Prompt */}
                  <div className="space-y-1 pt-2 border-t border-slate-100 dark:border-slate-800">
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      全局导师角色系统提示词 (System Prompt 自定义覆盖)
                    </label>
                    <textarea
                      rows={3}
                      value={modelConfig.custom_system_prompt || ''}
                      onChange={(e) =>
                        setModelConfig((prev) => ({ ...prev, custom_system_prompt: e.target.value }))
                      }
                      placeholder="留空则使用内置苏格拉底式启发导师提示词..."
                      className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 leading-relaxed"
                    />
                  </div>
                </div>

                {/* Connection Test Result Preview */}
                {testResult && (
                  <div
                    className={`p-4 rounded-xl border text-xs animate-in fade-in ${
                      testResult.success
                        ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                        : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold mb-1">
                      <div className="flex items-center gap-2">
                        {testResult.success ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                        )}
                        <span>{testResult.message}</span>
                      </div>
                      {testResult.latencyMs !== undefined && (
                        <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
                          耗时: {testResult.latencyMs}ms
                        </span>
                      )}
                    </div>
                    {testResult.reply && (
                      <div className="mt-2 p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-emerald-200/60 dark:border-emerald-800/60 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                        <strong>返回内容：</strong> {testResult.reply}
                      </div>
                    )}
                    {testResult.error && (
                      <div className="mt-2 p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-rose-200/60 dark:border-rose-800/60 font-mono text-[11px] text-rose-600 dark:text-rose-400">
                        <strong>错误详情：</strong> {testResult.error}
                      </div>
                    )}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={handleTestModelConnection}
                    disabled={testingModelConnection}
                    className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors shadow-xs"
                  >
                    {testingModelConnection ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                        <span>正在进行接口联调测试...</span>
                      </>
                    ) : (
                      <>
                        <Activity className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                        <span>测试接口连通性 (Ping)</span>
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={savingModelConfig}
                      className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 text-white text-xs font-semibold transition-colors shadow-sm"
                    >
                      {savingModelConfig ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>正在保存...</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>保存并立即生效</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* TAB: ORDERS (Spec E3) */}
          {activeTab === 'orders' && (
            <div className="space-y-4">
              {/* Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  订单与商业对账（支付流水）
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={orderStatusFilter}
                    onChange={(e) => {
                      setOrderStatusFilter(e.target.value);
                      setOrderPage(1);
                    }}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="all">所有状态</option>
                    <option value="pending">待支付 (pending)</option>
                    <option value="paid">已支付 (paid)</option>
                    <option value="failed">支付失败 (failed)</option>
                    <option value="refunded">已退款 (refunded)</option>
                  </select>
                  <Tooltip content="刷新订单列表">
                    <button
                      onClick={fetchOrders}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Orders Table */}
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700/80">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      <th className="py-3 px-4 font-semibold">订单号</th>
                      <th className="py-3 px-3 font-semibold">用户</th>
                      <th className="py-3 px-3 font-semibold">套餐</th>
                      <th className="py-3 px-3 font-semibold">金额</th>
                      <th className="py-3 px-3 font-semibold">状态</th>
                      <th className="py-3 px-3 font-semibold">时长</th>
                      <th className="py-3 px-4 font-semibold">创建时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                    {loadingOrders ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          正在加载订单列表...
                        </td>
                      </tr>
                    ) : orders.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          未检索到符合条件的订单
                        </td>
                      </tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-800 dark:text-slate-100">
                            {o.order_no}
                          </td>
                          <td className="py-3 px-3 font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[180px]">
                            {o.user_email || o.user_id}
                          </td>
                          <td className="py-3 px-3">{o.plan_name}</td>
                          <td className="py-3 px-3 font-semibold text-slate-900 dark:text-slate-100">
                            ¥{(o.amount_cents / 100).toFixed(2)}
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                o.status === 'paid'
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300'
                                  : o.status === 'pending'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/80 dark:text-amber-300'
                                  : o.status === 'failed'
                                  ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/80 dark:text-rose-300'
                                  : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                              }`}
                            >
                              {o.status}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-500">{o.duration_days} 天</td>
                          <td className="py-3 px-4 text-slate-500">
                            {new Date(o.created_at).toLocaleDateString('zh-CN')}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-2">
                <span>共 {orderTotal} 笔订单</span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={orderPage <= 1}
                    onClick={() => setOrderPage((p) => p - 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span>第 {orderPage} 页</span>
                  <button
                    disabled={orderPage * 10 >= orderTotal}
                    onClick={() => setOrderPage((p) => p + 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: USERS */}
          {activeTab === 'users' && (
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
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50"
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
                                    onClick={() => {
                                      setVipTargetUser(u);
                                      setVipDaysToAdd(30);
                                    }}
                                    className="px-2.5 py-1 rounded bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/60 dark:hover:bg-amber-900/80 text-amber-700 dark:text-amber-300 text-xs font-semibold transition-colors inline-flex items-center gap-1"
                                  >
                                    <Crown className="w-3 h-3" />
                                    <span>授权VIP</span>
                                  </button>
                                </Tooltip>
                                <Tooltip content="修改用户登录邮箱（需重新验证）">
                                  <button
                                    onClick={() => {
                                      setEmailTargetUser(u);
                                      setNewEmail('');
                                    }}
                                    className="px-2.5 py-1 rounded bg-sky-50 hover:bg-sky-100 dark:bg-sky-950/60 dark:hover:bg-sky-900/80 text-sky-700 dark:text-sky-300 text-xs font-semibold transition-colors inline-flex items-center gap-1"
                                  >
                                    <Mail className="w-3 h-3" />
                                    <span>改邮箱</span>
                                  </button>
                                </Tooltip>
                                {u.id !== user?.id && (
                                  <Tooltip content={u.is_active !== false ? '冻结该用户登录与调用' : '解冻恢复该用户'}>
                                    <button
                                      onClick={() => handleToggleUserStatus(u)}
                                      className={`p-1 rounded text-xs transition-colors ${
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
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span>第 {userPage} 页</span>
                  <button
                    disabled={userPage * 10 >= userTotal}
                    onClick={() => setUserPage((p) => p + 1)}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Modal for Grant / Adjust VIP Days */}
        {vipTargetUser && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
            <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
                  <Crown className="w-4 h-4" />
                </div>
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  授权 / 调整 VIP 会员天数
                </h4>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                目标用户：<span className="font-mono text-slate-700 dark:text-slate-300 font-medium">{vipTargetUser.email}</span>
                {vipTargetUser.vip_expires_at && (
                  <span className="block text-amber-600 dark:text-amber-400 mt-0.5">
                    当前 VIP 到期时间：{new Date(vipTargetUser.vip_expires_at).toLocaleDateString('zh-CN')}
                  </span>
                )}
              </p>

              <form onSubmit={handleGrantVipDays} className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-600 dark:text-slate-300 mb-1.5 font-medium">
                    快捷预设天数（在当前剩余天数上顺延）
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: '+7 天周度', days: 7 },
                      { label: '+30 天月度', days: 30 },
                      { label: '+90 天季度', days: 90 },
                      { label: '+365 天年度', days: 365 },
                    ].map((preset) => (
                      <button
                        key={preset.days}
                        type="button"
                        onClick={() => setVipDaysToAdd(preset.days)}
                        className={`px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                          vipDaysToAdd === preset.days
                            ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 ring-2 ring-amber-500/20'
                            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-600 dark:text-slate-300 mb-1 font-medium">
                    自定义授权天数（输入 0 将立即取消该用户的 VIP 身份）
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      value={vipDaysToAdd}
                      onChange={(e) => setVipDaysToAdd(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono"
                    />
                    <span className="absolute right-3 top-2 text-xs text-slate-400">天</span>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setVipTargetUser(null)}
                    className="px-3.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={submittingVip}
                    className="px-4 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium shadow-sm transition-all"
                  >
                    {submittingVip ? '授权中...' : '确认授予特权天数'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal for Change User Email */}
        {emailTargetUser && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
            <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-500">
                  <Mail className="w-4 h-4" />
                </div>
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  修改用户登录邮箱
                </h4>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                目标用户：<span className="font-mono text-slate-700 dark:text-slate-300 font-medium">{emailTargetUser.email}</span>
                <span className="block mt-0.5">
                  修改后原邮箱立即失效，需向新邮箱重新完成验证后方可使用 AI 推理。
                </span>
              </p>

              <form onSubmit={handleUpdateUserEmail} className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-600 dark:text-slate-300 mb-1 font-medium">
                    新邮箱地址
                  </label>
                  <input
                    type="email"
                    required
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="new@example.com"
                    className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEmailTargetUser(null)}
                    className="px-3.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={submittingEmail}
                    className="px-4 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium shadow-sm transition-all"
                  >
                    {submittingEmail ? '提交中...' : '确认修改邮箱'}
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
