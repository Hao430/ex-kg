/**
 * Arch Test: 同源守卫与会话 cookie 的**接线**纪律（技术债 #0013，ADR-0020）
 *
 * `tests/csrf-same-origin.test.ts` 与 `tests/cookie-attributes.test.ts` 已经锁住了
 * **行为**（跨站 Origin → 403、cookie 带 HttpOnly+SameSite=Lax）。但行为测试有个
 * 共同的盲区：它们都显式构造请求去打 `createApp()`，所以**接线**错了它们照样全绿——
 *
 *   - 守卫挂在路由**之后** → 打进来的请求早已被路由处理完，守卫成了摆设；
 *   - 守卫挂在 body parser **之前** → 解析失败先于来源校验，报错语义颠倒；
 *   - 新增一个路由挂在守卫**之上** → 这条新路径完全不受保护，且没有任何东西变红。
 *
 * 同样地，cookie 属性若在别处被复制粘贴一份，`session-cookie.ts` 的单一事实源就失守了，
 * 而 `tests/cookie-attributes.test.ts` 只会去测登录那条路径、看不见副本。
 *
 * 所以这份文件补的是**结构与挂载顺序**，与那两份行为测试互为经纬。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const APP = join(REPO_ROOT, 'server', 'app.ts');
const SAME_ORIGIN = join(REPO_ROOT, 'server', 'middleware', 'same-origin.ts');
const SESSION_COOKIE = join(REPO_ROOT, 'server', 'lib', 'session-cookie.ts');

const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(REPO_ROOT, p);
const appSrc = read(APP);

/** 唯一允许挂载 urlencoded 解析的路径（全仓唯一消费方，ADR-0014） */
const URLENCODED_MOUNT_PATHS = new Set(['/api/subscriptions/notify']);

/**
 * 行号（0 基）→ 挂载位置。用 `app.use(` / `app.<method>(` 后紧跟引号路径来识别。
 * 排除 `express.xxx(...)` 这类 **parser** 挂载：它们是解析器不是路由，
 * 按 ADR-0020 就是要排在守卫之前。
 */
function mountLines() {
  const mounts = [];
  appSrc.split('\n').forEach((line, i) => {
    const m = line.match(/app\.(use|get|post|put|patch|delete)\(\s*'([^']+)'/);
    if (!m) return;
    const [, method, path] = m;
    const handlerExpr = line.slice(line.indexOf(`'${path}'`) + path.length + 2).trim();
    const isParser = /^,\s*express\./.test(handlerExpr);
    if (isParser) return;
    mounts.push({ line: i, method, path });
  });
  return mounts;
}

const guardLine = appSrc.split('\n').findIndex((l) => /app\.use\(\s*sameOriginGuard\s*\)/.test(l));

test('守卫被全局挂载（不是逐路由挂）——新增路由不可能绕开它', () => {
  assert.notEqual(
    guardLine,
    -1,
    'app.ts 必须有一行 `app.use(sameOriginGuard)`：逐路由挂载会让新路由默认不受保护'
  );
});

test('守卫挂在全部 /api 路由之前（挂在之后 = 摆设）', () => {
  const offenders = mountLines().filter((m) => m.path.startsWith('/api') && m.line < guardLine);
  assert.deepEqual(
    offenders,
    [],
    `以下挂载排在 sameOriginGuard 之前，完全不受同源校验保护：\n` +
      offenders.map((m) => `  app.${m.method}('${m.path}')  @server/app.ts:${m.line + 1}`).join('\n') +
      `\n（第 ${guardLine + 1} 行才是守卫；新增路由必须挂在它下面）`
  );
});

