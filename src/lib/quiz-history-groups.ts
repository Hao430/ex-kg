/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1/R2 — AI 练习：往期练习记录的「按主题折叠」派生视图模型。
 *
 * 本模块是**纯函数**：不读写 localStorage、不访问 window、不改入参。
 * 分组口径集中于此，组件只消费派生结果（`useMemo` 调用）。
 *
 * - 分组键：item.topic 严格字符串相等（不 trim、不归一、不忽略大小写）
 * - 阈值：同主题 ≥2 条建组，=1 条平铺
 * - 顺序：行序 = topic 首次出现位置；组内序 = 入参原序
 * - 筛选：先分组再筛选；待复盘只保留含错题组 / 错题单条，组内不再二次筛选
 */
import type { QuizDifficulty, QuizHistoryItem } from './quiz-store';

export type QuizHistoryFilter = 'all' | 'mistakes';

/** 折叠组：由同一 topic 的 ≥2 条记录派生（仅内存，不持久化） */
export interface QuizHistoryGroup {
  kind: 'group';
  topic: string;
  /** 保持入参相对顺序（createdAt DESC, id DESC） */
  items: QuizHistoryItem[];
  count: number;
  /** createdAt 最大、并列时 attemptId 最大的一条 */
  latest: QuizHistoryItem;
  mistakeCount: number;
  hasMistake: boolean;
  /** 取 latest.difficulty；缺失时回退组内任一条 */
  difficulty?: QuizDifficulty;
}

/** 单条平铺：topic 在当前已加载快照中仅 1 条 */
export interface QuizHistorySingle {
  kind: 'single';
  item: QuizHistoryItem;
}

export type QuizHistoryRow = QuizHistoryGroup | QuizHistorySingle;

/** 错题判据（与既有列表/标签计数口径一致；in_progress 不算错题） */
export function isMistakeItem(item: QuizHistoryItem): boolean {
  return item.status === 'completed' && item.correctCount !== null && item.correctCount < item.total;
}

/**
 * 与仓储内存分支同款的 createdAt 字典序比较：服务端返回 ISO UTC 串，字典序即时间序；
 * 兼容测试夹具中的非严格 ISO 串，避免 Date.parse 得 NaN。并列时 attemptId 大者更新。
 */
function isNewer(a: QuizHistoryItem, b: QuizHistoryItem): boolean {
  const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt > 0;
  return a.attemptId.localeCompare(b.attemptId) > 0;
}

/**
 * 分组 → 筛选 → 渲染行。纯函数，入参不变；调用方用 useMemo 基于已加载快照派生。
 */
export function buildHistoryRows(
  items: QuizHistoryItem[],
  filter: QuizHistoryFilter,
): QuizHistoryRow[] {
  // Map 的 string 键即严格相等；Map 迭代顺序 = topic 首次出现顺序。
  const byTopic = new Map<string, QuizHistoryItem[]>();
  for (const item of items) {
    const existing = byTopic.get(item.topic);
    if (existing) existing.push(item);
    else byTopic.set(item.topic, [item]);
  }

  const rows: QuizHistoryRow[] = [];
  for (const [topic, arr] of byTopic) {
    if (arr.length === 1) {
      rows.push({ kind: 'single', item: arr[0] });
      continue;
    }

    let latest = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (isNewer(arr[i], latest)) latest = arr[i];
    }
    const mistakeCount = arr.filter(isMistakeItem).length;

    rows.push({
      kind: 'group',
      topic,
      items: arr,
      count: arr.length,
      latest,
      mistakeCount,
      hasMistake: mistakeCount > 0,
      // 类型上 difficulty 必填；回退防御历史缓存缺字段。
      difficulty: latest.difficulty ?? arr.find((i) => i.difficulty)?.difficulty,
    });
  }

  if (filter === 'mistakes') {
    return rows.filter((row) =>
      row.kind === 'group' ? row.hasMistake : isMistakeItem(row.item),
    );
  }
  return rows;
}
