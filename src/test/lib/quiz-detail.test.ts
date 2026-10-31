/** Spec R1 — 详情页纯计算。 */
import { describe, it, expect } from 'vitest';
import { countWrong, filterGradeResults, formatElapsed, sumElapsedMs } from '@/src/lib/quiz-detail';
import type { QuizGradeResult } from '@/src/lib/quiz-store';

function r(id: string, correct: boolean, ms: number): QuizGradeResult {
  return {
    questionId: id, type: 'single', stem: '题干', isCorrect: correct,
    choice: correct ? 'A' : 'B', options: null, answer: 'A', explanation: '解析',
    knowledgePoint: 'kp', elapsedMs: ms, lowConfidence: false,
  };
}

describe('quiz-detail 纯计算', () => {
  const results = [r('q1', true, 3000), r('q2', false, 5000), r('q3', false, 2000)];

  it('filterGradeResults 只筛展示，不修改原数组', () => {
    expect(filterGradeResults(results, false)).toHaveLength(3);
    expect(filterGradeResults(results, true).map((x) => x.questionId)).toEqual(['q2', 'q3']);
    expect(results).toHaveLength(3);
    expect(countWrong(results)).toBe(2);
  });

  it('sumElapsedMs 对脏值兜底，formatElapsed 可读', () => {
    expect(sumElapsedMs(results)).toBe(10000);
    expect(sumElapsedMs([r('x', true, Number.NaN), r('y', true, -1)])).toBe(0);
    expect(formatElapsed(0)).toBe('—');
    expect(formatElapsed(500)).toBe('不足 1 秒');
    expect(formatElapsed(45_000)).toBe('45 秒');
    expect(formatElapsed(125_000)).toBe('2 分 5 秒');
    expect(formatElapsed(120_000)).toBe('2 分钟');
  });
});
