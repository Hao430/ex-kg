/**
 * ADR-0019 决策三 — 请求级数据库作用域（技术债 #0014）
 *
 * `server/middleware/auth.ts:261` 直接把本文件当作那条注释的凭据：
 *
 *   「依赖 Express 4 的 next() 是**同步**进入下游（下游 async 函数在同一 ALS
 *     上下文里开始执行），由 tests/pg/db-scope.pg.test.ts 独立锁定。」
 *
 * 这条依赖是整个 RLS 方案的支点，而且它**坏起来是静默的**：
 * 上下文若没传到下游，`getDb()` 会抛 `DB_SCOPE_MISSING`（还好，响亮）；
 * 但 GUC 若注入了却没生效——例如 `set_config(..., is_local => true)` 被挪到事务外，
 * PostgreSQL 只发一条 warning 就忽略它——查询会以「无 app.user_id」执行，
 * 于是 RLS 返回零行，「用户数据凭空消失」，日志里干干净净。
 *
 * 因此本文件的判据统一是**直接读 `current_setting('app.user_id')`**，而不是数行数：
 * 行数只在受限角色下有判别力，GUC 的值在任何角色下都看得见。这一条同时钉死
 * 「ALS 传到了 db.ts」与「set_config 在事务内真的生效」——两者缺一即红。
 *
 * 运行方式：
 *   PG_SMOKE=1 PG_TEST_URL=postgres://arborize_app:... DATABASE_ADMIN_URL=... \
 *     npx tsx --test tests/pg/db-scope.pg.test.ts
 *
 * 只在「隔离是否真的生效」那一组上需要受限角色（`PG_TEST_URL` 指向 arborize_app），
 * 无作用域时带理由跳过——属主绕过 RLS，对它断言隔离是断言一件不成立的事。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

const PG_TEST_URL = process.env.PG_TEST_URL || '';
const OWNER_URL =
  process.env.DATABASE_ADMIN_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
process.env.DATABASE_URL = PG_TEST_URL || OWNER_URL;

const { initDbSchema } = await import('../../server/core/schema.js');
const { closePools } = await import('../../server/core/pool.js');
const { runWithUser, runWithSystem, currentScope } = await import('../../server/core/db-context.js');
const { getDb } = await import('../../server/core/db.js');
const { asyncHandler } = await import('../../server/lib/async-handler.js');

const ALICE = '00000000-0000-4000-8000-0000000000c1';
const BOB = '00000000-0000-4000-8000-0000000000c2';
const ALICE_BOARD = 'scope-alice-board';
const BOB_BOARD = 'scope-bob-board';

const ownerPool = new Pool({ connectionString: OWNER_URL });
/** 应用实际使用的角色（PG_TEST_URL / DATABASE_URL）——作用域判据只能问它，见 before() */
const appPool = new Pool({ connectionString: process.env.DATABASE_URL });

/** 读当前连接上 RLS 判据的那个 GUC —— 本文件的核心观测量 */
const GUC_SQL = "SELECT current_setting('app.user_id', true) AS uid";

let server: http.Server;
let base = '';
let rlsActive = false;
let appRole = '';
let skipReason = '';

/**
 * 与 `authMiddleware` 逐字同构的接线：中间件先按 token 跨租户查（system 作用域），
 * 再 `runWithUser(user.id, () => next())`，下游路由在**另一个函数**里执行查询。
 * 这一跳正是 ALS 必须穿过去的地方。
 */
