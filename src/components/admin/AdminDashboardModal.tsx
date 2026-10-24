/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import {
  ShieldAlert,
  Users,
  BarChart3,
  Coins,
  Cpu,
  MessageSquarePlus,
  X,
} from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { StatusBanner } from '../ui/base/StatusBanner';
import { AdminTabType } from './types';
import { AdminOverviewTab } from './tabs/AdminOverviewTab';
import { AdminModelsTab } from './tabs/AdminModelsTab';
import { AdminUsersTab } from './tabs/AdminUsersTab';
import { AdminOrdersTab } from './tabs/AdminOrdersTab';
import { AdminTicketsTab } from './tabs/AdminTicketsTab';

export const AdminDashboardModal: React.FC = () => {
  const { user } = useAuth();
  const { adminModalOpen, closeAdminModal } = useModal();
  const [activeTab, setActiveTab] = useState<AdminTabType>('overview');
  const [feedback, setFeedback] = useState<string | null>(null);

  // Lifted badge and warning states
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [modelProvider, setModelProvider] = useState<'gemini' | 'openai'>('gemini');
  const [pendingTickets, setPendingTickets] = useState<number>(0);

  // Prefetch badges & warning banner state on modal open
  useEffect(() => {
    if (!adminModalOpen) return;

    fetch('/api/admin/overview', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.modelConfigured === 'boolean') {
          setModelConfigured(data.modelConfigured);
        }
      })
      .catch((e) => console.error('Prefetch overview error:', e));

    fetch('/api/admin/model-config', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.config?.provider) {
          setModelProvider(data.config.provider);
        }
      })
      .catch((e) => console.error('Prefetch model config error:', e));

    fetch('/api/admin/feedbacks?page=1&limit=1', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.statusCounts?.pending === 'number') {
          setPendingTickets(data.statusCounts.pending);
        }
      })
      .catch((e) => console.error('Prefetch ticket counts error:', e));
  }, [adminModalOpen]);

  // Escape key support
  useEffect(() => {
    if (!adminModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAdminModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [adminModalOpen, closeAdminModal]);

  if (!adminModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={closeAdminModal}
    >
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
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/40 shrink-0">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
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
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'models'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            AI 模型与接口配置
            {modelProvider === 'openai' && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
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
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'orders'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Coins className="w-3.5 h-3.5" />
            订单管理
          </button>
          <button
            onClick={() => setActiveTab('tickets')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'tickets'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            反馈工单
            {pendingTickets > 0 && (
              <span className="min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
                {pendingTickets}
              </span>
            )}
          </button>
        </div>

        {/* Feedback Alert Toast */}
        {feedback && (
          <StatusBanner
            type="info"
            unstyled
            icon={null}
            dismissible
            onDismiss={() => setFeedback(null)}
            className="mx-6 mt-3 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 text-xs animate-in fade-in"
          >
            {feedback}
          </StatusBanner>
        )}

        {/* Tab Contents */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <AdminOverviewTab
              modelConfigured={modelConfigured}
              onNavigateToModels={() => setActiveTab('models')}
              onModelConfiguredChange={setModelConfigured}
            />
          )}
          {activeTab === 'models' && (
            <AdminModelsTab
              modelConfigured={modelConfigured}
              onModelConfiguredChange={setModelConfigured}
              onProviderChange={setModelProvider}
              onFeedback={setFeedback}
            />
          )}
          {activeTab === 'users' && (
            <AdminUsersTab
              currentUserId={user?.id}
              onFeedback={setFeedback}
            />
          )}
          {activeTab === 'orders' && <AdminOrdersTab />}
          {activeTab === 'tickets' && (
            <AdminTicketsTab
              onStatusCountsChange={(counts) => setPendingTickets(counts.pending || 0)}
              onFeedback={setFeedback}
            />
          )}
        </div>
      </div>
    </div>
  );
};
