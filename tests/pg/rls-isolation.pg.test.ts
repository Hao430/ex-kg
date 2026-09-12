/**
 * ADR-0019 — 行级安全（RLS）**真库**验证（技术债 #0014）
 *
 * 为什么必须有这一份：`arch-tests/rls-coverage.test.mjs` 只能证明 **schema.ts 里写了策略**，
 * 证明不了策略在真库上**真的拦得住**。策略写错（谓词写反、漏了 WITH CHECK、被 FORCE 掉、
 * 忘了 ENABLE）在静态检查下全是绿的，只有以受限角色在真库上查一次才露馅。
 *
 * 运行方式（CI 的第二遍 PG 冒烟就是这套环境）：
 *   PG_SMOKE=1 \
 *   PG_TEST_URL=postgres://arborize_app:...      \
 *   DATABASE_SYSTEM_URL=postgres://arborize_system:... \
 *   DATABASE_ADMIN_URL=postgres://<owner>:...    \
 *   npx tsx --test tests/pg/rls-isolation.pg.test.ts
 *
 * **两种角色下都要绿**：
 * - 「策略装到位了没有」这组断言在任何角色下都跑（它查 pg_class / pg_proc，与角色无关）；
 * - 「隔离真的生效了吗」这组只在 `PG_TEST_URL` 指向受 RLS 约束的角色时有判别力——
 *   属主绕过 ENABLE 级 RLS，对它断言隔离等于断言一件不成立的事，故**带理由跳过**；
 *   但若 `PG_TEST_URL` 已显式配置却不受 RLS 约束，则判定为接线错误，**报错而不是跳过**
 *   （否则 CI 少传一个变量，这道唯一能证明 RLS 生效的检查就无声消失了）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

const RUN = process.env.PG_SMOKE === '1';
const t = RUN ? test : test.skip;

const PG_TEST_URL = process.env.PG_TEST_URL || '';
/** 属主连接串：本地/CI 首轮用默认值，双角色轮用 CI 注入的 DATABASE_ADMIN_URL */
const OWNER_URL =
  process.env.DATABASE_ADMIN_URL || 'postgres://postgres:postgres@127.0.0.1:5433/arborize_test';
const SYSTEM_URL = process.env.DATABASE_SYSTEM_URL || '';

// 必须在动态 import 之前赋值：pg-smoke 同款约定，静态 import 会被提升到赋值之前
process.env.DATABASE_URL = PG_TEST_URL || OWNER_URL;

const { initDbSchema, RLS_DIRECT_USER_TABLES, RLS_SELF_ID_TABLES, RLS_CANVAS_CHILD_TABLES, RLS_EXEMPT_TABLES } =
  await import('../../server/core/schema.js');
const { closePools } = await import('../../server/core/pool.js');
const { runWithUser, runWithSystem } = await import('../../server/core/db-context.js');
const { getCanvas, saveCanvas, isSharedDefaultCanvas } = await import(
  '../../server/repositories/canvas.repository.js'
);

const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b1';
const ALICE_BOARD = 'rls-alice-board';
const BOB_BOARD = 'rls-bob-board';
const ALICE_NODE = 'rls-alice-node';
const BOB_NODE = 'rls-bob-node';
/** 共享默认板 id（ADR-0018，随 #0084 翻 private 后与升级点一并下线） */
const SHARED_BOARD = 'default-board';

const appPool = new Pool({ connectionString: process.env.DATABASE_URL });
const ownerPool = new Pool({ connectionString: OWNER_URL });
const systemPool = SYSTEM_URL ? new Pool({ connectionString: SYSTEM_URL }) : null;

let rlsActive = false;
let appRole = '';
let skipReason = '';