test('守卫挂在 body parser 之后（解析失败与来源拒绝的语义不能颠倒）', () => {
  const parsers = [];
  appSrc.split('\n').forEach((line, i) => {
    if (/app\.use\([^)]*express\.(json|urlencoded)\(/.test(line)) parsers.push(i);
  });
  assert.ok(parsers.length > 0, 'app.ts 应当挂载 express.json / express.urlencoded');
  for (const p of parsers) {
    assert.ok(p < guardLine, `body parser（server/app.ts:${p + 1}）必须排在 sameOriginGuard 之前（ADR-0020）`);
  }
});

test('urlencoded 解析按路径收窄（全局挂载 = 给所有端点开表单编码面）', () => {
  const offenders = [];
  const mounted = [];
  appSrc.split('\n').forEach((line, i) => {
    if (!/express\.urlencoded\(/.test(line)) return;
    const m = line.match(/app\.use\(\s*'([^']+)'\s*,\s*express\.urlencoded\(/);
    if (!m) {
      offenders.push(`server/app.ts:${i + 1} 未按路径挂载：${line.trim()}`);
      return;
    }
    mounted.push(m[1]);
    if (!URLENCODED_MOUNT_PATHS.has(m[1])) {
      offenders.push(`server/app.ts:${i + 1} 挂到了未登记的路径 ${m[1]}`);
    }
  });
  assert.deepEqual(
    offenders,
    [],
    `urlencoded 只允许挂给支付宝异步通知（ADR-0014）。新增表单端点必须在此登记并说明理由——\n` +
      `JSON 端点靠「表单发不出 application/json」天然免于 CSRF，放开表单编码面就把这层免除了：\n${offenders.join('\n')}`
  );
  assert.deepEqual(
    mounted,
    [...URLENCODED_MOUNT_PATHS],
    `已挂载的 urlencoded 路径与登记清单不符（登记：${[...URLENCODED_MOUNT_PATHS].join(', ')}）`
  );
});

test('CSRF_ORIGIN_REJECTED 只有一处来源（防第二份来源校验悄悄漂移）', () => {
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
      if (!/CSRF_ORIGIN_REJECTED/.test(read(full))) continue;
      if (rel(full) !== 'server/middleware/same-origin.ts') offenders.push(rel(full));
    }
  };
  walk(join(REPO_ROOT, 'server'));
  assert.deepEqual(
    offenders,
    [],
    `来源校验必须只有 same-origin.ts 一个出处：两份判据会各自漂移，\n` +
      `最终没人说得清哪份是真的（行为测试只覆盖其中一条路径）：\n${offenders.join('\n')}`
  );
});

test('Sec-Fetch-Site 判据排在「无 Origin 放行」之前（最强的信号不能被绕过）', () => {
  const src = read(SAME_ORIGIN);
  const secFetch = src.indexOf('sec-fetch-site');
  const noOrigin = src.search(/if\s*\(\s*!origin\s*\)/);
  assert.notEqual(secFetch, -1, 'same-origin.ts 必须检查 Sec-Fetch-Site');
  assert.notEqual(noOrigin, -1, 'same-origin.ts 必须有「无 Origin 放行」分支');
  assert.ok(
    secFetch < noOrigin,
    'Sec-Fetch-Site: cross-site 的判定必须在「无 Origin 一律放行」之前——\n' +
      '倒过来写，一个不带 Origin 的跨站请求就会从放行分支溜走（浏览器给的这份信号正是最强的那个）'
  );
});

test('守卫只作用于变更方法（GET/HEAD/OPTIONS 不得被拦）', () => {
  const src = read(SAME_ORIGIN);
  const m = src.match(/MUTATING_METHODS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'same-origin.ts 必须显式声明 MUTATING_METHODS');
  const methods = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  assert.deepEqual(
    methods.slice().sort(),
    ['DELETE', 'PATCH', 'POST', 'PUT'],
    '变更方法集合必须恰为 POST/PUT/PATCH/DELETE——多一个会把只读请求拦成 403，少一个就是一条漏网通道'
  );
});

test('会话 cookie 只有 session-cookie.ts 一个出处（属性副本 = 单一事实源失守）', () => {
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
      if (path === 'server/lib/session-cookie.ts') continue;
      const src = read(full);
      // 不绑定接收者名字：`res2.cookie(...)` / `reply.clearCookie(...)` 一样是绕过单一事实源的写法
      for (const pat of [/\.\s*(?:clear)?[Cc]ookie\s*\(/, /['"]Set-Cookie['"]/]) {
        if (pat.test(src)) offenders.push(`${path}: ${pat}`);
      }
    }
  };
  walk(join(REPO_ROOT, 'server'));
  assert.deepEqual(
    offenders,
    [],
    `cookie 属性必须是单一事实源：散开后谁改一处都不影响另一处，\n` +
      `而属性测试只测得到它执行的那条路径（技术债 #0013 的成因就是这个）：\n${offenders.join('\n')}`
  );
});

test('session-cookie.ts 的关键属性是硬编码的不变量（不得由外部传入）', () => {
  const src = read(SESSION_COOKIE);
  assert.ok(/httpOnly:\s*true/.test(src), 'HttpOnly 必须恒为 true');
  assert.ok(/sameSite:\s*'lax'/.test(src), "SameSite 必须恒为 'lax'");
  assert.ok(
    !/domain\s*:/.test(src),
    '不得设置 Domain：host-only cookie 不向父域泄漏（设了就等于把会话暴露给同一父域下的其他站点）'
  );
  assert.ok(
    /secure:\s*process\.env\.NODE_ENV\s*===\s*'production'/.test(src),
    'Secure 只能在生产开启：本地/CI 走 http，恒 Secure 会让 cookie 根本发不出去'
  );
  assert.ok(
    /export function setSessionCookie[\s\S]*?export function clearSessionCookie[\s\S]*?sessionCookieOptions\(\)/.test(src),
    'clearSessionCookie 必须复用同一份 options：属性与下发时不一致会让响应头失去同款保护'
  );
});
