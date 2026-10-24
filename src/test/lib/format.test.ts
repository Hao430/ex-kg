import { describe, it, expect } from 'vitest';
import { formatDate } from '@/src/lib/format';

describe('formatDate', () => {
  it('formats a local Date with zh-CN locale', () => {
    // 用本地时间构造，避免 CI 时区差异
    expect(formatDate(new Date(2026, 8, 1))).toBe('2026/9/1');
  });

  it('accepts ISO strings and timestamps', () => {
    expect(formatDate('2026-03-05T12:00:00Z')).toMatch(/^2026\/3\/[456]$/);
    expect(formatDate(new Date(2026, 4, 10).getTime())).toBe('2026/5/10');
  });

  it('returns empty string for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('');
    expect(formatDate(Number.NaN)).toBe('');
  });

  it('passes Intl options through', () => {
    expect(formatDate(new Date(2026, 8, 1), { month: 'long', day: 'numeric' })).toBe('9月1日');
  });
});
