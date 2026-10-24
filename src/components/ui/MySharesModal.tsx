/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 我的分享弹窗（2026-09-09）：管理本人生效中的画布分享链接。
 * - 查：GET /api/shares（仅生效中；已撤销的不显示），含浏览次数（累计口径）
 * - 改：「同步最新内容」复用创建接口（幂等，code 不变，浏览次数保留）
 * - 删：「停止分享」两步确认，成功后本地移除该行
 * 独立 fetch（credentials include），不经 App 的 shareDialog/boards 状态。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { X, Share2, Copy, Check, RefreshCw, Link2Off, Eye } from 'lucide-react';
import { Modal } from './base/Modal';
import { useModal } from '../../context/ModalContext';
import { copyTextToClipboard } from '../../lib/clipboard';
import { formatDate } from '../../lib/format';
import { Spinner } from './base/Spinner';
import { StatusBanner } from './base/StatusBanner';

interface ShareItem {
  canvasId: string;
  canvasTitle: string;
  shareCode: string;
  url: string;
  viewsCount: number;
  createdAt: string;
}

interface StatusMsg {
  type: 'success' | 'error';
  text: string;
}

export interface MySharesModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const MySharesModal: React.FC<MySharesModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const modal = useModal();
  const isOpen = propIsOpen ?? modal.mySharesModalOpen;
  const onClose = propOnClose ?? modal.closeMySharesModal;

  const [items, setItems] = useState<ShareItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operatingId, setOperatingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<StatusMsg | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/shares', { credentials: 'include' });
      if (res.status === 401) {
        setError('登录状态已失效，请重新登录后再查看');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as any;
        setError(body?.error || '分享列表加载失败，请稍后重试');
        return;
      }
      const data = await res.json();
      setItems(Array.isArray(data?.shares) ? data.shares : []);
    } catch {
      setError('网络连接异常，请检查网络后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setItems(null);
      setConfirmRevokeId(null);
      setCopiedId(null);
      void fetchList();
    }
  }, [isOpen, fetchList]);

  const handleCopy = async (item: ShareItem) => {
    if (await copyTextToClipboard(item.url)) {
      setCopiedId(item.canvasId);
      setTimeout(() => setCopiedId((prev) => (prev === item.canvasId ? null : prev)), 2000);
    } else {
      setStatusMsg({ type: 'error', text: '复制失败，请手动选中链接复制' });
    }
  };

  /** 同步最新内容：复用创建接口，幂等刷新（code 不变、浏览次数保留） */
  const handleSync = async (item: ShareItem) => {
    if (operatingId) return;
    setOperatingId(item.canvasId);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/canvases/${encodeURIComponent(item.canvasId)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null) as any;
      if (res.ok && body?.shareCode) {
        setItems((prev) =>
          (prev || []).map((it) =>
            it.canvasId === item.canvasId
              ? { ...it, shareCode: body.shareCode, url: body.url || it.url }
              : it
          )
        );
        setStatusMsg({ type: 'success', text: `「${item.canvasTitle}」已同步画板最新内容` });
      } else {
        setStatusMsg({ type: 'error', text: body?.error || '同步失败，请稍后重试' });
      }
    } catch {
      setStatusMsg({ type: 'error', text: '网络连接异常，请检查网络后重试' });
    } finally {
      setOperatingId(null);
    }
  };

  const handleRevoke = async (item: ShareItem) => {
    if (operatingId) return;
    if (confirmRevokeId !== item.canvasId) {
      setConfirmRevokeId(item.canvasId);
      return;
    }
    setOperatingId(item.canvasId);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/canvases/${encodeURIComponent(item.canvasId)}/share`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok || res.status === 404) {
        // 404 = 该分享已失效（竞态）：同样从列表移除
        setItems((prev) => (prev || []).filter((it) => it.canvasId !== item.canvasId));
        setConfirmRevokeId(null);
        setStatusMsg(
          res.ok
            ? { type: 'success', text: `已停止分享「${item.canvasTitle}」，原链接即刻失效` }
            : { type: 'success', text: '该分享已失效，已从列表移除' }
        );
      } else {
        const body = await res.json().catch(() => null) as any;
        setStatusMsg({ type: 'error', text: body?.error || '停止分享失败，请稍后重试' });
      }
    } catch {
      setStatusMsg({ type: 'error', text: '网络连接异常，请检查网络后重试' });
    } finally {
      setOperatingId(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      showCloseButton={false}
      className="relative w-full max-w-lg max-h-[80vh] flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl text-slate-100 p-0 overflow-hidden"
    >
      <div id="my-shares-modal-container" className="flex flex-col w-full h-full min-h-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-semibold tracking-wide">我的分享</span>
            {items && items.length > 0 && (
              <span className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-800/80">
                {items.length} 个生效中
              </span>
            )}
          </div>
          <button
            id="my-shares-close-btn"
            onClick={onClose}
            aria-label="关闭"
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-slate-400 text-sm">
              <Spinner size="md" />
              加载中…
            </div>
          )}

          {!loading && error && (
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-slate-300">{error}</p>
              <button
                id="my-shares-retry-btn"
                onClick={() => void fetchList()}
                className="text-xs font-semibold px-4 py-1.5 rounded-xl bg-slate-800 text-slate-200 hover:bg-slate-700 transition"
              >
                重试
              </button>
            </div>
          )}

          {!loading && !error && items && items.length === 0 && (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center">
                <Share2 className="w-5 h-5 text-slate-500" />
              </div>
              <p className="text-sm text-slate-300 font-medium">还没有生效中的分享</p>
              <p className="text-xs text-slate-500 leading-relaxed max-w-[280px]">
                在画板中点击「分享链接」即可创建只读分享，创建后会出现在这里统一管理。
              </p>
            </div>
          )}

          {!loading && !error && items && items.length > 0 && (
            <>
              {statusMsg && (
                <StatusBanner
                  type={statusMsg.type}
                  unstyled
                  icon={null}
                  className={`px-3 py-2 rounded-xl text-xs border ${
                    statusMsg.type === 'success'
                      ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                      : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                  }`}
                >
                  {statusMsg.text}
                </StatusBanner>
              )}
              {items.map((item) => (
                <div
                  key={item.canvasId}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-100 truncate">
                        {item.canvasTitle}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                        <Eye className="w-3 h-3" />
                        <span>浏览 {item.viewsCount} 次</span>
                        <span>·</span>
                        <span>{formatDate(item.createdAt)} 分享</span>
                      </div>
                    </div>
                  </div>

                  <div className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-400 truncate select-text">
                    {item.url}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      id={`my-shares-copy-${item.canvasId}`}
                      onClick={() => void handleCopy(item)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                        copiedId === item.canvasId
                          ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-800/60'
                          : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                      }`}
                    >
                      {copiedId === item.canvasId ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      {copiedId === item.canvasId ? '已复制' : '复制链接'}
                    </button>
                    <button
                      id={`my-shares-sync-${item.canvasId}`}
                      onClick={() => void handleSync(item)}
                      disabled={operatingId !== null}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3 h-3 ${operatingId === item.canvasId ? 'animate-spin' : ''}`}
                      />
                      同步最新内容
                    </button>
                    {confirmRevokeId === item.canvasId ? (
                      <button
                        id={`my-shares-revoke-confirm-${item.canvasId}`}
                        onClick={() => void handleRevoke(item)}
                        disabled={operatingId !== null}
                        className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-950/50 text-rose-300 border border-rose-800/60 hover:bg-rose-900/50 transition-colors disabled:opacity-50"
                      >
                        <Link2Off className="w-3 h-3" />
                        {operatingId === item.canvasId ? '停止中…' : '确认停止：原链接将即刻失效'}
                      </button>
                    ) : (
                      <button
                        id={`my-shares-revoke-${item.canvasId}`}
                        onClick={() => void handleRevoke(item)}
                        disabled={operatingId !== null}
                        className="ml-auto text-xs text-rose-400 hover:text-rose-300 hover:underline disabled:opacity-50"
                      >
                        停止分享
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
