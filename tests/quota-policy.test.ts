import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuotaPolicy,
  BOARD_LIMIT,
  NODE_LIMIT,
  GRACE_PERIOD_DAYS,
} from '../server/policies/quota.policy.js';
import { ForbiddenError } from '../server/lib/errors.js';

describe('QuotaPolicy — calculateEntitlements (身份与权益裁决)', () => {
  test('系统管理员返回 admin 计划且无任何额度限制', () => {
    const ent = QuotaPolicy.calculateEntitlements({ role: 'admin', vip_expires_at: null });
    assert.equal(ent.plan, 'admin');
    assert.equal(ent.vipExpired, false);
    assert.equal(ent.boardLimit, null);
    assert.equal(ent.nodeLimit, null);
    assert.equal(ent.vipGraceDaysRemaining, undefined);
  });

  test('普通用户返回体验版计划与默认限制', () => {
    const ent = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.equal(ent.plan, 'trial');
    assert.equal(ent.vipExpired, false);
    assert.equal(ent.boardLimit, BOARD_LIMIT);
    assert.equal(ent.nodeLimit, NODE_LIMIT);
  });

  test('VIP 用户未设置过期时间视为永久有效', () => {
    const ent = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: null });
    assert.equal(ent.plan, 'vip');
    assert.equal(ent.vipExpired, false);
    assert.equal(ent.boardLimit, null);
    assert.equal(ent.nodeLimit, null);
  });

  test('VIP 用户在有效期内正常放行', () => {
    const now = 1700000000000;
    const futureDate = new Date(now + 86400000 * 10).toISOString();
    const ent = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: futureDate }, now);
    assert.equal(ent.plan, 'vip');
    assert.equal(ent.vipExpired, false);
    assert.equal(ent.boardLimit, null);
    assert.equal(ent.nodeLimit, null);
  });

  test('VIP 用户在 7 天宽限期内放行且携带剩余天数提醒', () => {
    const now = 1700000000000;
    // 过期 3 天，宽限期 7 天，剩余 4 天
    const pastDate = new Date(now - 86400000 * 3).toISOString();
    const ent = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: pastDate }, now);
    assert.equal(ent.plan, 'vip');
    assert.equal(ent.vipExpired, true);
    assert.equal(ent.vipGraceDaysRemaining, 4);
    assert.equal(ent.boardLimit, null);
    assert.equal(ent.nodeLimit, null);
  });

  test('VIP 用户超出 7 天宽限期硬锁定（降级体验版且 vipExpired=true）', () => {
    const now = 1700000000000;
    // 过期 8 天
    const pastDate = new Date(now - 86400000 * 8).toISOString();
    const ent = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: pastDate }, now);
    assert.equal(ent.plan, 'trial');
    assert.equal(ent.vipExpired, true);
    assert.equal(ent.boardLimit, BOARD_LIMIT);
    assert.equal(ent.nodeLimit, NODE_LIMIT);
  });

  test('非法日期字符串以 fail-closed 原则处理为已过期', () => {
    const ent = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: 'invalid-date' });
    assert.equal(ent.plan, 'trial');
    assert.equal(ent.vipExpired, true);
  });
});

describe('QuotaPolicy — assertCanCreateBoard (画板创建配额校验)', () => {
  test('Admin 与有效 VIP 不受画板数限制', () => {
    const adminEnt = QuotaPolicy.calculateEntitlements({ role: 'admin', vip_expires_at: null });
    const vipEnt = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: null });

    assert.doesNotThrow(() => QuotaPolicy.assertCanCreateBoard(adminEnt, 999));
    assert.doesNotThrow(() => QuotaPolicy.assertCanCreateBoard(vipEnt, 999));
  });

  test('宽限期内 VIP 仍可创建画板', () => {
    const now = 1700000000000;
    const graceVip = QuotaPolicy.calculateEntitlements(
      { role: 'vip', vip_expires_at: new Date(now - 86400000 * 2).toISOString() },
      now
    );
    assert.doesNotThrow(() => QuotaPolicy.assertCanCreateBoard(graceVip, 10));
  });

  test('超期 VIP 抛出 403 VIP_EXPIRED', () => {
    const now = 1700000000000;
    const expiredVip = QuotaPolicy.calculateEntitlements(
      { role: 'vip', vip_expires_at: new Date(now - 86400000 * 10).toISOString() },
      now
    );
    assert.throws(
      () => QuotaPolicy.assertCanCreateBoard(expiredVip, 0),
      (err: any) => err instanceof ForbiddenError && err.code === 'VIP_EXPIRED'
    );
  });

  test('体验版画板未满 3 个放行，满 3 个抛出 403 BOARD_LIMIT_REACHED', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.doesNotThrow(() => QuotaPolicy.assertCanCreateBoard(trialEnt, 2));

    assert.throws(
      () => QuotaPolicy.assertCanCreateBoard(trialEnt, 3),
      (err: any) => err instanceof ForbiddenError && err.code === 'BOARD_LIMIT_REACHED'
    );
    assert.throws(
      () => QuotaPolicy.assertCanCreateBoard(trialEnt, 5),
      (err: any) => err instanceof ForbiddenError && err.code === 'BOARD_LIMIT_REACHED'
    );
  });
});

