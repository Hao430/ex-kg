/**
 * Spec R1 — 练习详情页的纯展示计算（无 React / 无 store 依赖）。
 */
import type { QuizGradeResult } from './quiz-store';

/** 只看错题：仅过滤展示，summary 统计始终用全量结果 */
export function filterGradeResults(
  results: QuizGradeResult[],
  onlyWrong: boolean,
): QuizGradeResult[] {
  return onlyWrong ? results.filter((r) => !r.isCorrect) : results;
}

export function countWrong(results: QuizGradeResult[]): number {
  return results.filter((r) => !r.isCorrect).length;
}

/** 总用时（毫秒）；负数/非有限值按 0 计，防脏数据把汇总拖成 NaN */
export function sumElapsedMs(results: QuizGradeResult[]): number {
  return results.reduce((sum, r) => {
    const ms = Number(r.elapsedMs);
    return sum + (Number.isFinite(ms) && ms > 0 ? ms : 0);
  }, 0);
}

/** 人类可读用时：<60s 显示秒；否则“X 分 Y 秒”；不足 1 秒显示“不足 1 秒” */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return '不足 1 秒';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}
