/**
 * Spec R1 — 练习详情深链的服务端/SEO 契约。
 *
 * 私有按用户资源：必须 200 返回 SPA 壳（否则刷新 404），但 noindex、无 canonical、
 * robots 禁止收录；sitemap 不得列出。
 *
 * tests/ 只读：本文件为新增（用户 2026-10-25 授权）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeForPath,
  injectSeo,
  buildRobotsTxt,
  buildSitemapXml,
  SEO_SHELL_ROUTES,
  SEO_HEAD_MARKER,
  SEO_BODY_MARKER,
} from '../server/lib/seo.js';

const HTML = `<html><head>${SEO_HEAD_MARKER.start}${SEO_HEAD_MARKER.end}</head><body>${SEO_BODY_MARKER.start}${SEO_BODY_MARKER.end}</body></html>`;
const ID = '0192f0a0-1111-7222-8333-444455556666';

test('routeForPath 识别 /practice/:id，拒绝非法形态', () => {
  assert.equal(routeForPath(`/practice/${ID}`), 'practice');
  for (const p of ['/practice', '/practice/', '/practice/a/b', `/practice/${ID}/`, '/practice/a b']) {
    assert.equal(routeForPath(p), null, p + ' 不应被接管');
  }
});

test('practice 详情：注入 noindex，且不声明 canonical', () => {
  const html = injectSeo(HTML, 'practice', {
    origin: 'https://kg.example',
    pathname: `/practice/${ID}`,
  });
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.ok(!html.includes('rel="canonical"'), '私有详情页不得声明 canonical');
  assert.match(html, /练习详情/);
});

test('robots 禁止 /practice/，sitemap 不列详情页', () => {
  const robots = buildRobotsTxt('https://kg.example');
  assert.ok(robots.includes('Disallow: /practice/'));
  const sitemap = buildSitemapXml('https://kg.example');
  assert.ok(!sitemap.includes('/practice/'));
});

test('服务端 shell 路径表包含 /practice/:attemptId', () => {
  assert.ok((SEO_SHELL_ROUTES as readonly string[]).includes('/practice/:attemptId'));
});
