/**
 * Arch Test: 数据库作用域纪律（ADR-0019）
 *
 * 技术债 #0014 的守护线。把「谁在查库」变成每条查询都必须回答的问题之后，
 * 有三类回归是**静默**的，只能靠静态穷举拦住：
 *
 * 1. 仓储绕过 `getDb()` 直连连接池 → 查询没有作用域 → RLS 把结果拦成零行
 *    （表现为「数据凭空消失」，不是报错）；
 * 2. 仓储自己手写 BEGIN/COMMIT/ROLLBACK/release → 与 `withTransaction` 的事务边界打架；
 * 3. `runWithSystem()` 的 reason 被写成空串 → 审计文本丢失，事后无法回答
 *    「这次跨租户升级是谁批准的」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REPOS_DIR = join(REPO_ROOT, 'server', 'repositories');

const repoFiles = readdirSync(REPOS_DIR).filter((f) => f.endsWith('.ts'));
const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(REPO_ROOT, p);

/**
 * 把**整行注释**抹成等长空白（保留换行与字符偏移，行号仍可原样报告）。
 *
 * 这两道守护线问的是「代码里有没有调用 X」，而注释里提到 `X()` 是常态
 * （`canvas.repository.ts` 的注释就写着「initDbSchema() 不创建这一列」）。
 * 不区分注释与代码，守护线第一次误报就会被人绕过或删掉——那才是真正的失效。
 * 代价：行**尾**注释里的调用点看不见，属于可接受的漏报方向（真调用点不会写在注释里）。
 */
function maskCommentLines(src) {
  return src
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

/** 允许直连连接池的文件（都必需，且各自有明确理由） */
const POOL_ACCESS_ALLOWLIST = new Set([
  'server/core/pool.ts', // 池的定义处
  'server/core/db.ts', // 唯一句柄：唯一获准按作用域取池的地方
  'server/core/schema.ts', // 迁移：owner 角色，不经请求作用域
  'server/core/migrate-cli.ts', // 迁移入口：owner 角色
]);

/** 允许使用 getDb() 的非仓储文件（跨租户任务与探活，均自带 system 作用域） */
const GETDB_ALLOWLIST = new Set([
  'server/core/db.ts',
  'server/core/db-status.ts',
  'server/jobs/log-cleanup.ts',
  'server/core/pool.ts', // 注释中提及
  'server/core/db-context.ts', // 注释中提及
]);

test('仓储不得直连连接池（必须走带作用域校验的 getDb()）', () => {
  const offenders = [];
  for (const f of repoFiles) {
    const src = read(join(REPOS_DIR, f));
    if (/\bgetPool\s*\(/.test(src)) offenders.push(`${f}: getPool(`);
    if (/\bgetAppPool\s*\(|\bgetSystemPool\s*\(|\bgetAdminPool\s*\(|\bgetMigrationPool\s*\(/.test(src)) {
      offenders.push(`${f}: 直接取池`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `仓储必须用 getDb()（自动注入 app.user_id 作用域）：\n${offenders.join('\n')}`
  );
});

test('仓储不得手写事务边界（一律 db.withTransaction）', () => {
  const offenders = [];
  for (const f of repoFiles) {
    const src = read(join(REPOS_DIR, f));
    for (const pat of [/\.connect\s*\(/, /['"]BEGIN['"]/, /['"]COMMIT['"]/, /['"]ROLLBACK['"]/, /client\.release\s*\(/]) {
      if (pat.test(src)) offenders.push(`${f}: ${pat}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `事务边界由 db.withTransaction 统一管理（同时负责注入作用域与 BEGIN/COMMIT/ROLLBACK/release）：\n${offenders.join('\n')}`
  );
});

test('仓储不得调用 initDbSchema（迁移已移出应用进程，ADR-0019 决策二）', () => {
  const offenders = repoFiles.filter((f) => /\binitDbSchema\s*\(/.test(maskCommentLines(read(join(REPOS_DIR, f)))));
  assert.deepEqual(
    offenders,
    [],
    `生产迁移由部署期 migrate 步骤以 owner 角色执行；仓储的懒迁移已摘除：${offenders.join(', ')}`
  );
});

test('仓储不得出现 DB_SCOPE_MISSING 的降级分支（无作用域必须响亮失败）', () => {
  const offenders = repoFiles.filter((f) => /DB_SCOPE_MISSING/.test(read(join(REPOS_DIR, f))));
  assert.deepEqual(
    offenders,
    [],
    `无作用域时 getDb() 自行抛 500，仓储不得捕获后降级（静默降级会让策略失效变成零行读取）：${offenders.join(', ')}`
  );
});

test('直连连接池的文件限于白名单（新增即需在此写明理由）', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry.name)) continue;
      const src = read(full);
      if (/getAppPool\s*\(|getSystemPool\s*\(|getAdminPool\s*\(|getMigrationPool\s*\(|getPoolOf\s*\(/.test(src)) {
        const path = rel(full);
        if (!POOL_ACCESS_ALLOWLIST.has(path)) offenders.push(path);
      }
    }
  };
  walk(join(REPO_ROOT, 'server'));
  walk(join(REPO_ROOT, 'arch-tests'));
  assert.deepEqual(
    offenders,
    [],
    `只有白名单文件可以直连连接池——其他位置一律走 getDb()，否则作用域校验被绕过：\n${offenders.join('\n')}`
  );
});

test('runWithSystem 的 reason 必须是非空字面量（跨租户升级要可审计）', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry.name)) continue;
      const src = maskCommentLines(read(full));

      // 只认**真实调用点**：runWithSystem 前面必须是 await / return / void / => / = / (
      // 定义处（`function runWithSystem<T>(`）与报错文案里的散文引用都不满足这个前缀。
      for (const m of src.matchAll(/(await|return|void|=>|=|\()\s*runWithSystem\(/g)) {
        const after = src.slice(m.index + m[0].length);
        const trimmed = after.replace(/^\s+/, '');
        const line = src.slice(0, m.index).split('\n').length;
        if (!/^['"`]/.test(trimmed)) {
          offenders.push(`${rel(full)}:${line} reason 不是字面量`);
          continue;
        }
        // 提取第一个字符串字面量，要求非空
        const lit = trimmed.match(/^(['"`])([\s\S]*?)\1/);
        if (!lit || !lit[2].trim()) offenders.push(`${rel(full)}:${line} reason 为空`);
      }
    }
  };
  walk(join(REPO_ROOT, 'server'));
  assert.deepEqual(offenders, [], `runWithSystem 的 reason 必填且需可读（写明为何需要跨租户）：\n${offenders.join('\n')}`);
});

test('非仓储文件使用 getDb() 限于白名单（防作用域要求被绕过）', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry.name)) continue;
      const path = rel(full);
      if (path.startsWith('server/repositories/')) continue;
      if (!/\bgetDb\s*\(/.test(read(full))) continue;
      if (!GETDB_ALLOWLIST.has(path)) offenders.push(path);
    }
  };
  walk(join(REPO_ROOT, 'server'));
  assert.deepEqual(offenders, [], `以下文件使用 getDb() 但不在白名单内：\n${offenders.join('\n')}`);
});
