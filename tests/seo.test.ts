/**
 * SEO 注入层 — 纯函数单测（无 HTTP、无数据库）。
 *
 * 覆盖点：
 * - 路由判据：只有 `/`、`/index.html`、两个工具页与 `/share/:code` 被接管
 * - head 合成：每条路由恰好一个 `<title>`（区间整体替换，不是追加）、robots 指令、
 *   canonical 的有无、JSON-LD 仅在落地页且可被 JSON.parse（`<` 已转义）
 * - 正文回退块：仅落地页生成，且包含全部 FAQ / 能力条（与共享模块同源）
 * - 注入器：只替换标记之间，标记之外（Vite 注入的 assets 引用）必须原样保留；
 *   标记缺失要响亮抛错，而不是静默吐出一份没有 title 的 HTML
 * - robots.txt / sitemap.xml：只列可收录路由（noindex 的分享页不得出现在 sitemap 里）
 *
 * 说明：`server.ts` 的生产接线（读 dist/index.html、状态码、static 顺序）不在本文件里——
 * 它不能被 `createApp()` 实例化，且 `tests/` 默认只读、本轮只获批新增本文件。
 * 这一段由「生产模式 curl 验收」覆盖（见计划里的验收步骤）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRobotsTxt,
  buildSeoBody,
  buildSeoHead,
  buildSitemapXml,
  injectSeo,
  resolveOrigin,
  routeForPath,
} from '../server/lib/seo.js';
import {
  LANDING_FAQS,
  LANDING_H1,
  LANDING_HIGHLIGHTS,
  LANDING_LEAD,
  OG_IMAGE,
  SEO_ROUTES,
} from '../shared/product-content.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://kg.example.cn';
const fakeReq = (host = 'localhost:3000', protocol = 'http') => ({
  protocol,
  get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('SEO 路由判据', () => {
  test('接管的路径', () => {
    assert.equal(routeForPath('/'), 'home');
    assert.equal(routeForPath('/index.html'), 'home');
    assert.equal(routeForPath('/reset-password'), 'reset-password');
    assert.equal(routeForPath('/verify-email'), 'verify-email');
    assert.equal(routeForPath('/share/Ab3xY9kQz1'), 'share');
  });

  test('不接管的路径交给静态资源/404', () => {
    for (const p of ['/nope', '/share/', '/share/a/b', '/assets/index-abc.js', '/api/health', '/reset-password/x']) {
      assert.equal(routeForPath(p), null, `${p} 不应被 SEO 注入层接管`);
    }
  });
});

describe('resolveOrigin', () => {
  test('APP_URL 为合法绝对地址时以其 origin 为准（并剥掉路径）', () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://kg.hao430.cn/some/path/';
    try {
      assert.equal(resolveOrigin(fakeReq()), 'https://kg.hao430.cn');
    } finally {
      process.env.APP_URL = prev;
    }
  });

  test('APP_URL 是占位符时回落按请求推导（不得把 MY_APP_URL 写进 canonical）', () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'MY_APP_URL';
    try {
      assert.equal(resolveOrigin(fakeReq('localhost:3000')), 'http://localhost:3000');
      assert.equal(resolveOrigin(fakeReq('kg.hao430.cn', 'https')), 'https://kg.hao430.cn');
    } finally {
      process.env.APP_URL = prev;
    }
  });

  test('运行期读取（非模块级快照）：改环境变量后结果随之改变', () => {
    const prev = process.env.APP_URL;
    try {
      process.env.APP_URL = 'https://a.example.cn';
      const first = resolveOrigin(fakeReq());
      process.env.APP_URL = 'https://b.example.cn';
      const second = resolveOrigin(fakeReq());
      assert.equal(first, 'https://a.example.cn');
      assert.equal(second, 'https://b.example.cn');
    } finally {
      process.env.APP_URL = prev;
    }
  });
});

describe('buildSeoHead', () => {
  test('每条路由恰好一个 title 与一个 description', () => {
    for (const route of ['home', 'reset-password', 'verify-email', 'share', 'not-found'] as const) {
      const head = buildSeoHead(route, { origin: ORIGIN, pathname: '/' });
      assert.equal(count(head, '<title>'), 1, `${route} 应只有一个 title`);
      assert.equal(count(head, '<meta name="description"'), 1, `${route} 应只有一个 description`);
      assert.ok(head.includes(SEO_ROUTES[route].title), `${route} 的标题应取自 SEO_ROUTES`);
    }
  });

  test('robots 指令按路由下发（只有落地页可收录）', () => {
    const home = buildSeoHead('home', { origin: ORIGIN, pathname: '/' });
    assert.ok(home.includes('content="index, follow, max-image-preview:large"'));
    for (const route of ['reset-password', 'verify-email'] as const) {
      assert.ok(buildSeoHead(route, { origin: ORIGIN, pathname: `/${route}` }).includes('noindex'));
    }
    // 分享页是用户思考快照：noindex 但保留 follow
    assert.ok(
      buildSeoHead('share', { origin: ORIGIN, pathname: '/share/Ab3x' }).includes(
        'content="noindex, follow"'
      )
    );
  });

  test('canonical 指向规范地址，工具页/分享页指向自身，404 不给 canonical', () => {
    assert.ok(buildSeoHead('home', { origin: ORIGIN, pathname: '/index.html' }).includes(`<link rel="canonical" href="${ORIGIN}/" />`));
    assert.ok(buildSeoHead('home', { origin: ORIGIN, pathname: '/' }).includes(`<link rel="canonical" href="${ORIGIN}/" />`));
    assert.ok(buildSeoHead('share', { origin: ORIGIN, pathname: '/share/Ab3x' }).includes(`href="${ORIGIN}/share/Ab3x"`));
    assert.ok(!buildSeoHead('not-found', { origin: ORIGIN, pathname: '/nope' }).includes('rel="canonical"'));
  });

  test('og:url 走 canonical 来源，og:image 走对象存储封面（绝对地址，否则社交平台抓不到图）', () => {
    const head = buildSeoHead('home', { origin: ORIGIN, pathname: '/' });
    assert.ok(head.includes(`<meta property="og:url" content="${ORIGIN}/" />`));
    // 封面与本域解耦：写死对象存储地址，换图不必重新部署
    assert.ok(head.includes(`<meta property="og:image" content="${OG_IMAGE.url}" />`));
    assert.ok(head.includes(`<meta name="twitter:image" content="${OG_IMAGE.url}" />`));
    assert.ok(head.includes('<meta property="og:image:type" content="image/webp" />'));
    assert.ok(head.includes('<meta property="og:image:width" content="1600" />'));
    assert.ok(head.includes('<meta property="og:image:height" content="1600" />'));
    // 路径里含中文，必须是百分号编码形式（原始非 ASCII 会让部分抓取器解析失败）
    assert.ok(!/[\u4e00-\u9fa5]/.test(OG_IMAGE.url), 'og:image 的 URL 不得含未编码的中文');
    assert.ok(OG_IMAGE.url.endsWith('.webp'));
  });

  test('JSON-LD 仅在落地页，且是合法 JSON、三个类型齐全', () => {
    for (const route of ['reset-password', 'verify-email', 'share', 'not-found'] as const) {
      assert.ok(!buildSeoHead(route, { origin: ORIGIN, pathname: '/' }).includes('application/ld+json'));
    }

    const head = buildSeoHead('home', { origin: ORIGIN, pathname: '/' });
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head);
    assert.ok(match, '落地页应有 JSON-LD');
    const payload = match![1];
    // `<` 必须被转义成 \u003c：否则正文里的 </script> 会提前闭合脚本标签
    assert.equal(count(payload, '<'), 0);

    const parsed = JSON.parse(payload);
    assert.equal(parsed['@context'], 'https://schema.org');
    const types = parsed['@graph'].map((node: any) => node['@type']);
    assert.deepEqual(types.sort(), ['FAQPage', 'SoftwareApplication', 'WebSite']);

    const faqNode = parsed['@graph'].find((node: any) => node['@type'] === 'FAQPage');
    assert.equal(faqNode.mainEntity.length, LANDING_FAQS.length);
    assert.equal(faqNode.mainEntity[0].name, LANDING_FAQS[0].q);
    assert.equal(faqNode.mainEntity[0].acceptedAnswer.text, LANDING_FAQS[0].a);
  });
});

describe('buildSeoBody', () => {
  test('仅落地页生成正文回退块', () => {
    assert.ok(buildSeoBody('home').includes('id="seo-static"'));
    for (const route of ['reset-password', 'verify-email', 'share', 'not-found'] as const) {
      assert.equal(buildSeoBody(route), '');
    }
  });

  test('回退块与共享内容同源：H1、定义段、全部能力条与 FAQ 都在', () => {
    const body = buildSeoBody('home');
    assert.ok(body.includes(LANDING_H1.lead));
    assert.ok(body.includes(LANDING_H1.accent));
    assert.ok(body.includes(LANDING_LEAD));
    for (const item of LANDING_HIGHLIGHTS) {
      assert.ok(body.includes(item.label), `缺能力条：${item.label}`);
    }
    for (const faq of LANDING_FAQS) {
      assert.ok(body.includes(faq.q), `缺 FAQ 问：${faq.q}`);
      assert.ok(body.includes(faq.a), `缺 FAQ 答：${faq.q}`);
    }
    // 无 JS 爬虫看到的正文里只有一个 H1（与 React 侧的 H1 同源，不构成 cloaking）
    assert.equal(count(body, '<h1>'), 1);
    assert.ok(body.includes('data-seo-fallback'), '样式与块都要带标记，前端挂载前整体移除');
  });
});

describe('injectSeo', () => {
  const fixture = [
    '<html>',
    '<head>',
    '<!--seo:head-->',
    '<title>默认标题</title>',
    '<meta name="description" content="默认描述" />',
    '<!--/seo:head-->',
    '<script type="module" src="/assets/index-ABC.js"></script>',
    '</head>',
    '<body>',
    '<!--seo:body-->',
    '<!--/seo:body-->',
    '<div id="root"></div>',
    '</body>',
    '</html>',
  ].join('\n');

  test('整段替换 head 区间：不残留默认 title/description（否则出现两个 title）', () => {
    const html = injectSeo(fixture, 'home', { origin: ORIGIN, pathname: '/' });
    assert.equal(count(html, '<title>'), 1);
    assert.equal(count(html, '<meta name="description"'), 1);
    assert.ok(!html.includes('默认标题'));
    assert.ok(html.includes(SEO_ROUTES.home.title));
  });

  test('标记之外原样保留：Vite 注入的 assets 引用不能被吞（CI 部署验收就查它）', () => {
    const html = injectSeo(fixture, 'home', { origin: ORIGIN, pathname: '/' });
    assert.ok(html.includes('<script type="module" src="/assets/index-ABC.js"></script>'));
    assert.ok(html.includes('<div id="root"></div>'));
  });

  test('真仓库 index.html 也满足注入契约（默认 head 必须位于区间内）', () => {
    const shell = readFileSync(join(REPO_ROOT, 'index.html'), 'utf-8');
    const html = injectSeo(shell, 'home', { origin: ORIGIN, pathname: '/' });
    assert.equal(count(html, '<title>'), 1);
    assert.equal(count(html, '<meta name="description"'), 1);
    assert.ok(html.includes('id="seo-static"'));
    assert.ok(html.includes('src="/src/main.tsx"'));
    assert.ok(shell.includes('lang="zh-CN"'), '中文站点不得声明 lang="en"');
  });

  test('标记缺失时响亮抛错，不静默产出无 title 的页面', () => {
    assert.throws(
      () => injectSeo('<html><head></head><body></body></html>', 'home', { origin: ORIGIN, pathname: '/' }),
      /缺少 <!--seo:head--> 标记/
    );
    assert.throws(
      () => injectSeo('<!--seo:head--><!--/seo:head--><body></body>', 'home', { origin: ORIGIN, pathname: '/' }),
      /缺少 <!--seo:body--> 标记/
    );
  });
});

describe('robots.txt / sitemap.xml', () => {
  test('robots 用绝对地址指向 sitemap，并挡掉 API 与 noindex 页面', () => {
    const robots = buildRobotsTxt(ORIGIN);
    assert.ok(robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
    assert.ok(robots.includes('Allow: /'));
    for (const path of ['/api/', '/reset-password', '/verify-email', '/share/']) {
      assert.ok(robots.includes(`Disallow: ${path}`), `robots 应挡掉 ${path}`);
    }
  });

  test('sitemap 只列可收录路由（noindex 的分享页列进去等于自相矛盾）', () => {
    const xml = buildSitemapXml(ORIGIN);
    assert.ok(xml.includes(`<loc>${ORIGIN}/</loc>`));
    assert.ok(!xml.includes('/share/'));
    assert.ok(!xml.includes('reset-password'));
    assert.equal(count(xml, '<url>'), 1);
  });
});
