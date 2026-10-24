/**
 * Spec K5（跟踪清单 D1）：空态新手 4 步 checklist 浮层（画布视图右下角）。
 *
 * - 状态源：src/lib/checklist.ts（localStorage 标记 + CustomEvent 同步）。
 * - hasBoards=true（老用户已有画板）时自动勾掉第 1 步。
 * - 四步全完成 → 自动 dismiss；「知道了」手动关闭后不再显示。
 */
import React, { useEffect, useState } from 'react';
import { Circle, CheckCircle2, X } from 'lucide-react';
import {
  CHECKLIST_EVENT,
  CHECKLIST_STEPS,
  dismissChecklist,
  getChecklistState,
  isChecklistDone,
  markChecklistStep,
  type ChecklistStepId,
} from '../../lib/checklist';

interface StarterChecklistProps {
  /** 用户是否已有思考画板（老用户首渲染即勾掉第 1 步） */
  hasBoards: boolean;
}

export const StarterChecklist: React.FC<StarterChecklistProps> = ({ hasBoards }) => {
  const [done, setDone] = useState(isChecklistDone);
  const [steps, setSteps] = useState(getChecklistState);

  const sync = () => {
    setDone(isChecklistDone());
    setSteps(getChecklistState());
  };

  useEffect(() => {
    sync();
    window.addEventListener(CHECKLIST_EVENT, sync);
    return () => window.removeEventListener(CHECKLIST_EVENT, sync);
  }, []);

  useEffect(() => {
    if (hasBoards) markChecklistStep('board');
  }, [hasBoards]);

  // 四步全完成 → 自动消失（写 done 标记，之后不再显示）
  useEffect(() => {
    if (!done && CHECKLIST_STEPS.every((s) => steps[s.id])) {
      dismissChecklist();
    }
  }, [done, steps]);

  if (done) return null;

  const completed = CHECKLIST_STEPS.filter((s) => steps[s.id]).length;

  return (
    <div className="absolute bottom-4 right-4 z-40 w-64 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-xl p-4">
      <div className="flex items-start justify-between mb-2.5">
        <div>
          <div className="text-xs font-bold text-slate-900 dark:text-slate-100">快速上手</div>
          <div className="text-xxs text-slate-400 mt-0.5">已完成 {completed}/{CHECKLIST_STEPS.length} 步</div>
        </div>
        <button
          onClick={dismissChecklist}
          aria-label="关闭新手引导"
          className="p-1 rounded-lg text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <ul className="space-y-1.5">
        {CHECKLIST_STEPS.map((s) => {
          const ok = steps[s.id as ChecklistStepId];
          return (
            <li key={s.id} className="flex items-center gap-2">
              {ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 shrink-0" />
              )}
              <span
                className={`text-xxs leading-snug ${
                  ok
                    ? 'text-slate-400 dark:text-slate-500 line-through'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
