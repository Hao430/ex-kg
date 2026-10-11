/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Tooltip } from '../../ui/Tooltip';
import { AdminTicket } from '../types';

export interface AdminTicketsTabProps {
  onStatusCountsChange?: (counts: Record<string, number>) => void;
  onFeedback: (message: string) => void;
}

const TICKET_STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: '待处理', className: 'bg-amber-100 text-amber-700 dark:bg-amber-950/80 dark:text-amber-300' },
  processing: { label: '处理中', className: 'bg-sky-100 text-sky-700 dark:bg-sky-950/80 dark:text-sky-300' },
  resolved: { label: '已解决', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300' },
  rejected: { label: '已驳回', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
};

const TICKET_TRANSITIONS: Record<string, string[]> = {
  pending: ['processing', 'resolved', 'rejected'],
  processing: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};

const TICKET_TYPE_LABELS: Record<string, string> = {
  suggestion: '功能建议',
  bug: '问题反馈',
  ux: '体验优化',
  other: '其他想法',
};

export const AdminTicketsTab: React.FC<AdminTicketsTabProps> = ({
  onStatusCountsChange,
  onFeedback,
}) => {
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [ticketStatusCounts, setTicketStatusCounts] = useState<Record<string, number>>({});
  const [ticketPage, setTicketPage] = useState(1);
  const [ticketStatusFilter, setTicketStatusFilter] = useState('all');
  const [ticketTypeFilter, setTicketTypeFilter] = useState('all');
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [ticketReplies, setTicketReplies] = useState<Record<string, string>>({});
  const [ticketStatuses, setTicketStatuses] = useState<Record<string, string>>({});
  const [savingTicketId, setSavingTicketId] = useState<string | null>(null);

  const fetchTickets = useCallback(async () => {
    setLoadingTickets(true);
    try {
      const params = new URLSearchParams({
        page: ticketPage.toString(),
        limit: '10',
        status: ticketStatusFilter,
        type: ticketTypeFilter,
      });
      const res = await fetch(`/api/admin/feedbacks?${params.toString()}`, { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        setTickets(data.feedbacks || []);
        setTicketTotal(data.total || 0);
        const counts = data.statusCounts || {};
        setTicketStatusCounts(counts);
        onStatusCountsChange?.(counts);
      }
    } catch (e) {
      console.error('Fetch feedbacks error:', e);
    } finally {
      setLoadingTickets(false);
    }
  }, [ticketPage, ticketStatusFilter, ticketTypeFilter, onStatusCountsChange]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const handleUpdateTicket = async (id: string) => {
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;
    const status = ticketStatuses[id] || ticket.status;
    const admin_reply = ticketReplies[id] ?? ticket.admin_reply ?? '';

    if (status === 'resolved' && !admin_reply.trim()) {
      onFeedback('标记为已解决时必须填写回复内容');
      return;
    }

    setSavingTicketId(id);
    try {
      const res = await fetch(`/api/admin/feedbacks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status, admin_reply }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onFeedback(data.error || '工单更新失败');
        return;
      }
      onFeedback('工单已更新');
      setTicketReplies((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setTicketStatuses((prev) => { const next = { ...prev }; delete next[id]; return next; });
      await fetchTickets();
    } catch (e) {
      console.error('Update feedback error:', e);
      onFeedback('网络异常，请重试');
    } finally {
      setSavingTicketId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80">
        <div className="flex flex-wrap items-center gap-2">
          {([
            { id: 'all', label: '全部', count: undefined },
            { id: 'pending', label: '待处理', count: ticketStatusCounts.pending },
            { id: 'processing', label: '处理中', count: ticketStatusCounts.processing },
            { id: 'resolved', label: '已解决', count: ticketStatusCounts.resolved },
            { id: 'rejected', label: '已驳回', count: ticketStatusCounts.rejected },
          ] as const).map((chip) => (
            <button
              key={chip.id}
              onClick={() => {
                setTicketStatusFilter(chip.id);
                setTicketPage(1);
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                ticketStatusFilter === chip.id
                  ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {chip.label}
              {typeof chip.count === 'number' && (
                <span className="ml-1.5 text-[10px] text-slate-400">{chip.count}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={ticketTypeFilter}
            onChange={(e) => {
              setTicketTypeFilter(e.target.value);
              setTicketPage(1);
            }}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none"
          >
            <option value="all">所有类型</option>
            <option value="suggestion">功能建议</option>
            <option value="bug">问题反馈</option>
            <option value="ux">体验优化</option>
            <option value="other">其他想法</option>
          </select>
          <Tooltip content="刷新工单列表">
            <button
              onClick={fetchTickets}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {loadingTickets ? (
        <div className="py-12 text-center text-xs text-slate-400">正在加载工单...</div>
      ) : tickets.length === 0 ? (
        <div className="py-12 text-center text-xs text-slate-400">未检索到符合条件的工单</div>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => {
            const meta = TICKET_STATUS_META[t.status] || TICKET_STATUS_META.pending;
            const currentStatus = ticketStatuses[t.id] || t.status;
            const replyValue = ticketReplies[t.id] ?? t.admin_reply ?? '';
            const options = [t.status, ...(TICKET_TRANSITIONS[t.status] || [])];
            return (
              <div
                key={t.id}
                className="rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/40 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                      {TICKET_TYPE_LABELS[t.type] || t.type}
                    </span>
                    <span className="text-[11px] text-amber-500">
                      {'★'.repeat(t.rating)}
                      {'☆'.repeat(Math.max(0, 5 - t.rating))}
                    </span>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${meta.className}`}>
                      {meta.label}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400">
                    {new Date(t.created_at).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>

                <p className="text-xs text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
                  {t.content}
                </p>

                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  提交者：{t.user_email || t.contact_info || '匿名（未留联系方式）'}
                </div>

                <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
                  <select
                    value={currentStatus}
                    onChange={(e) => setTicketStatuses((prev) => ({ ...prev, [t.id]: e.target.value }))}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none shrink-0"
                  >
                    {options.map((s) => (
                      <option key={s} value={s}>
                        {TICKET_STATUS_META[s]?.label || s}
                        {s === t.status ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                  <textarea
                    rows={2}
                    value={replyValue}
                    onChange={(e) => setTicketReplies((prev) => ({ ...prev, [t.id]: e.target.value }))}
                    placeholder="填写给用户的回复（标记为已解决时必填）"
                    className="flex-1 text-xs px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500 resize-none"
                  />
                  <button
                    onClick={() => handleUpdateTicket(t.id)}
                    disabled={savingTicketId === t.id}
                    className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 shrink-0 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {savingTicketId === t.id ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-2">
        <span>共 {ticketTotal} 条工单</span>
        <div className="flex items-center gap-2">
          <button
            disabled={ticketPage <= 1}
            onClick={() => setTicketPage((p) => p - 1)}
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span>第 {ticketPage} 页</span>
          <button
            disabled={ticketPage * 10 >= ticketTotal}
            onClick={() => setTicketPage((p) => p + 1)}
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
};
