/**
 * Arch Test: 跨租户归属探针纪律（ADR-0019）
 *
 * RLS 生效后，app 角色**看不见**他人的行。这把一个应用层依赖悄悄打碎了：
 * 「这块画板存在，但不是你的」（403）与「这块画板不存在」（404）在 RLS 眼里
 * 是同一个结果——查询返回零行。于是 saveCanvas 会把别人的画板当成不存在，
 * 走进 INSERT 路径；deleteCanvas / updateCanvasMeta 会把 403 说成 404。
 *
 * 解法是一个**特权探针** `canvas_probe`（SECURITY DEFINER，以属主身份执行、
 * 绕过策略，只回答「某 id 归谁」这一个事实）。它是本案唯一的策略旁路，
 * 因此必须同时锁住两件事：
 *
 *   1. 它**不得扩散**——用在哪里、谁在用，必须一眼数得清；
 *   2. 它**不得被换回直查**——换回去不会报错，只会让 403 静默变 404。
 *
 * 反向也要锁： `getCanvas` 走直查 + RLS 过滤，是**刻意**的（他人画板 = 404，
 * 与改造前契约一致）。别为了「统一风格」给它加探针——那会把 404 变成 403。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CANVAS_REPO = join(REPO_ROOT, 'server', 'repositories', 'canvas.repository.ts');
const SCHEMA = join(REPO_ROOT, 'server', 'core', 'schema.ts');

const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(REPO_ROOT, p);
const canvasRepo = read(CANVAS_REPO);

/**
 * 允许出现 canvas_probe 的文件——**每一处都要写明理由**，这就是「一眼数得清」的含义。
 * 新增一行 = 新增一处策略旁路，必须在 ADR-0019 里论证。
 */
const PROBE_ALLOWLIST = new Set([
  'server/core/schema.ts', // 定义处（含权限收回与按需授予）
  'server/repositories/canvas.repository.ts', // 唯一使用方：四个归属判定点
  'tests/pg/rls-isolation.pg.test.ts', // 验证探针本身：它在受限角色下能否问到他人归属，只能用真的调用去证
]);

/**
 * 切出某个顶层导出函数的函数体（到下一个顶格 `export` 为止）。
 * 找不到 = 函数被改名/删除了，调用方必须回来更新这里的清单。
 */