describe('QuotaPolicy — assertCanInfer (节点推理配额校验)', () => {
  test('Admin 与有效 VIP 不受节点数限制', () => {
    const adminEnt = QuotaPolicy.calculateEntitlements({ role: 'admin', vip_expires_at: null });
    assert.doesNotThrow(() => QuotaPolicy.assertCanInfer(adminEnt, 999));
  });

  test('无画布上下文的自由提问（currentNodeCount 为 null/undefined）直接放行', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.doesNotThrow(() => QuotaPolicy.assertCanInfer(trialEnt, null));
    assert.doesNotThrow(() => QuotaPolicy.assertCanInfer(trialEnt, undefined));
  });

  test('超期 VIP 抛出 403 VIP_EXPIRED', () => {
    const now = 1700000000000;
    const expiredVip = QuotaPolicy.calculateEntitlements(
      { role: 'vip', vip_expires_at: new Date(now - 86400000 * 10).toISOString() },
      now
    );
    assert.throws(
      () => QuotaPolicy.assertCanInfer(expiredVip, 0),
      (err: any) => err instanceof ForbiddenError && err.code === 'VIP_EXPIRED'
    );
  });

  test('体验版节点数未满 10 个放行，满 10 个抛出 403 NODE_LIMIT_REACHED', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.doesNotThrow(() => QuotaPolicy.assertCanInfer(trialEnt, 9));

    assert.throws(
      () => QuotaPolicy.assertCanInfer(trialEnt, 10),
      (err: any) => err instanceof ForbiddenError && err.code === 'NODE_LIMIT_REACHED'
    );
    assert.throws(
      () => QuotaPolicy.assertCanInfer(trialEnt, 15),
      (err: any) => err instanceof ForbiddenError && err.code === 'NODE_LIMIT_REACHED'
    );
  });
});

describe('QuotaPolicy — assertCanUseModel (模型白名单校验)', () => {
  const whitelist = ['gemini-2.5-pro', 'gpt-4o'];

  test('体验版请求专享模型抛出 403 MODEL_VIP_ONLY，大小写不敏感', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.throws(
      () => QuotaPolicy.assertCanUseModel(trialEnt, 'gemini-2.5-pro', whitelist),
      (err: any) => err instanceof ForbiddenError && err.code === 'MODEL_VIP_ONLY'
    );
    assert.throws(
      () => QuotaPolicy.assertCanUseModel(trialEnt, 'GPT-4O', whitelist),
      (err: any) => err instanceof ForbiddenError && err.code === 'MODEL_VIP_ONLY'
    );
  });

  test('体验版请求普通模型放行', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.doesNotThrow(() => QuotaPolicy.assertCanUseModel(trialEnt, 'gemini-2.5-flash', whitelist));
  });

  test('Admin 与 VIP 请求专享模型放行', () => {
    const adminEnt = QuotaPolicy.calculateEntitlements({ role: 'admin', vip_expires_at: null });
    const vipEnt = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: null });

    assert.doesNotThrow(() => QuotaPolicy.assertCanUseModel(adminEnt, 'gemini-2.5-pro', whitelist));
    assert.doesNotThrow(() => QuotaPolicy.assertCanUseModel(vipEnt, 'gemini-2.5-pro', whitelist));
  });

  test('白名单为空列表时不拦截任何模型', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    assert.doesNotThrow(() => QuotaPolicy.assertCanUseModel(trialEnt, 'gemini-2.5-pro', []));
    assert.doesNotThrow(() => QuotaPolicy.assertCanUseModel(trialEnt, 'gemini-2.5-pro', undefined));
  });
});

describe('QuotaPolicy — assertCanInferWithEmail (邮箱验证准入校验)', () => {
  test('普通用户已验证邮箱放行', () => {
    assert.doesNotThrow(() =>
      QuotaPolicy.assertCanInferWithEmail({ role: 'user', email_verified: true })
    );
  });

  test('普通用户未验证邮箱拦截抛出 403 EMAIL_NOT_VERIFIED', () => {
    assert.throws(
      () => QuotaPolicy.assertCanInferWithEmail({ role: 'user', email_verified: false }),
      (err: any) => err instanceof ForbiddenError && err.code === 'EMAIL_NOT_VERIFIED'
    );
  });

  test('VIP 用户未验证邮箱同样拦截', () => {
    assert.throws(
      () => QuotaPolicy.assertCanInferWithEmail({ role: 'vip', email_verified: false }),
      (err: any) => err instanceof ForbiddenError && err.code === 'EMAIL_NOT_VERIFIED'
    );
  });

  test('Admin 豁免邮箱验证', () => {
    assert.doesNotThrow(() =>
      QuotaPolicy.assertCanInferWithEmail({ role: 'admin', email_verified: false })
    );
  });
});

describe('QuotaPolicy — calculateQuotaUsage (配额余量计算)', () => {
  test('体验版返回具体的已用、上限与剩余额度', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    const usage = QuotaPolicy.calculateQuotaUsage(trialEnt, 2, 7);

    assert.deepEqual(usage.board, { used: 2, limit: 3 });
    assert.deepEqual(usage.node, { used: 7, limit: 10, remaining: 3 });
  });

  test('节点用超（12 个）时 remaining 保底为 0 不出现负数', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    const usage = QuotaPolicy.calculateQuotaUsage(trialEnt, 3, 12);
    assert.deepEqual(usage.node, { used: 12, limit: 10, remaining: 0 });
  });

  test('未传 canvasId 时 node 返回 null', () => {
    const trialEnt = QuotaPolicy.calculateEntitlements({ role: 'user', vip_expires_at: null });
    const usage = QuotaPolicy.calculateQuotaUsage(trialEnt, 1, null);
    assert.equal(usage.node, null);
  });

  test('Admin 和 VIP 的 limit 与 remaining 均为 null', () => {
    const vipEnt = QuotaPolicy.calculateEntitlements({ role: 'vip', vip_expires_at: null });
    const usage = QuotaPolicy.calculateQuotaUsage(vipEnt, 5, 20);

    assert.deepEqual(usage.board, { used: 5, limit: null });
    assert.deepEqual(usage.node, { used: 20, limit: null, remaining: null });
  });
});
