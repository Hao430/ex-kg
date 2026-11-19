/**
 * Spec R1/R2 — 往期练习记录按主题折叠：派生纯函数口径锁定。
 * 覆盖分组阈值、严格相等、最新掌握情况、错题判据、先分组后筛选与顺序不变量。
 */
import { describe, it, expect } from 'vitest';
import { buildHistoryRows, isMistakeItem } from '@/src/lib/quiz-history-groups';
import type { QuizDifficulty, QuizHistoryItem } from '@/src/lib/quiz-store';

function item(
  attemptId: string,
  topic: string,
  overrides: Partial<QuizHistoryItem> = {},
): QuizHistoryItem {
  return {
    attemptId,
    topic,
    difficulty: 'beginner',
    status: 'completed',
    total: 5,
    correctCount: 5,
    createdAt: '2026-10-01T00:00:00.000Z',
    completedAt: '2026-10-01T00:00:00.000Z',
    review: {},
    ...overrides,
  };
}

describe('buildHistoryRows 分组与阈值', () => {
  it('同主题 ≥2 条建组，=1 条平铺；行序按 topic 首次出现', () => {
    const a1 = item('a-1', '主题A', { createdAt: '2026-10-03T00:00:00.000Z' });
    const b1 = item('b-1', '主题B', { createdAt: '2026-10-02T00:00:00.000Z' });
    const a2 = item('a-2', '主题A', { createdAt: '2026-10-01T00:00:00.000Z' });
    const a3 = item('a-3', '主题A', { createdAt: '2026-09-30T00:00:00.000Z' });

    const rows = buildHistoryRows([a1, b1, a2, a3], 'all');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'group', topic: '主题A', count: 3 });
    expect(rows[1]).toMatchObject({ kind: 'single', item: b1 });
    if (rows[0].kind === 'group') {
      expect(rows[0].items).toEqual([a1, a2, a3]); // 组内保持原相对顺序
    }
  });

  it('topic 严格字符串相等：Foo / foo / Foo 互不合并', () => {
    const rows = buildHistoryRows(
      [
        item('a-1', 'Foo'),
        item('a-2', 'foo'),
        item('a-3', 'Foo'),
        item('a-4', 'Foo '),
      ],
      'all',
    );

    expect(rows.map((r) => (r.kind === 'group' ? r.topic : r.item.topic))).toEqual([
      'Foo',
      'foo',
      'Foo ',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'group', count: 2 });
    expect(rows[1]).toMatchObject({ kind: 'single' });
    expect(rows[2]).toMatchObject({ kind: 'single' });
  });

  it('空输入返回空数组，且不修改入参数组', () => {
    expect(buildHistoryRows([], 'all')).toEqual([]);
    expect(buildHistoryRows([], 'mistakes')).toEqual([]);

    const input = [item('a-1', '主题A'), item('a-2', '主题A')];
    const snapshot = [...input];
    buildHistoryRows(input, 'mistakes');
    expect(input).toEqual(snapshot);
  });
});