function functionBody(src, name) {
  const start = src.search(new RegExp(`^export async function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `canvas.repository.ts 里找不到 ${name}()——它被改名或删除了？本测试的清单需要同步更新`);
  const rest = src.slice(start + 1);
  const end = rest.search(/^export /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** 「按 id 直查 canvases」的形态：正是被探针替换掉的那种读法 */
const DIRECT_BY_ID_READ = /FROM\s+canvases(?:\s+(?:AS\s+)?\w+)?\s+WHERE\s+(?:\w+\.)?id\s*=/i;

/** 必须靠探针才能把「不存在」与「不是你的」分开的四个归属判定点 */
const OWNERSHIP_DECISIONS = ['saveCanvas', 'deleteCanvas', 'updateCanvasMeta', 'getCanvasOwnerInfo'];

test('特权探针只允许出现在定义处与唯一使用文件（不得扩散）', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|mjs)$/.test(entry.name)) continue;
      const path = rel(full);
      if (!/canvas_probe/.test(read(full))) continue;
      if (!PROBE_ALLOWLIST.has(path)) offenders.push(path);
    }
  };
  // 只扫生产代码与真库用例——这两处才是真的会去问数据库的地方。
  // arch-tests/ 不扫：它们是**文本断言**，不连库（rls-coverage 断言探针长什么样，
  // 不是在用它）；把静态检查也算作「使用点」会让这条守护线自相矛盾。
  walk(join(REPO_ROOT, 'server'));
  walk(join(REPO_ROOT, 'tests'));
  assert.deepEqual(
    offenders,
    [],
    `canvas_probe 是一条绕过 RLS 的特权读通道：只允许在 schema.ts 定义、在 canvas.repository.ts 使用。\n` +
      `新增使用点 = 新增一处策略旁路，必须在 ADR-0019 里论证：\n${offenders.join('\n')}`
  );
});

test('仓储层不得自行升级作用域（越权升级只允许在组合层）', () => {
  const offenders = [];
  const REPOS_DIR = join(REPO_ROOT, 'server', 'repositories');
  for (const f of readdirSync(REPOS_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = read(join(REPOS_DIR, f));
    for (const fn of ['runWithSystem', 'runWithUser']) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(src)) offenders.push(`${f}: ${fn}(`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `仓储必须保持在调用方给它的作用域内：\n` +
      `「这块数据要不要跨租户读」是组合层（service / route / job）的判断，\n` +
      `放在仓储里会让旁路散落在数据访问代码中、无法一眼数清（ADR-0019）：\n${offenders.join('\n')}`
  );
});

test('四个归属判定点必须走 canvas_probe（换回直查 = 403 静默变 404）', () => {
  const missing = [];
  for (const name of OWNERSHIP_DECISIONS) {
    const body = functionBody(canvasRepo, name);
    if (!/canvas_probe\s*\(/.test(body)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `以下函数必须用 canvas_probe 读归属，否则 RLS 下看不见他人的行：\n` +
      `「存在但非属主」会被误判成「不存在」——403 变 404，saveCanvas 还会误走新建路径：\n` +
      `${missing.join(', ')}`
  );
});

test('归属判定点不得同时保留按 id 直查 canvases 的旧写法', () => {
  const offenders = [];
  for (const name of OWNERSHIP_DECISIONS) {
    const body = functionBody(canvasRepo, name);
    if (DIRECT_BY_ID_READ.test(body)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `以下函数里既有探针又有按 id 直查 canvases——很可能是替换只做了一半，\n` +
      `直查那一半在 RLS 下恒返回零行，判定结果由它决定就是错的：\n${offenders.join(', ')}`
  );
});

test('探针只读：调用形态必须是 FROM canvas_probe(...)', () => {
  const offenders = [];
  const lines = canvasRepo.split('\n');
  lines.forEach((line, i) => {
    if (!/\bcanvas_probe\s*\(/.test(line)) return;
    if (!/FROM\s+canvas_probe\s*\(/i.test(line)) offenders.push(`canvas.repository.ts:${i + 1} ${line.trim()}`);
  });
  assert.deepEqual(
    offenders,
    [],
    `SECURITY DEFINER 函数以属主身份执行：一旦被用于写，就是一条**绕过 RLS 的写通道**，\n` +
      `比读泄露严重得多。探针只回答归属这一件事，写一律走带策略的正常路径：\n${offenders.join('\n')}`
  );
});

test('getCanvas 刻意不探针：他人画板一律 404（契约不得被"统一风格"改成 403）', () => {
  const body = functionBody(canvasRepo, 'getCanvas');
  assert.ok(
    DIRECT_BY_ID_READ.test(body),
    'getCanvas 应当按 id 直查 canvases，由 RLS 过滤掉他人的行——这是「他人画板 = 404」的实现方式'
  );
  assert.ok(
    !/canvas_probe\s*\(/.test(body),
    'getCanvas 不得引入 canvas_probe：探针会看见他人的行，使「不是你的」变成可判定——' +
      'GET /api/canvases/:id 的契约是 404（与改造前一致），加探针会把 404 变成 403'
  );
});

test('schema.ts 的探针定义是只读 + 锁死 search_path（与 rls-coverage 互为正反面）', () => {
  const src = read(SCHEMA);
  const m = src.match(/CREATE OR REPLACE FUNCTION canvas_probe[\s\S]*?\$\$/);
  assert.ok(m, 'schema.ts 必须定义 canvas_probe');
  const fn = m[0];
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(fn), 'canvas_probe 必须是纯读函数（只允许单条 SELECT）');
  assert.ok(
    /SET search_path\s*=\s*pg_catalog,\s*public/.test(fn),
    'SECURITY DEFINER 必须显式锁死 search_path，否则可被 search_path 劫持'
  );
  assert.ok(
    /REVOKE EXECUTE ON FUNCTION canvas_probe\(VARCHAR\) FROM PUBLIC/.test(src),
    'schema.ts 必须收回 PUBLIC 的默认 EXECUTE 权限：特权探针不能对全体角色开放'
  );
});
