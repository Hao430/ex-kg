/**
 * Spec R1 — 练习详情深链的纯函数契约。
 * 与 App.tsx / main.tsx 解耦：只测路径解析、首屏优先级与 URL 往返。
 */
import { describe, it, expect } from 'vitest';
import {
  parsePracticePath,
  resolveInitialLocation,
  resolvePopLocation,
  practiceDetailHref,
  PRACTICE_LIST_HREF,
} from '@/src/lib/practice-route';

const ID = '0192f0a0-1111-7222-8333-444455556666';

describe('practice-route: 路径解析', () => {
  it('解析 /practice/<uuid>', () => {
    expect(parsePracticePath(`/practice/${ID}`)).toBe(ID);
  });

  it('拒绝空 id、嵌套路径、尾斜杠与非法字符', () => {
    for (const p of ['/practice', '/practice/', '/practice/a/b', `/practice/${ID}/`, '/practice/a b', '/practice/中文']) {
      expect(parsePracticePath(p)).toBeNull();
    }
  });

  it('detail href 与解析互逆', () => {
    expect(practiceDetailHref(ID)).toBe(`/practice/${ID}`);
    expect(parsePracticePath(practiceDetailHref(ID))).toBe(ID);
  });
});

describe('practice-route: 首屏优先级', () => {
  it('详情路径优先于 ?view=canvas 与 sessionStorage', () => {
    expect(resolveInitialLocation(`/practice/${ID}`, '?view=canvas', 'canvas')).toEqual({
      view: 'practice',
      attemptId: ID,
    });
  });

  it('?view=practice / quiz 进入练习列表', () => {
    expect(resolveInitialLocation('/', '?view=practice', 'canvas')).toEqual({ view: 'practice', attemptId: null });
    expect(resolveInitialLocation('/', '?view=quiz', null)).toEqual({ view: 'practice', attemptId: null });
  });

  it('无 query 时回落 sessionStorage，再回落 landing', () => {
    expect(resolveInitialLocation('/', '', 'practice')).toEqual({ view: 'practice', attemptId: null });
    expect(resolveInitialLocation('/', '', 'canvas')).toEqual({ view: 'canvas', attemptId: null });
    expect(resolveInitialLocation('/', '', null)).toEqual({ view: 'landing', attemptId: null });
  });
});

describe('practice-route: popstate 不读 sessionStorage', () => {
  it('后退到 / 且无 query 时应回 landing，而不是残留 practice', () => {
    expect(resolvePopLocation('/', '')).toEqual({ view: 'landing', attemptId: null });
  });

  it('后退到 ?view=canvas 或详情路径仍能识别', () => {
    expect(resolvePopLocation('/', '?view=canvas')).toEqual({ view: 'canvas', attemptId: null });
    expect(resolvePopLocation(`/practice/${ID}`, '')).toEqual({ view: 'practice', attemptId: ID });
  });

  it('列表 href 常量保持 query 口径', () => {
    expect(PRACTICE_LIST_HREF).toBe('/?view=practice');
  });
});
