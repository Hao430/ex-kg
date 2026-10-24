/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Tooltip } from '../../ui/Tooltip';
import { formatDate } from '../../../lib/format';
import { AdminOrder } from '../types';

export const AdminOrdersTab: React.FC = () => {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderPage, setOrderPage] = useState(1);
  const [orderStatusFilter, setOrderStatusFilter] = useState('all');
  const [loadingOrders, setLoadingOrders] = useState(false);

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

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  return (
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
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 cursor-pointer"
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
                  正在加载订单列表…
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
                    {formatDate(o.created_at)}
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
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span>第 {orderPage} 页</span>
          <button
            disabled={orderPage * 10 >= orderTotal}
            onClick={() => setOrderPage((p) => p + 1)}
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
};