/** 以指定 user_id 作用域执行一条查询（`app.user_id` 是 RLS 策略的唯一判据） */
async function scoped<T extends pg.QueryResultRow>(
  userId: string | null,
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  const client = await appPool.connect();
  try {
    await client.query("SELECT set_config('app.user_id', $1, false)", [userId ?? '']);
    return await client.query<T>(sql, params);
  } finally {
    // 归还连接前务必清掉作用域：池是复用的，残留的 app.user_id 会让下一个用例
    // 「恰好」读到上一个租户的数据——那正是本文件要证明不可能发生的事
    await client.query("SELECT set_config('app.user_id', '', false)").catch(() => {});
    client.release();
  }
}

/** 断言一个查询被 RLS 以 42501 拒绝（WITH CHECK 失败） */
async function assertRlsRejected(fn: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    assert.equal(err.code, '42501', `${what} 应以 SQLSTATE 42501 被拒，实际：${err.code} ${err.message}`);
    assert.match(
      err.message || '',
      /row-level security policy/i,
      `${what} 的报错应含 'row-level security policy'（db-guard 靠它把 RLS 拒绝与 PG 故障区分开）`
    );
    return;
  }
  assert.fail(`${what} 竟然成功了——WITH CHECK 没有生效`);
}

async function waitForTables(tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = await ownerPool.query("SELECT to_regclass('public.canvases') IS NOT NULL AS ok");
    if (r.rows[0]?.ok) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('canvases 表始终未建出来——PG 是否就绪？');
}

