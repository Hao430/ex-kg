/**
 * Spec K5（跟踪清单 D1）：空态新手 checklist（4 步，纯前端浮层）。
 *
 * - 进度以 localStorage 标记持久化（deepdive_step_*），动作发生处调用 markChecklistStep。
 * - 跨组件同步用 window CustomEvent('arborize:checklist')，避免引入全局状态。
 * - 四步全部完成 → 自动写入 deepdive_checklist_done 并消失；用户也可手动关闭不再显示。
 * - localStorage 不可用（隐私模式）时按「已完成」处理：不打扰用户。
 */

export type ChecklistStepId = 'board' | 'branch' | 'generate' | 'export';

export const CHECKLIST_EVENT = 'arborize:checklist';

const STEP_KEYS: Record<ChecklistStepId, string> = {
  board: 'deepdive_step_board',
  branch: 'deepdive_step_branch',
  generate: 'deepdive_step_generate',
  export: 'deepdive_step_export',
};

const DONE_KEY = 'deepdive_checklist_done';

export const CHECKLIST_STEPS: Array<{ id: ChecklistStepId; label: string }> = [
  { id: 'board', label: '创建我的思考画板' },
  { id: 'branch', label: '划词生成一个探索分支' },
  { id: 'generate', label: '让 AI 完成一次回答' },
  { id: 'export', label: '导出研究成果（PNG/JSON/Markdown）' },
];

export function isChecklistDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return true;
  }
}

export function getChecklistState(): Record<ChecklistStepId, boolean> {
  const state = {} as Record<ChecklistStepId, boolean>;
  for (const id of Object.keys(STEP_KEYS) as ChecklistStepId[]) {
    try {
      state[id] = localStorage.getItem(STEP_KEYS[id]) === '1';
    } catch {
      state[id] = true;
    }
  }
  return state;
}

/** 标记某步完成并广播（动作发生处调用；重复调用幂等） */
export function markChecklistStep(id: ChecklistStepId): void {
  try {
    if (localStorage.getItem(STEP_KEYS[id]) === '1') return;
    localStorage.setItem(STEP_KEYS[id], '1');
    window.dispatchEvent(new CustomEvent(CHECKLIST_EVENT));
  } catch {
    // localStorage 不可用时静默跳过（用户不受打扰优先）
  }
}

export function dismissChecklist(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
    window.dispatchEvent(new CustomEvent(CHECKLIST_EVENT));
  } catch {}
}