function buildApp(): express.Express {
  const app = express();

  app.use(async (req, _res, next) => {
    const uid = req.get('x-test-user');
    if (!uid) {
      next();
      return;
    }
    // 与 authMiddleware 同构（不是嵌套，是**顺序**）：
    // 先 await 一次 system 作用域的查询（模拟按 token 跨租户查会话），
    // 查询结束后才进入用户作用域并 next()。await 之后的代码跑在「无作用域」的
    // 请求上下文里——正是这个顺序让 `runWithUser(user.id, () => next())` 成为
    // 下游唯一的作用域来源，ALS 必须靠它穿过去。
    await runWithSystem('db-scope 用例：按 token 查会话（同构 authMiddleware）', () =>
      getDb()!.query(GUC_SQL)
    );
    runWithUser(uid, () => next());
  });

  // 下游 handler：与中间件不在同一个栈帧里。
  // 一律经 asyncHandler —— **与生产路由同构**（Express 4 不捕获 async handler 的 rejection）。
  // 这不是形式主义：/noscope 正是一条必然 reject 的路由，不包它请求会一直挂着——
  // 2026-09-12 CI 实测挂了 300s 被 undici 判 HeadersTimeout，而不是响亮地 500。
  app.get('/scoped', asyncHandler(async (_req, res) => {
    const scope = currentScope();
    const guc = await getDb()!.query(GUC_SQL);
    const own = await getDb()!.query('SELECT id FROM canvases WHERE user_id = $1 ORDER BY id', [
      (guc.rows[0] as any).uid,
    ]);
    res.json({
      scopeKind: scope?.kind ?? null,
      guc: (guc.rows[0] as any).uid,
      ids: own.rows.map((r: any) => r.id),
    });
  }));

  // 刻意不建立作用域的路由：证明作用域**不会**从上一个请求泄漏过来
  app.get('/noscope', asyncHandler(async (_req, res) => {
    await getDb()!.query('SELECT count(*)::int AS n FROM canvases');
    res.json({ ok: true });
  }));

  // 单个请求内两种作用域都要走一遍，并记录**嵌套调用返回之后**的环境作用域
  app.get('/scopes', asyncHandler(async (_req, res) => {
    const asSystem = await runWithSystem('db-scope 用例：system 作用域不注入用户 GUC', () =>
      getDb()!.query(GUC_SQL)
    );
    const afterSystem = currentScope()?.kind ?? null;
    const asUser = await runWithUser(ALICE, () => getDb()!.query(GUC_SQL));
    const afterUser = currentScope()?.kind ?? null;
    res.json({
      systemGuc: (asSystem.rows[0] as any).uid,
      userGuc: (asUser.rows[0] as any).uid,
      afterSystem,
      afterUser,
    });
  }));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status || 500).json({ error: err?.message, code: err?.code ?? null });
  });

  return app;
}