describe('ADR-0019 RLS 真库验证（#0014）', () => {
  before(async () => {
    // 与本目录其他文件同款约定：迁移幂等，谁先跑到谁建表（ADR-0019 决策二）
    await initDbSchema();
    await waitForTables();

    const who = await appPool.query('SELECT current_user AS role');
    appRole = who.rows[0].role;
    const active = await appPool.query("SELECT row_security_active('canvases') AS active");
    rlsActive = active.rows[0].active === true;

    if (!rlsActive) {
      assert.equal(
        PG_TEST_URL,
        '',
        `PG_TEST_URL 已配置（当前角色 ${appRole}），但该角色不受 RLS 约束：\n` +
          '双角色跑法的全部意义就是这个角色受限。请确认 PG_TEST_URL 指向 arborize_app、' +
          '且它**不是** canvases 的属主、也没有 BYPASSRLS。'
      );
      skipReason = `当前角色 ${appRole} 不受 RLS 约束（属主/BYPASSRLS）：无 PG_TEST_URL，隔离断言不适用`;
    }

    // 夹具以属主身份写入（属主天然绕过 ENABLE 级 RLS，无需再借道 system 角色）
    await ownerPool.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES
         ($1, 'rls-alice@test.local', 'x', 'RLS Alice'),
         ($2, 'rls-bob@test.local', 'x', 'RLS Bob')
       ON CONFLICT (id) DO NOTHING`,
      [ALICE, BOB]
    );
    await ownerPool.query(
      `INSERT INTO canvases (id, user_id, title) VALUES
         ($1, $3, 'Alice 的板'), ($2, $4, 'Bob 的板')
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, deleted_at = NULL`,
      [ALICE_BOARD, BOB_BOARD, ALICE, BOB]
    );
    await ownerPool.query(
      `INSERT INTO nodes (id, canvas_id, type) VALUES ($1, $3, 'chat'), ($2, $4, 'chat')
       ON CONFLICT (id) DO NOTHING`,
      [ALICE_NODE, BOB_NODE, ALICE_BOARD, BOB_BOARD]
    );
  });

  after(async () => {
    await ownerPool.query('DELETE FROM nodes WHERE id = ANY($1)', [[ALICE_NODE, BOB_NODE]]);
    await ownerPool.query('DELETE FROM canvases WHERE id = ANY($1)', [[ALICE_BOARD, BOB_BOARD]]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [[ALICE, BOB]]);
    await Promise.all([appPool.end(), ownerPool.end(), systemPool?.end()]);
    await closePools();
  });

  // ---------- 组一：策略是否真的装到位（与角色无关，两种跑法都必须绿）----------

  t('schema 层：每张归类为「开 RLS」的表都真的启用了行级安全', async () => {
    const expected = [...RLS_DIRECT_USER_TABLES, ...RLS_SELF_ID_TABLES, ...RLS_CANVAS_CHILD_TABLES];
    const res = await ownerPool.query(
      'SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)',
      [expected]
    );
    const got = new Map(res.rows.map((r) => [r.relname, r]));

    const missingTable = expected.filter((table) => !got.has(table));
    assert.deepEqual(missingTable, [], `以下表在清单里但库里不存在：${missingTable.join(', ')}`);

    const notEnabled = expected.filter((table) => got.get(table)!.relrowsecurity !== true);
    assert.deepEqual(
      notEnabled,
      [],
      `以下表没有启用行级安全——迁移漏跑，或 ALTER TABLE 被删掉了：${notEnabled.join(', ')}`
    );
  });

  t('schema 层：没有任何表被 FORCE（FORCE 会让 canvas_probe 静默失效）', async () => {
    const res = await ownerPool.query(
      'SELECT relname FROM pg_class WHERE relforcerowsecurity = true AND relkind = $1',
      ['r']
    );
    assert.deepEqual(
      res.rows.map((r) => r.relname),
      [],
      'FORCE ROW LEVEL SECURITY 会让属主也受策略约束 → canvas_probe（SECURITY DEFINER）看不见他人行 →\n' +
        '跨租户保存的 403 退化成 404。ADR-0019 明确不用 FORCE。'
    );
  });

  t('schema 层：豁免表不得被开 RLS（开了就是 app 角色零行读取）', async () => {
    const res = await ownerPool.query(
      'SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity = true',
      [[...RLS_EXEMPT_TABLES]]
    );
    assert.deepEqual(
      res.rows.map((r) => r.relname),
      [],
      '以下豁免表被启用了 RLS 却没有策略：app 角色将读到 0 行（表现为「数据凭空消失」）'
    );
  });

  t('schema 层：canvas_probe 是 SECURITY DEFINER + STABLE，且未对 PUBLIC 开放', async () => {
    const fn = await ownerPool.query(
      `SELECT prosecdef, provolatile, proconfig,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
              ) AS public_can_execute
       FROM pg_proc WHERE proname = 'canvas_probe'`
    );
    assert.equal(fn.rows.length, 1, '库里必须有 canvas_probe 函数');
    const f = fn.rows[0];
    assert.equal(f.prosecdef, true, 'canvas_probe 必须 SECURITY DEFINER（否则受 RLS 约束、看不见他人行）');
    assert.equal(f.provolatile, 's', 'canvas_probe 应声明 STABLE（只读函数）');
    assert.ok(
      (f.proconfig || []).some((c: string) => /search_path=pg_catalog,\s*public/.test(c)),
      `canvas_probe 必须锁死 search_path（当前 proconfig=${JSON.stringify(f.proconfig)}）`
    );
    assert.equal(
      f.public_can_execute,
      false,
      'canvas_probe 不得对 PUBLIC 开放 EXECUTE：默认权限必须先收回再按需授予'
    );
  });

  // ---------- 组二：隔离是否真的生效（只在受 RLS 约束的角色下有判别力）----------

  t('无作用域时读到 0 行（fail-closed，而不是报错、更不是全量）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    // 反空洞：属主看得到夹具，证明「0 行」是真的被拦住了，不是表里本来就没数据
    const asOwner = await ownerPool.query('SELECT count(*)::int AS n FROM canvases WHERE id = ANY($1)', [
      [ALICE_BOARD, BOB_BOARD],
    ]);
    assert.equal(asOwner.rows[0].n, 2, '夹具应在库里（属主可见）');

    // 全新连接、从未设置 app.user_id
    const fresh = await appPool.connect();
    try {
      const r = await fresh.query('SELECT count(*)::int AS n FROM canvases');
      assert.equal(r.rows[0].n, 0, '未设置作用域时必须读到 0 行——策略谓词在 NULL 下不匹配任何行');
    } finally {
      fresh.release();
    }
  });

  t('作用域 = 某人时只看得见自己的行（跨租户读被拦成零行）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const mine = await scoped(ALICE, 'SELECT id FROM canvases WHERE id = ANY($1)', [[ALICE_BOARD, BOB_BOARD]]);
    assert.deepEqual(
      mine.rows.map((r) => r.id),
      [ALICE_BOARD],
      'alice 应只看得见自己的板'
    );

    const foreign = await scoped(ALICE, 'SELECT * FROM canvases WHERE id = $1', [BOB_BOARD]);
    assert.equal(foreign.rows.length, 0, 'alice 直查 bob 的板必须返回零行（不是报错，也不是数据）');
  });

  t('子表按画板归属间接过滤（nodes 没有 user_id 列）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const own = await scoped(ALICE, 'SELECT id FROM nodes WHERE canvas_id = $1', [ALICE_BOARD]);
    assert.deepEqual(own.rows.map((r) => r.id), [ALICE_NODE], 'alice 应看得见自己板里的节点');

    const foreign = await scoped(ALICE, 'SELECT id FROM nodes WHERE canvas_id = $1', [BOB_BOARD]);
    assert.equal(foreign.rows.length, 0, 'alice 不得看见 bob 板里的节点');
  });

  t('写：INSERT 他人的 user_id 被 WITH CHECK 拒绝；写自己的照常', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    // 正对照：不是「一律拒绝」，而是「只许写自己」
    const ok = await scoped(ALICE, 'INSERT INTO canvases (id, user_id, title) VALUES ($1, $2, $3)', [
      'rls-alice-new',
      ALICE,
      'alice 新板',
    ]);
    assert.equal(ok.rowCount, 1, 'alice 新建自己的板应当成功');
    await ownerPool.query('DELETE FROM canvases WHERE id = $1', ['rls-alice-new']);

    await assertRlsRejected(
      () => scoped(ALICE, 'INSERT INTO canvases (id, user_id, title) VALUES ($1, $2, $3)', ['rls-forged', BOB, '伪造']),
      'alice 以 bob 的 user_id 插入画板'
    );

    await assertRlsRejected(
      () => scoped(ALICE, 'INSERT INTO nodes (id, canvas_id, type) VALUES ($1, $2, $3)', ['rls-x', BOB_BOARD, 'chat']),
      'alice 往 bob 的板里插节点'
    );
  });

  t('写：UPDATE 他人的行影响 0 行（静默不生效，且不得报成功）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const own = await scoped(ALICE, 'UPDATE canvases SET title = $1 WHERE id = $2', ['alice 改自己', ALICE_BOARD]);
    assert.equal(own.rowCount, 1, 'alice 改自己的板应当成功（否则下面的 0 行没有意义）');

    const foreign = await scoped(ALICE, 'UPDATE canvases SET title = $1 WHERE id = $2', ['被篡改', BOB_BOARD]);
    assert.equal(foreign.rowCount, 0, 'alice 改 bob 的板必须影响 0 行');

    const check = await ownerPool.query('SELECT title FROM canvases WHERE id = $1', [BOB_BOARD]);
    assert.equal(check.rows[0].title, 'Bob 的板', 'bob 的板必须原封不动');
  });

  t('canvas_probe：app 角色能问到他人归属（这正是探针存在的唯一理由）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    const probed = await scoped(ALICE, 'SELECT user_id FROM canvas_probe($1)', [BOB_BOARD]);
    assert.equal(probed.rows.length, 1, 'canvas_probe 必须看得见他人的行（否则 403 会退化成 404）');
    assert.equal(probed.rows[0].user_id, BOB, 'canvas_probe 应返回真实属主');

    const mine = await scoped(ALICE, 'SELECT user_id FROM canvas_probe($1)', [ALICE_BOARD]);
    assert.equal(mine.rows[0].user_id, ALICE);

    const missing = await scoped(ALICE, 'SELECT user_id FROM canvas_probe($1)', ['rls-does-not-exist']);
    assert.equal(missing.rows.length, 0, '不存在的 id 应返回零行（saveCanvas 靠它区分「新建」）');
  });

  t('system 角色（BYPASSRLS）可见全量（跨租户路径的前提）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    assert.ok(systemPool, 'DATABASE_SYSTEM_URL 未配置——双角色跑法必须提供 system 连接串');

    const res = await systemPool!.query('SELECT count(*)::int AS n FROM canvases WHERE id = ANY($1)', [
      [ALICE_BOARD, BOB_BOARD],
    ]);
    assert.equal(res.rows[0].n, 2, 'system 角色应看得见全部租户的行（会话查询/匿名分享/日清依赖这一点）');
  });

  t('组合层升级：legacy 共享默认板在 system 作用下可读写，普通作用域下读不到', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    if (!isSharedDefaultCanvas(SHARED_BOARD)) {
      return ctx.skip('SAVE_DEFAULT_BOARD_MODE=private：共享默认板已下线（#0084），本用例应随升级点一并删除');
    }

    // bob 写共享默认板：这正是 canvas.service 的 withLegacySharedBoard 做的事
    await runWithSystem('rls 用例：legacy 共享默认板写入（ADR-0018）', () =>
      saveCanvas({ id: SHARED_BOARD, title: '共享默认板', nodes: [], edges: [] }, BOB)
    );

    // 普通用户作用域下直读 → RLS 拦成「不存在」——证明升级点是**必需**的，不是装饰
    const unprivileged = await runWithUser(ALICE, () => getCanvas(SHARED_BOARD, ALICE));
    assert.equal(unprivileged, null, 'app 作用域下 alice 不应读到他人名下的共享默认板（RLS 生效的证据）');

    // 升级到 system 作用域 → 读得到（组合层放行，ADR-0018）
    const privileged = await runWithSystem('rls 用例：legacy 共享默认板读取（ADR-0018）', () =>
      getCanvas(SHARED_BOARD, ALICE)
    );
    assert.ok(privileged, 'system 作用域下应读到共享默认板——否则 withLegacySharedBoard 失效，全体用户丢板');
  });

  t('仓储端到端：本人板可保存可读取，他人板读写分别 403/404（契约不变）', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);

    // 本人：保存 + 读回
    const saved = await runWithUser(ALICE, () =>
      saveCanvas({ id: ALICE_BOARD, title: 'Alice 改过', nodes: [], edges: [] }, ALICE)
    );
    assert.equal(saved.id, ALICE_BOARD);
    const read = await runWithUser(ALICE, () => getCanvas(ALICE_BOARD, ALICE));
    assert.ok(read, 'alice 应能读回自己的板');

    // 他人：读 404（RLS 拦成零行 → 契约上的 404，不能是 500）
    const foreignRead = await runWithUser(BOB, () => getCanvas(ALICE_BOARD, BOB));
    assert.equal(foreignRead, null, 'bob 读 alice 的板必须是「不存在」，不能报错（更不能是 500）');

    // 他人：写 403 —— 靠 canvas_probe 才判定得出「存在但不是你的」
    await assert.rejects(
      () => runWithUser(BOB, () => saveCanvas({ id: ALICE_BOARD, title: '偷改', nodes: [], edges: [] }, BOB)),
      (e: any) => {
        assert.equal(e?.code, 'CANVAS_FORBIDDEN', `bob 写 alice 的板应 403 CANVAS_FORBIDDEN，实际 ${e?.code} ${e?.message}`);
        assert.equal(e?.status, 403);
        return true;
      }
    );
  });
});
