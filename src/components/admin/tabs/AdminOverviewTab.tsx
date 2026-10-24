/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Database, Cpu } from 'lucide-react';
import { AdminOverview } from '../../../types';
import { AdminDatabaseStatus } from '../types';
import { ModelWarningBanner } from '../shared/ModelWarningBanner';

export interface AdminOverviewTabProps {
  modelConfigured: boolean | null;
  onNavigateToModels: () => void;
  onModelConfiguredChange?: (configured: boolean) => void;
}

export const AdminOverviewTab: React.FC<AdminOverviewTabProps> = ({
  modelConfigured,
  onNavigateToModels,
  onModelConfiguredChange,
}) => {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [dbInfo, setDbInfo] = useState<AdminDatabaseStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/overview', { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        setOverview(data.overview);
        setDbInfo(data.database);
        if (typeof data.modelConfigured === 'boolean') {
          onModelConfiguredChange?.(data.modelConfigured);
        }
      }
    } catch (e) {
      console.error('Fetch overview error:', e);
    } finally {
      setLoading(false);
    }
  }, [onModelConfiguredChange]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return (
    <div className="space-y-6">
      <ModelWarningBanner
        modelConfigured={modelConfigured}
        onNavigateToModels={onNavigateToModels}
      />

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
          {dbInfo?.message || '正在检测存储状态…'}
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
  );
};
