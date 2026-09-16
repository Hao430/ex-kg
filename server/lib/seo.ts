/**
 * SEO 注入层（纯函数，无副作用、无 IO）。
 *
 * 分工：`server.ts` 负责「读一次 dist/index.html / 挂路由 / 决定状态码」，
 * 本文件负责「把某个路由的 head 与静态回退块拼出来」。所有函数都是字符串进字符串出，
 * 因此可以在 `tests/seo.test.ts` 里脱离 HTTP 与数据库直接单测。
 *
 * 设计要点：
 * - 文案与结构化数据全部取自 `shared/product-content.ts`，本文件不写死任何营销文案，
 *   否则「页面可见内容」与「schema / 回退块」会漂移。
 * - `APP_URL` 一律**运行期**读取（dotenv 在 server.ts 里晚于所有 import 执行，
 *   模块级读 process.env 恒为 undefined——本项目已踩过三次的坑）。
 * - canonical / og:url 必须是绝对地址，来源是 `resolveOrigin()`；
 *   未配置 APP_URL 时才回落到请求头推导（受 Host 头影响，故仅用于本地/测试）。
 *   `og:image` 例外：它指向对象存储直出的固定封面（`OG_IMAGE`），与本域无关。
 */

import {
  BRAND,
  LANDING_FAQS,
  LANDING_H1,
  LANDING_HIGHLIGHTS,
  LANDING_LEAD,
  LANDING_SCENARIOS,
  OG_IMAGE,
  SEO_ROUTES,
  type SeoRouteKey,
} from '../../shared/product-content.js';
import { escapeHtml } from './html.js';

export type SeoRoute = SeoRouteKey;

/** index.html 里的注入标记（Vite 构建保留 HTML 注释，标记会活到 dist/index.html） */
export const SEO_HEAD_MARKER = { start: '<!--seo:head-->', end: '<!--/seo:head-->' };
export const SEO_BODY_MARKER = { start: '<!--seo:body-->', end: '<!--/seo:body-->' };

