/**
 * Arch Test: RLS 覆盖面（ADR-0019）
 *
 * 技术债 #0014 的守护线。核心不变式：
 *
 *   「schema.ts 建的每一张表，都必须被显式归类」 = 开 RLS（三种谓词形态之一）∪ 豁免清单
 *
 * 为什么必须有这道测试：漏一张表**不会报任何错**——它只是安安静静地不受策略约束，
 * 也就是一条持续的跨租户读通道。这类缺陷没有任何运行时信号，只能靠静态穷举拦住。
 *
 * 判据取自 `server/core/schema.ts` 导出的清单（策略的唯一事实源），
 * 与建表语句文本交叉比对——两边都改才算过，单改一边必红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCHEMA_PATH = join(REPO_ROOT, 'server', 'core', 'schema.ts');

const {
  RLS_DIRECT_USER_TABLES,
  RLS_SELF_ID_TABLES,
  RLS_CANVAS_CHILD_TABLES,
  RLS_EXEMPT_TABLES,
} = await import(SCHEMA_PATH.replace(/\.ts$/, '.js'));

const schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');

/** schema.ts 里实际建的表 */
const createdTables = [...schemaSrc.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]);

const classified = [
  ...RLS_DIRECT_USER_TABLES,
  ...RLS_SELF_ID_TABLES,
  ...RLS_CANVAS_CHILD_TABLES,
  ...RLS_EXEMPT_TABLES,
];

test('schema.ts 导出的四份清单互不重叠（一张表只能有一种归属形态）', () => {
  const seen = new Set();
  for (const t of classified) {
    assert.ok(!seen.has(t), `表 ${t} 同时出现在多份清单里——谓词形态有歧义`);
    seen.add(t);
  }
});

test('每张建好的表都被归类：开 RLS 或显式豁免（新增表忘归类即失败）', () => {
  const unclassified = createdTables.filter((t) => !classified.includes(t));
  assert.deepEqual(
    unclassified,
    [],
    `以下表既未开 RLS 也未列入豁免清单，等于一条静默的跨租户读通道：${unclassified.join(', ')}\n` +
      '修法：加进 RLS_*_TABLES（开策略）或 RLS_EXEMPT_TABLES（豁免必须写明理由）。'
  );
});

test('归类清单里的表都真实存在（防改名后清单悬空）', () => {
  const stale = classified.filter((t) => !createdTables.includes(t));
  assert.deepEqual(
    stale,
    [],
    `以下表在清单里但 schema.ts 已不再建它——策略会打在空气上：${stale.join(', ')}`
  );
});

test('策略用 ENABLE 而非 FORCE ROW LEVEL SECURITY（FORCE 会让 canvas_probe 失效）', () => {
  assert.ok(
    /ENABLE ROW LEVEL SECURITY/.test(schemaSrc),
    'schema.ts 必须对租户表执行 ENABLE ROW LEVEL SECURITY'
  );
  // ADR-0019：canvas_probe 靠 SECURITY DEFINER 以属主身份执行绕过策略。
  // 一旦有人改成 FORCE，属主也受约束 → 探针静默返回 NULL → 跨租户保存退化为 404。
  assert.ok(
    !/FORCE ROW LEVEL SECURITY/i.test(schemaSrc),
    'schema.ts 不得出现 FORCE ROW LEVEL SECURITY：会让 canvas_probe 静默失效（ADR-0019）'
  );
});

test('canvas_probe 是 SECURITY DEFINER 且锁死 search_path（防 search_path 劫持）', () => {
  const fnMatch = schemaSrc.match(/CREATE OR REPLACE FUNCTION canvas_probe[\s\S]*?\$\$/);
  assert.ok(fnMatch, 'schema.ts 必须定义 canvas_probe');
  const fn = fnMatch[0];
  assert.ok(/SECURITY DEFINER/.test(fn), 'canvas_probe 必须是 SECURITY DEFINER（否则受 RLS 约束、看不见他人行）');
  assert.ok(/STABLE/.test(fn), 'canvas_probe 是只读函数，应声明 STABLE');
  assert.ok(
    /SET search_path\s*=\s*pg_catalog,\s*public/.test(fn),
    'canvas_probe 必须锁死 search_path（SECURITY DEFINER 的标准卫生要求）'
  );
  assert.ok(
    /p_id VARCHAR/.test(fn),
    'canvas_probe 参数必须是 VARCHAR 而非 TEXT：canvases.id 是 VARCHAR(64)，声明成 TEXT 会让列被隐式转换、索引失效'
  );
});

test('豁免清单每一项都有据可查（非空且不含租户业务表）', () => {
  assert.ok(RLS_EXEMPT_TABLES.length > 0, '豁免清单不应为空（含全局配置表与账号前表）');
  // 这三张是「一定不能豁免」的，防止有人图省事把它们塞进豁免清单
  for (const t of ['canvases', 'nodes', 'edges', 'sessions', 'users']) {
    assert.ok(!RLS_EXEMPT_TABLES.includes(t), `${t} 是核心租户表，绝不能豁免 RLS`);
  }
});
