/**
 * Arch Test: 路由限流器纪律
 *
 * 检查 `server/routes/*.ts` 中每个 router.METHOD(...) 路径
 * 都挂载了限流器（ADR-0007）。
 *
 * 判据（粗略文本扫描）：
 *   - 文件内出现 router.METHOD( 后, 在同文件某处使用限流器变量
 *   - 至少引用一次 *RateLimiter 或 *Limiter
 *
 * 豁免清单（ALLOWLIST）：健康检查、静态资源等公开读端点。
 * 添加豁免时必须写明理由。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const ROUTES_DIR = join(REPO_ROOT, 'server', 'routes');

/** 不需要限流器的端点（按文件级豁免） */
const FILE_ALLOWLIST = new Set([
  // 健康检查等公开读端点
]);

/**
 * 路由方法正则。
 * ⚠️ 变量名白名单是硬编码的：新增 `server/routes/*.ts` 时**必须把它的 router 变量名加进来**，
 * 否则该文件匹配不到任何路由（methods.length === 0 → continue）而被静默跳过，
 * 限流器判据对它等于零覆盖。2026-09-16 加入 wechatRouter（ADR-0022）。
 */
const ROUTE_METHOD_RE = /\b(router|chatRouter|authRouter|adminRouter|canvasesRouter|subscriptionsRouter|quotaRouter|sharesRouter|wechatRouter)\.(get|post|put|patch|delete)\s*\(/g;

test('routes 目录下每个路由文件都引用至少一个限流器（ADR-0007）', () => {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();

  const violations = [];

  for (const file of files) {
    if (FILE_ALLOWLIST.has(file)) continue;

    const filePath = join(ROUTES_DIR, file);
    const content = readFileSync(filePath, 'utf-8');

    // 至少一个路由定义
    const methods = [...content.matchAll(ROUTE_METHOD_RE)];
    if (methods.length === 0) continue;

    // 至少一个限流器引用
    const hasLimiter = /\b\w+Limiter\b/.test(content);

    if (!hasLimiter) {
      violations.push({
        file,
        routeCount: methods.length,
        snippet: methods[0][0],
      });
    }
  }

  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  - ${v.file} (${v.routeCount} routes, first: ${v.snippet})`)
      .join('\n');
    assert.fail(
      `以下 ${violations.length} 个路由文件未挂载限流器（ADR-0007）。\n` +
        `解决：1) 在文件顶部 import 限流器并挂到路由；2) 或加入 FILE_ALLOWLIST 并写明理由。\n${msg}`
    );
  }
});
