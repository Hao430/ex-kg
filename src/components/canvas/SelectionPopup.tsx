/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { GitBranch, Sparkles } from 'lucide-react';
import { TextSelectionPayload } from '../../types';

interface SelectionPopupProps {
  payload: TextSelectionPayload | null;
  onBranch: (nodeId: string, phrase: string) => void;
  onClose: () => void;
}

export const SelectionPopup: React.FC<SelectionPopupProps> = ({
  payload,
  onBranch,
  onClose,
}) => {
  if (!payload || !payload.text.trim()) return null;

  const { top, left, width } = payload.clientRect;
  // Position the capsule centered directly above the selected text
  const popupTop = Math.max(10, top - 46);
  const popupLeft = Math.max(10, left + width / 2 - 110);

  return (
    <div
      style={{
        position: 'fixed',
        top: `${popupTop}px`,
        left: `${popupLeft}px`,
        zIndex: 9999,
      }}
      className="animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="flex items-center gap-1.5 p-1 bg-slate-900 text-white rounded-full shadow-2xl border border-slate-700/80 backdrop-blur-md">
        <button
          onClick={() => {
            onBranch(payload.nodeId, payload.text.trim());
            onClose();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 rounded-full transition-colors group"
        >
          <span className="flex items-center justify-center w-4 h-4 rounded-full bg-blue-500/30 text-blue-400 group-hover:bg-white/20 group-hover:text-white transition-colors">
            <Sparkles className="w-2.5 h-2.5" />
          </span>
          <span>深入探究 (DeepDive)</span>
          <GitBranch className="w-3 h-3 text-slate-400 group-hover:text-white" />
        </button>
      </div>
    </div>
  );
};