describe('buildHistoryRows 最新掌握情况（FR-6）', () => {
  it('latest 取 createdAt 最大；并列时 attemptId 字典序最大', () => {
    const oldOne = item('a-1', 'T', { createdAt: '2026-10-01Z', correctCount: 2 });
    const tiedSmall = item('z-1', 'T', { createdAt: '2026-10-05Z', correctCount: 3 });
    const tiedLarge = item('z-2', 'T', { createdAt: '2026-10-05Z', correctCount: 4 });

    const rows = buildHistoryRows([oldOne, tiedSmall, tiedLarge], 'all');
    expect(rows[0].kind).toBe('group');
    if (rows[0].kind === 'group') {
      expect(rows[0].latest.attemptId).toBe('z-2');
      expect(rows[0].latest.correctCount).toBe(4);
    }
  });

  it('latest completed 2/5 视作有错题，5/5 视作满分', () => {
    const withMistake = buildHistoryRows(
      [item('a-1', 'T', { correctCount: 5 }), item('a-2', 'T', { correctCount: 2 })],
      'all',
    )[0];
    expect(withMistake.kind).toBe('group');
    if (withMistake.kind === 'group') {
      expect(withMistake.latest.status).toBe('completed');
      expect(withMistake.latest.correctCount).toBe(2);
      expect(isMistakeItem(withMistake.latest)).toBe(true);
    }

    const perfect = buildHistoryRows(
      [
        item('a-1', 'T', { correctCount: 2 }),
        item('a-2', 'T', { createdAt: '2026-10-09Z', correctCount: 5 }),
      ],
      'all',
    )[0];
    if (perfect.kind === 'group') {
      expect(perfect.latest.correctCount).toBe(5);
      expect(isMistakeItem(perfect.latest)).toBe(false);
    }
  });

  it('最新记录 in_progress 时 latest 为未完成，即使更早有 completed', () => {
    const rows = buildHistoryRows(
      [
        item('a-1', 'T', { createdAt: '2026-10-01Z', correctCount: 5 }),
        item('a-2', 'T', {
          createdAt: '2026-10-09Z',
          status: 'in_progress',
          correctCount: null,
          completedAt: null,
        }),
      ],
      'all',
    );

    expect(rows[0].kind).toBe('group');
    if (rows[0].kind === 'group') {
      expect(rows[0].latest.attemptId).toBe('a-2');
      expect(rows[0].latest.status).toBe('in_progress');
      expect(rows[0].latest.correctCount).toBeNull();
      // 组件据此显示「未完成」
      expect(rows[0].latest.status === 'in_progress').toBe(true);
    }
  });

  it('group.difficulty 取 latest 的难度', () => {
    const rows = buildHistoryRows(
      [
        item('a-1', 'T', { createdAt: '2026-10-01Z', difficulty: 'beginner' }),
        item('a-2', 'T', { createdAt: '2026-10-09Z', difficulty: 'advanced' as QuizDifficulty }),
      ],
      'all',
    );

    expect(rows[0]).toMatchObject({ kind: 'group', difficulty: 'advanced' });
  });
});

describe('buildHistoryRows 先分组再筛选（FR-7/FR-8）', () => {
  it('待复盘只保留含错题组；组内全部记录均保留（含满分）', () => {
    const mistake = item('a-1', '主题A', { correctCount: 2 });
    const perfectOld = item('a-2', '主题A', { correctCount: 5 });
    const perfectNew = item('a-3', '主题A', {
      createdAt: '2026-10-09Z',
      correctCount: 5,
    });
    const perfectOnly = item('b-1', '主题B', { correctCount: 5 });

    const rows = buildHistoryRows(
      [mistake, perfectOld, perfectNew, perfectOnly],
      'mistakes',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'group',
      topic: '主题A',
      mistakeCount: 1,
      hasMistake: true,
    });
    if (rows[0].kind === 'group') {
      expect(rows[0].items).toEqual([mistake, perfectOld, perfectNew]); // 不做组内二次筛选
    }
  });

  it('待复盘保留错题单条、丢弃满分单条；全部筛选保留所有行', () => {
    const mistakeSingle = item('a-1', '错题单条', { correctCount: 1 });
    const perfectSingle = item('b-1', '满分单条', { correctCount: 5 });
    const inProgressSingle = item('c-1', '未完成单条', {
      status: 'in_progress',
      correctCount: null,
      completedAt: null,
    });
    const all = [mistakeSingle, perfectSingle, inProgressSingle];

    expect(buildHistoryRows(all, 'all')).toHaveLength(3);
    const mistakes = buildHistoryRows(all, 'mistakes');
    expect(mistakes).toHaveLength(1);
    expect(mistakes[0]).toMatchObject({ kind: 'single', item: mistakeSingle });
  });

  it('满分组在待复盘中被整体剔除，即使组内最新记录满分', () => {
    const rows = buildHistoryRows(
      [item('a-1', 'T', { correctCount: 5 }), item('a-2', 'T', { correctCount: 5 })],
      'mistakes',
    );
    expect(rows).toEqual([]);
  });
});
