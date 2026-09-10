/**
 * Spec L1：顶栏快捷切换的分段构造（纯函数，无框架依赖，便于单测）。
 *
 * 规则：隐藏归档 → 收藏置顶独立成段 → 未分组 → 各分组；无分组时退化为扁平列表。
 * 指向已删/未知分组的画板回落到「未分组」，避免从快捷列表消失。
 */
import type { DeepDiveBoardMeta } from '../types';
import type { FolderMeta } from './folder-store';

export interface BoardSection {
  key: string;
  label?: string;
  boards: DeepDiveBoardMeta[];
}

export function buildQuickSections(
  boards: DeepDiveBoardMeta[],
  folders: FolderMeta[]
): BoardSection[] {
  const visible = boards.filter((b) => !b.isArchived);
  const byRecent = (a: DeepDiveBoardMeta, b: DeepDiveBoardMeta) => b.updatedAt - a.updatedAt;

  // 无分组：退化为原扁平列表（收藏置顶，不出现分组标题）
  if (folders.length === 0) {
    const flat = [...visible].sort(
      (a, b) => Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || b.updatedAt - a.updatedAt
    );
    return [{ key: '__none', boards: flat }];
  }

  const favorites = visible.filter((b) => b.isFavorite).sort(byRecent);
  const rest = visible.filter((b) => !b.isFavorite);

  const sections: BoardSection[] = [];
  if (favorites.length > 0) sections.push({ key: '__fav', label: '收藏', boards: favorites });

  const known = new Set(folders.map((f) => f.id));
  const ungrouped = rest.filter((b) => !b.folderId || !known.has(b.folderId)).sort(byRecent);
  if (ungrouped.length > 0 || sections.length === 0) {
    sections.push({ key: '__none', label: '未分组', boards: ungrouped });
  }
  for (const f of folders) {
    const list = rest.filter((b) => b.folderId === f.id).sort(byRecent);
    if (list.length > 0) sections.push({ key: f.id, label: f.name, boards: list });
  }
  return sections;
}
