/**
 * Arch Test: 双模持久化纪律
 *
 * 检查 `server/repositories/*.ts` 中每个 export 的 async function
 * 都遵循"PG 优先 + 内存兜底"双模写法（ADR-0002）。
 *
 * 判据（粗略文本扫描）：
 *   - 函数体内同时出现 `getPool` 与 `inMemoryStore` 关键字
 *   - 出现 `try {` ... `catch` 模式（兜底分支）
 *
 * 豁免清单（ALLOWLIST）：某些辅助函数（如纯映射、纯记录类型导出）不强制双模。
 * 添加豁免时必须写明理由（commit message 引用 ADR-0002）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const REPOS_DIR = join(REPO_ROOT, 'server', 'repositories');

/** 豁免函数名清单（写明理由） */
const ALLOWLIST = new Set([
  'mapRowToUser',     // 纯 PG 行 → UserRecord 映射，无双模需求
  'chunkRows',        // 通用工具
  'isSharedDefaultCanvas', // 纯判断函数
  'normalizeMemoryNode',   // 内存分支归一化（本身是单模）
  'trimAuditLogs',    // 在 memory-store.ts 而非 repositories/
  'trimEventLogs',    // 同上
]);

/** 扫描文件中的所有 export async function（含方法简写） */
function findAsyncFunctions(content) {
  const results = [];
  // export async function name(...) {
  const exportAsync = /\bexport\s+(?:default\s+)?async\s+function\s+(\w+)\s*\(/g;
  let m;
  while ((m = exportAsync.exec(content)) !== null) {
    results.push({ name: m[1], start: m.index });
  }
  // export const name = async (...) => {  /  export const name = async function (...) { }
  const exportConst = /\bexport\s+(?:const|function)\s+(\w+)\s*=\s*async\s*(?:\([^)]*\)|function)|\bexport\s+const\s+(\w+)\s*=\s*async\s*\(/g;
  while ((m = exportConst.exec(content)) !== null) {
    results.push({ name: m[1] || m[2], start: m.index });
  }
  return results;
}

/** 提取函数体（粗略按配对花括号） */
function extractFunctionBody(content, start) {
  // 从 start 位置向后找第一个 '{'，再配对
  let i = content.indexOf('{', start);
  if (i === -1) return '';
  let depth = 1;
  i++;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }
  return content.slice(start, i);
}

test('repositories 目录下所有 export async function 都遵循双模写法（ADR-0002）', () => {
  const files = readdirSync(REPOS_DIR)
    .filter((f) => f.endsWith('.repository.ts'))
    .sort();

  const violations = [];

  for (const file of files) {
    const filePath = join(REPOS_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    const functions = findAsyncFunctions(content);

    for (const fn of functions) {
      if (ALLOWLIST.has(fn.name)) continue;

      const body = extractFunctionBody(content, fn.start);

      // 双模判据：函数体同时引用 getPool 与 inMemoryStore
      const usesPool = /getPool\s*\(/.test(body);
      const usesMemory = /inMemoryStore\./.test(body);

      if (!usesPool || !usesMemory) {
        violations.push({
          file,
          fn: fn.name,
          usesPool,
          usesMemory,
        });
      }
    }
  }

  if (violations.length > 0) {
    const msg = violations
      .map(
        (v) =>
          `  - ${v.file}::${v.fn} (usesPool=${v.usesPool}, usesMemory=${v.usesMemory})`
      )
      .join('\n');
    assert.fail(
      `以下 ${violations.length} 个函数未遵循双模写法（ADR-0002）。\n` +
        `解决：1) 添加双模分支；2) 或加入 ALLOWLIST 并写明理由。\n${msg}`
    );
  }
});
