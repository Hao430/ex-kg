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
 * 路由方法正则：匹配**任意** `<变量>.get|post|put|patch|delete(` 形式的路由定义。
 *
 * ⚠️ 历史教训（2026-09-16 ADR-0022 / 2026-10-03）：本判据原先**硬编码 router 变量名白名单**，
 * 新增 `server/routes/*.ts` 时若忘了把它的变量名加进来，该文件会匹配不到任何路由
 * （methods.length === 0 → continue）而被**静默跳过**、限流纪律对它零覆盖。
 * 先后漏掉过 `wechatRouter` 与 `foldersRouter`——后者在白名单补齐前已存在数月，
 * 一直无人发现（该文件确有 `folderActionRateLimiter`，属治理覆盖缺失而非漏配限流）。
 *
 * 故改为**从文件自身动态发现** router 变量名，不再枚举：
 *   1. 优先匹配显式定义 `const xRouter = Router()` / `Router()` 的变量；
 *   2. 兜底匹配「以 Router 结尾的任意变量名」，覆盖别名等写法。
 * 变量名怎么变都会被覆盖，治理判据不再依赖人工登记。
 */
const ROUTER_DECL_RE = /\b(\w*[Rr]outer\w*)\s*(?::\s*Router)?\s*=\s*Router\s*\(\s*\)/g;

/** 匹配任意 `变量.METHOD(`，METHOD 为 HTTP 动词；`\w+` 前缀确保排除 res.status( 之类 */
const ROUTE_METHOD_RE = /\b(\w+)\.(get|post|put|patch|delete)\s*\(/g;

test('routes 目录下每个路由文件都引用至少一个限流器（ADR-0007）', () => {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();

  const violations = [];
  const uncovered = [];
  const coverage = [];

  for (const file of files) {
    if (FILE_ALLOWLIST.has(file)) continue;

    const filePath = join(ROUTES_DIR, file);
    const content = readFileSync(filePath, 'utf-8');

    // 动态发现本文件的 router 变量名（见 ROUTER_DECL_RE 处注释）
    const declared = [...content.matchAll(ROUTER_DECL_RE)].map((m) => m[1]);
    const routerNames = new Set(declared);
    // 兜底：显式定义没抓到时，退而匹配所有 `xxxRouter.method(`
    if (routerNames.size === 0) {
      for (const m of content.matchAll(ROUTE_METHOD_RE)) {
        if (/router$/i.test(m[1])) routerNames.add(m[1]);
      }
    }

    // 只统计「确属 router 变量」的路由定义，避免把 res.status( / req.get( 等
    // 普通方法调用误判成路由（那会让判据对文件产生假阴性）
    const methods = [...content.matchAll(ROUTE_METHOD_RE)]
      .filter((m) => routerNames.has(m[1]))
      .map((m) => ({ name: m[1], method: m[2].toUpperCase(), snippet: m[0] }));

    // 路由文件里一个 router.METHOD 都没有 → 该文件对判据零覆盖，登记下来
    if (methods.length === 0) {
      uncovered.push(file);
      continue;
    }

    coverage.push(`${file}(${methods.length})`);

    // 至少一个限流器引用
    const hasLimiter = /\b\w+Limiter\b/.test(content);

    if (!hasLimiter) {
      violations.push({
        file,
        routeCount: methods.length,
        snippet: methods[0].snippet,
      });
    }
  }

  // 零覆盖本身是治理缺陷：文件里存在 Router 定义却没被识别出任何路由
  assert.deepEqual(
    uncovered,
    [],
    `以下路由文件含 Router 定义但未识别出任何路由定义，限流判据对它们零覆盖。\n` +
      `  - ${uncovered.join('\n  - ')}\n` +
      `通常意味着 ROUTER_DECL_RE / ROUTE_METHOD_RE 与新的 router 声明写法不匹配，请更新正则而非加白名单。`
  );

  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  - ${v.file} (${v.routeCount} routes, first: ${v.snippet})`)
      .join('\n');
    assert.fail(
      `以下 ${violations.length} 个路由文件未挂载限流器（ADR-0007）。\n` +
        `解决：1) 在文件顶部 import 限流器并挂到路由；2) 或加入 FILE_ALLOWLIST 并写明理由。\n${msg}`
    );
  }

  // 覆盖面登记：新增路由文件后这行会变，diff 即为「判据覆盖到了哪些文件」
  console.log(`    限流判据覆盖: ${coverage.join(', ')}`);
});