/** 只依赖结构，避免把一个 Express 类型拖进本模块（也便于测试直接传字面量） */
export interface OriginRequest {
  protocol: string;
  get(name: string): string | undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 站点规范来源（canonical / og:url / sitemap 的基址）。
 *
 * 优先 `APP_URL` 并用 `new URL()` 校验：本地 `.env` 的占位符 `APP_URL="MY_APP_URL"`
 * 不是合法绝对地址，会被判非法而回落——**不得**把一个占位符写进 canonical，
 * 否则等于向搜索引擎声明「本站的规范地址是 MY_APP_URL」。
 */
export function resolveOrigin(req: OriginRequest): string {
  const raw = process.env.APP_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // 占位符 / 非法值：落到按请求推导（本地开发与测试的常态）
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

/** 命中被 SEO 注入层接管的路径；返回 null 表示不接管（交给静态资源或 404） */
export function routeForPath(pathname: string): SeoRoute | null {
  if (pathname === '/' || pathname === '/index.html') return 'home';
  if (pathname === '/reset-password') return 'reset-password';
  if (pathname === '/verify-email') return 'verify-email';
  if (/^\/share\/[^/]+$/.test(pathname)) return 'share';
  return null;
}

function canonicalPath(route: SeoRoute, pathname: string): string {
  // /index.html 与 / 是同一份内容，规范地址必须统一到 /，否则构成重复内容
  if (route === 'home') return '/';
  return pathname;
}

function buildJsonLd(origin: string): string {
  const home = SEO_ROUTES.home;
  const graph = [
    {
      '@type': 'WebSite',
      '@id': `${origin}/#website`,
      name: BRAND.name,
      alternateName: BRAND.latin,
      url: `${origin}/`,
      description: home.description,
      inLanguage: 'zh-CN',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${origin}/#app`,
      name: `${BRAND.name}${BRAND.latin}`,
      applicationCategory: 'ProductivityApplication',
      operatingSystem: 'Web',
      url: `${origin}/`,
      description: home.description,
      inLanguage: 'zh-CN',
      featureList: LANDING_HIGHLIGHTS.map((item) => `${item.label}：${item.sub}`),
      isPartOf: { '@id': `${origin}/#website` },
    },
    {
      '@type': 'FAQPage',
      '@id': `${origin}/#faq`,
      mainEntity: LANDING_FAQS.map((faq) => ({
        '@type': 'Question',
        name: faq.q,
        acceptedAnswer: { '@type': 'Answer', text: faq.a },
      })),
    },
  ];

  // `<` 一律转义，避免内容里出现 </script> 提前闭合脚本标签
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
    /</g,
    '\\u003c'
  );
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * 生成 `<!--seo:head-->` 与 `<!--/seo:head-->` 之间的内容。
 * ⚠️ 必须整段替换该区间：`index.html` 里原有的 title/description/og 标签也在区间内，
 * 若只做追加就会出现两个 `<title>`。
 */
export function buildSeoHead(
  route: SeoRoute,
  context: { origin: string; pathname: string }
): string {
  const meta = SEO_ROUTES[route];
  const { origin } = context;
  const path = canonicalPath(route, context.pathname);
  const canonical = `${origin}${path}`;
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);

  const lines = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta name="robots" content="${escapeHtml(meta.robots)}" />`,
  ];

  // 404 不给 canonical：它没有可指向的规范地址，声明一个等于把错误页伪装成正常页
  if (route !== 'not-found') {
    lines.push(`<link rel="canonical" href="${escapeHtml(canonical)}" />`);
  }

  lines.push(
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(`${BRAND.name}${BRAND.latin}`)}" />`,
    `<meta property="og:locale" content="zh_CN" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(OG_IMAGE.url)}" />`,
    `<meta property="og:image:secure_url" content="${escapeHtml(OG_IMAGE.url)}" />`,
    `<meta property="og:image:type" content="${OG_IMAGE.type}" />`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE.alt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${escapeHtml(OG_IMAGE.url)}" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(OG_IMAGE.alt)}" />`
  );

  if (route === 'home') lines.push(buildJsonLd(origin));

  return lines.join('\n    ');
}

/**
 * 回退块样式：**刻意不依赖 Tailwind**（构建期裁剪行为对非 JSX 来源不可靠），
 * 用自带深色底 + 基础排版，让「JS 还没加载完」的这几百毫秒看起来像一版简约页面，
 * 而不是裸文本。样式与块都带 data-seo-fallback，`src/main.tsx` 挂载前会一并移除。
 */
const FALLBACK_STYLE = `<style data-seo-fallback>
      #seo-static{background:#070a13;color:#cbd5e1;padding:32px 20px 56px;max-width:880px;margin:0 auto;line-height:1.75;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
      #seo-static h1{font-size:26px;line-height:1.45;color:#fff;margin:0 0 16px;font-weight:800}
      #seo-static h2{font-size:18px;color:#fff;margin:32px 0 12px;padding-top:20px;border-top:1px solid rgba(255,255,255,.08)}
      #seo-static h3{font-size:15px;color:#fff;margin:20px 0 6px;font-weight:600}
      #seo-static p,#seo-static li{font-size:14px;margin:0}
      #seo-static p{color:#cbd5e1}
      #seo-static ul{margin:0;padding-left:20px}
      #seo-static li{margin:6px 0}
      #seo-static strong{color:#e2e8f0;margin-right:6px}
    </style>`;

/**
 * 生成 `<!--seo:body-->` 与 `<!--/seo:body-->` 之间的内容。
 *
 * 只有落地页需要正文：分享页的服务端拿不到快照内容（且已 noindex），
 * 工具页/404 页没有可收录正文。JS 可用时这块会被 `main.tsx` 整体移除，
 * 因此稳态 DOM 里不会出现第二个 H1、也不会留下隐藏文本。
 */
export function buildSeoBody(route: SeoRoute): string {
  if (route !== 'home') return '';

  const highlights = LANDING_HIGHLIGHTS.map(
    (item) => `<li><strong>${escapeHtml(item.label)}</strong>${escapeHtml(item.sub)}</li>`
  ).join('\n        ');
  const scenarios = LANDING_SCENARIOS.map(
    (item) => `<li><strong>${escapeHtml(item.title)}</strong>${escapeHtml(item.desc)}</li>`
  ).join('\n        ');
  const faqs = LANDING_FAQS.map(
    (faq) =>
      `<h3>${escapeHtml(faq.q)}</h3>\n        <p>${escapeHtml(faq.a)}</p>`
  ).join('\n        ');

  return `${FALLBACK_STYLE}
    <div id="seo-static" data-seo-fallback>
      <h1>${escapeHtml(LANDING_H1.lead)} —— ${escapeHtml(LANDING_H1.accent)}</h1>
      <p>${escapeHtml(LANDING_LEAD)}</p>
      <h2>核心能力</h2>
      <ul>
        ${highlights}
      </ul>
      <h2>适用场景</h2>
      <ul>
        ${scenarios}
      </ul>
      <h2>常见问题</h2>
      ${faqs}
    </div>`;
}

function replaceRegion(
  html: string,
  marker: { start: string; end: string },
  content: string
): string {
  const startIndex = html.indexOf(marker.start);
  const endIndex = html.indexOf(marker.end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    // 响亮失败：标记缺失时宁可 500，也不要静默吐出一份没有 title 的 HTML
    throw new Error(`SEO 注入失败：index.html 缺少 ${marker.start} 标记`);
  }
  return (
    html.slice(0, startIndex + marker.start.length) +
    '\n    ' +
    content +
    '\n    ' +
    html.slice(endIndex)
  );
}

/** 按路由注入 head 与正文块；仅替换标记之间的内容，绝不触碰标记之外（保住 Vite 的 assets 引用） */
export function injectSeo(
  html: string,
  route: SeoRoute,
  context: { origin: string; pathname: string }
): string {
  const headHtml = replaceRegion(html, SEO_HEAD_MARKER, buildSeoHead(route, context));
  return replaceRegion(headHtml, SEO_BODY_MARKER, buildSeoBody(route));
}

export function buildRobotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /reset-password',
    'Disallow: /verify-email',
    'Disallow: /share/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** sitemap 只列可收录路由：工具页与分享页是 noindex，列进去等于自相矛盾 */
export function buildSitemapXml(origin: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${escapeXml(`${origin}/`)}</loc>`,
    '    <changefreq>weekly</changefreq>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');
}
