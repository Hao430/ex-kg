/**
 * db-guard 的错误分类（ADR-0019）
 *
 * 仓储的每个 catch 都会先把异常交给 `handlePgError`，由它决定「这是 PG 故障，还是应用层
 * 自己出的错」。分错类的代价不是文案不美，而是**排障方向被指反**：
 *
 * - 归类为 PG 故障 → 生产抛 503 `DB_UNAVAILABLE` 并点亮 `/api/db/status` 的 `degraded`，
 *   运维去查数据库、甚至重启进程；而真凶在应用层。
 * - 两个「应用层 bug」分支必须原样重抛，**且不得 notePgError**（那不是数据库不健康）。
 *
 * 这里用内存模式跑（不设 DATABASE_URL）：两个分支都在 `isProductionDbRequired()` 之前，
 * 所以判据与环境和连接无关——这正是本文件能进默认套件的原因。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handlePgError, pgDegraded } from '../server/core/db-guard.js';
import { AppError } from '../server/lib/errors.js';

/** 构造一个 PG 错误（RLS 拒绝的固定形态：SQLSTATE 42501 + 消息含策略字样） */
function rlsError(message = 'new row violates row-level security policy for table "canvases"') {
  return Object.assign(new Error(message), { code: '42501' });
}

describe('handlePgError：应用层 bug 不得被当成数据库故障', () => {
  test('缺作用域原样重抛（500 DB_SCOPE_MISSING），不改写成 503 DB_UNAVAILABLE', () => {
    const err = new AppError(500, 'DB_SCOPE_MISSING', '数据库访问缺少请求作用域');

    assert.throws(
      () => handlePgError(err),
      (e: any) => {
        assert.equal(e, err, '必须原样重抛同一个错误对象（它是应用层已经判好的语义）');
        assert.equal(e.code, 'DB_SCOPE_MISSING', '错误码不得被改写——它是排障的第一线索');
        assert.equal(e.status, 500);
        assert.notEqual(e.code, 'DB_UNAVAILABLE', '缺作用域不是数据库不可用');
        return true;
      }
    );

    assert.equal(
      pgDegraded(),
      false,
      '缺作用域不得点亮 degraded：数据库是健康的，不健康的是一次忘记包作用域的调用'
    );
  });

  test('RLS 拒绝（42501 + 策略字样）抛 500 RLS_VIOLATION，且不点亮 degraded', () => {
    assert.throws(
      () => handlePgError(rlsError()),
      (e: any) => {
        assert.equal(e.code, 'RLS_VIOLATION');
        assert.equal(e.status, 500);
        return true;
      }
    );
    assert.equal(pgDegraded(), false, '策略拒绝是常态语义（无权），不是故障信号');
  });

  test('同样是 42501 但消息不含策略字样 → 按 PG 故障处理（缺 GRANT 这类真故障不得被放过）', () => {
    // 这条是上一个用例的**反面**：SQLSTATE 相同，只有消息能把两者分开。
    // 判据若退化成「看码不看消息」，真正的权限配置故障就会被静默当成「越权尝试」。
    assert.doesNotThrow(() => handlePgError(Object.assign(new Error('permission denied for table canvases'), { code: '42501' })));
    assert.equal(pgDegraded(), true, '缺 GRANT 是真故障，应当被记为 PG 故障');
  });

  test('普通 PG 错误按故障处理（非生产：记录故障并放行降级）', () => {
    assert.doesNotThrow(() => handlePgError(Object.assign(new Error('connection terminated'), { code: '08006' })));
    assert.equal(pgDegraded(), true);
  });
});
