/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 分享链接弹窗（Spec K2）：展示只读分享页 URL + 复制 + 停止分享。
 * recreated=true 时提示旧链接已失效（撤销后重建会换新 code）。
 */
import React, { useEffect, useState } from 'react';
import { X, Copy, Check, Link2, AlertTriangle } from 'lucide-react';
import { Modal } from './base/Modal';
import { copyTextToClipboard } from '../../lib/clipboard';

export interface ShareLinkModalProps {
  url: string;
  /** 撤销后重建生成了新链接（旧链接已失效） */
  recreated: boolean;
  onRevoke: () => void;
  onClose: () => void;
  /** 可选受控显隐，默认 true（兼容现有条件渲染与受控渲染） */
  isOpen?: boolean;
}

export const ShareLinkModal: React.FC<ShareLinkModalProps> = ({
  url,
  recreated,
  onRevoke,
  onClose,
  isOpen = true,
}) => {
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (await copyTextToClipboard(url)) {
      setCopied(true);
    }
  };

  const handleRevokeClick = () => {
    if (!revokeConfirm) {
      setRevokeConfirm(true);
      return;
    }
    setRevoking(true);
    onRevoke();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton={false}
      className="w-[min(480px,calc(100vw-32px))] bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl p-0 overflow-hidden"
    >
      <div id="share-link-modal-container" className="flex flex-col w-full">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              分享链接
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {recreated && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                此画板之前的分享已被停止，本次生成了新链接——旧链接即刻失效，请把新链接发给对方。
              </span>
            </div>
          )}

          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            访客打开链接可只读浏览画布快照（后续编辑不传播），并可一键克隆为自己的可编辑副本。
          </p>

          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
              className="flex-1 px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 font-mono outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={handleCopy}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
                copied
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 dark:border-slate-800">
          {revokeConfirm ? (
            <button
              onClick={handleRevokeClick}
              disabled={revoking}
              className="text-xs font-semibold px-3 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800 hover:bg-rose-100 dark:hover:bg-rose-900/40 disabled:opacity-60"
            >
              {revoking ? '停止中…' : '确认停止：原链接将即刻失效'}
            </button>
          ) : (
            <button
              onClick={handleRevokeClick}
              className="text-xs text-rose-500 dark:text-rose-400 hover:underline"
            >
              停止分享
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs font-semibold px-4 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            完成
          </button>
        </div>
      </div>
    </Modal>
  );
};