describe('ADR-0019 请求级作用域（决策三）', () => {
  before(async () => {
    await initDbSchema();
    for (let i = 0; i < 60; i++) {
      const r = await ownerPool.query("SELECT to_regclass('public.canvases') IS NOT NULL AS ok");
      if (r.rows[0]?.ok) break;
      await new Promise((res) => setTimeout(res, 500));
    }

    // 作用域判据必须问**应用实际使用的那个角色**（DATABASE_URL / PG_TEST_URL），
    // 不是问夹具用的属主池：属主天然绕过 RLS，拿它判「受不受 RLS 约束」永远是否，
    // 双角色轮会因此误报「PG_TEST_URL 未生效」（2026-09-12 CI 实测）。
    const who = await appPool.query('SELECT current_user AS role');
    appRole = who.rows[0].role;
    const probe = await appPool.query("SELECT row_security_active('canvases') AS active");
    rlsActive = probe.rows[0].active === true;
    if (!rlsActive) {
      assert.equal(
        PG_TEST_URL,
        '',
        `PG_TEST_URL 已配置（当前角色 ${appRole}），但该角色不受 RLS 约束：` +
          '请确认它指向 arborize_app，且不是 canvases 的属主、也没有 BYPASSRLS。'
      );
      skipReason = `当前角色 ${appRole} 不受 RLS 约束：隔离断言不适用（GUC 断言仍然有效，已全跑）`;
    }

    await ownerPool.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES
         ($1, 'scope-alice@test.local', 'x', 'Scope Alice'),
         ($2, 'scope-bob@test.local', 'x', 'Scope Bob')
       ON CONFLICT (id) DO NOTHING`,
      [ALICE, BOB]
    );
    await ownerPool.query(
      `INSERT INTO canvases (id, user_id, title) VALUES ($1, $3, 'A'), ($2, $4, 'B')
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, deleted_at = NULL`,
      [ALICE_BOARD, BOB_BOARD, ALICE, BOB]
    );

    server = http.createServer(buildApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ownerPool.query('DELETE FROM canvases WHERE id = ANY($1)', [[ALICE_BOARD, BOB_BOARD]]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [[ALICE, BOB]]);
    await ownerPool.end();
    await appPool.end();
    await closePools();
  });

  // ---------- 组一：作用域机制（与角色无关，两种跑法都必须绿）----------

  t('无作用域：query() 抛 DB_SCOPE_MISSING 500（不是零行，也不是 503）', async () => {
    const db = getDb();
    assert.ok(db, '本用例要求 DATABASE_URL 已配置（PG 模式）');

    await assert.rejects(
      () => db!.query('SELECT 1'),
      (e: any) => {
        assert.equal(e?.code, 'DB_SCOPE_MISSING', `应抛 DB_SCOPE_MISSING，实际 ${e?.code} ${e?.message}`);
        assert.equal(e?.status, 500);
        // 与「PG 故障」区分开：混用会把排障方向指向数据库（见 db.ts 的 requirePool 注释）
        assert.notEqual(e?.code, 'DB_UNAVAILABLE');
        return true;
      }
    );

    // 连自己拥有的表也一样：缺作用域是**代码 bug**，与数据归属无关
    await assert.rejects(() => db!.query('SELECT count(*) FROM canvases'), /请求作用域/);
  });

  t('无作用域：withTransaction() 同样抛 DB_SCOPE_MISSING（不得绕过）', async () => {
    await assert.rejects(
      () => getDb()!.withTransaction(async () => 'x'),
      (e: any) => {
        assert.equal(e?.code, 'DB_SCOPE_MISSING');
        return true;
      }
    );
  });

  t('★ runWithUser：app.user_id 真的注入成功（注不进就是零行，静默）', async () => {
    const r = await runWithUser(ALICE, () => getDb()!.query(GUC_SQL));
    assert.equal(
      (r.rows[0] as any).uid,
      ALICE,
      'set_config 必须在事务内真的生效：取到 NULL/空串 = is_local 被挪出事务或没走 BEGIN'
    );

    const other = await runWithUser(BOB, () => getDb()!.query(GUC_SQL));
    assert.equal((other.rows[0] as any).uid, BOB, '作用域必须跟着调用方走');
  });

  t('runWithSystem：不注入用户 GUC（跨租户靠的是不设判据，不是伪造一个用户）', async () => {
    const r = await runWithSystem('db-scope 用例：system 作用域 GUC 为空', () => getDb()!.query(GUC_SQL));
    assert.ok(
      !(r.rows[0] as any).uid,
      `system 作用域下 app.user_id 必须为空，实际 ${JSON.stringify((r.rows[0] as any).uid)}——` +
        '若被填上某个 user_id，system 路径会以为自己在代表那个用户行事'
    );
  });

  t('withTransaction 在用户作用域内同样注入 app.user_id', async () => {
    const uid = await runWithUser(BOB, () =>
      getDb()!.withTransaction(async (client) => {
        const first = await client.query(GUC_SQL);
        // 同一事务内再取一次：必须一致（is_local 的语义就是「本事务内有效」）
        const again = await client.query(GUC_SQL);
        assert.deepEqual(first.rows, again.rows, '同一事务内的两次读取必须一致');
        return (first.rows[0] as any).uid;
      })
    );
    assert.equal(uid, BOB);
  });

  t('作用域不跨调用泄漏（runWithUser 返回后即失效）', async () => {
    await runWithUser(ALICE, () => getDb()!.query('SELECT 1'));
    assert.equal(currentScope(), undefined, 'runWithUser 返回后作用域必须消失');
    await assert.rejects(() => getDb()!.query('SELECT 1'), /请求作用域/);
  });

  t('★ ALS 穿过 Express next() 到达下游 handler（决策三的最大风险点）', async () => {
    const res = await fetch(`${base}/scoped`, { headers: { 'x-test-user': ALICE } });
    assert.equal(res.status, 200, '下游 handler 应能拿到作用域；500 说明 ALS 没穿过 next()');
    const body = (await res.json()) as any;
    assert.equal(body.scopeKind, 'user', '下游 handler 里 currentScope() 必须是 user 作用域');
    assert.equal(
      body.guc,
      ALICE,
      '下游 handler 执行的查询必须带上 app.user_id——ALS 穿了但 GUC 没注入，同样是零行静默失败'
    );

    // 换一个用户打同一个端点：作用域必须跟着请求走，不能粘在上一个
    const bob = await fetch(`${base}/scoped`, { headers: { 'x-test-user': BOB } });
    assert.equal(((await bob.json()) as any).guc, BOB, 'bob 的请求必须拿到 bob 的作用域');
  });

  t('★ 跨请求不串作用域：并发打不同用户，各自只看得见自己的 GUC', async () => {
    const users = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? ALICE : BOB));
    const results = await Promise.all(
      users.map(async (uid) => {
        const res = await fetch(`${base}/scoped`, { headers: { 'x-test-user': uid } });
        assert.equal(res.status, 200);
        return { uid, body: (await res.json()) as any };
      })
    );
    for (const { uid, body } of results) {
      assert.equal(
        body.guc,
        uid,
        `并发请求串了作用域：请求方 ${uid} 的查询却带着 ${body.guc}——` +
          'ALS 必须按请求隔离，连接池复用不得让上一个请求的 app.user_id 残留'
      );
    }
  });

  t('不带作用域的请求不会继承上一个请求的作用域（500 而非静默零行）', async () => {
    await fetch(`${base}/scoped`, { headers: { 'x-test-user': ALICE } }); // 先跑一个有作用域的
    const res = await fetch(`${base}/noscope`);
    assert.equal(res.status, 500, '无作用域路由必须响亮失败');
    assert.equal(((await res.json()) as any).code, 'DB_SCOPE_MISSING');
  });

  t('同一请求内两种作用域各自独立，嵌套返回后回到请求自己的作用域', async () => {
    const res = await fetch(`${base}/scopes`, { headers: { 'x-test-user': ALICE } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(!body.systemGuc, 'system 作用域下不得有用户 GUC');
    assert.equal(body.userGuc, ALICE, 'user 作用域下 GUC 应为该用户');
    // 这里断言 'user' 而非 null 是关键：中间件那句 `runWithUser(user.id, () => next())`
    // 把**整个下游请求处理**都包在自己的作用域里（ALS 穿过 next()），所以路由里
    // currentScope() 本来就应该还是 'user'。要钉的是**嵌套的 system 作用域没有留下来**——
    // 若 afterSystem 变成 'system'，跨租户（BYPASSRLS）身份就会泄漏给同一请求后续所有查询，
    // 而这条路径上没有任何别的东西会变红。
    assert.equal(body.afterSystem, 'user', '嵌套的 system 作用域返回后必须回到请求自己的作用域');
    assert.equal(body.afterUser, 'user', '嵌套的 user 作用域返回后同样回到外层请求作用域');
  });

  // ---------- 组二：隔离真的生效了吗（需要受限角色）----------

  t('受限角色下：user 作用域只看得见自己的行，system 看得见全量', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const mine = await runWithUser(ALICE, () =>
      getDb()!.query('SELECT id FROM canvases WHERE id = ANY($1)', [[ALICE_BOARD, BOB_BOARD]])
    );
    assert.deepEqual(mine.rows.map((r: any) => r.id), [ALICE_BOARD], 'alice 应只看得见自己的板');

    const all = await runWithSystem('db-scope 用例：system 可见全量', () =>
      getDb()!.query('SELECT id FROM canvases WHERE id = ANY($1) ORDER BY id', [[ALICE_BOARD, BOB_BOARD]])
    );
    assert.equal(all.rows.length, 2, 'system 作用域必须看得见两个租户的行');
  });

  t('受限角色下：并发请求的行结果也各自隔离（端到端，含 RLS）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const users = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? ALICE : BOB));
    const results = await Promise.all(
      users.map(async (uid) => {
        const res = await fetch(`${base}/scoped`, { headers: { 'x-test-user': uid } });
        return { uid, body: (await res.json()) as any };
      })
    );
    for (const { uid, body } of results) {
      assert.deepEqual(
        body.ids,
        [uid === ALICE ? ALICE_BOARD : BOB_BOARD],
        `${uid} 的端到端结果串租户了：${JSON.stringify(body.ids)}`
      );
    }
  });
});
