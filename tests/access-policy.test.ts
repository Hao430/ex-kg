import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AccessPolicy } from '../server/policies/access.policy.js';
import { ForbiddenError, NotFoundError } from '../server/lib/errors.js';

describe('AccessPolicy — assertUserActive (账号可用性与冻结拦截)', () => {
  test('活跃账号正常放行', () => {
    assert.doesNotThrow(() => AccessPolicy.assertUserActive({ is_active: true }));
  });

  test('已冻结账号拦截并抛出 403 ACCOUNT_FROZEN', () => {
    assert.throws(
      () => AccessPolicy.assertUserActive({ is_active: false }),
      (err: any) => err instanceof ForbiddenError && err.code === 'ACCOUNT_FROZEN'
    );
  });
});

describe('AccessPolicy — assertAdmin (管理员角色鉴权)', () => {
  test('系统管理员正常放行', () => {
    assert.doesNotThrow(() => AccessPolicy.assertAdmin({ role: 'admin' }));
  });

  test('普通用户拦截并抛出 403 FORBIDDEN_ADMIN_ONLY', () => {
    assert.throws(
      () => AccessPolicy.assertAdmin({ role: 'user' }),
      (err: any) => err instanceof ForbiddenError && err.code === 'FORBIDDEN_ADMIN_ONLY'
    );
  });

  test('VIP 用户同样拦截并抛出 403 FORBIDDEN_ADMIN_ONLY', () => {
    assert.throws(
      () => AccessPolicy.assertAdmin({ role: 'vip' }),
      (err: any) => err instanceof ForbiddenError && err.code === 'FORBIDDEN_ADMIN_ONLY'
    );
  });

  test('未登录 / 空用户拦截并抛出 403 FORBIDDEN_ADMIN_ONLY', () => {
    assert.throws(
      () => AccessPolicy.assertAdmin(undefined),
      (err: any) => err instanceof ForbiddenError && err.code === 'FORBIDDEN_ADMIN_ONLY'
    );
  });
});

describe('AccessPolicy — assertCanvasAttributable (画布归因与 IDOR 防护)', () => {
  const userId = 'user-123';
  const otherUserId = 'user-456';

  test('尚未落库的画板（exists=false，如首节点先于首次保存）放行', () => {
    assert.doesNotThrow(() =>
      AccessPolicy.assertCanvasAttributable(userId, { exists: false, ownerId: null })
    );
  });

  test('用户本人的画板正常放行', () => {
    assert.doesNotThrow(() =>
      AccessPolicy.assertCanvasAttributable(userId, { exists: true, ownerId: userId })
    );
  });

  test('他人的画板拦截并抛出 NotFoundError（IDOR Protected，404 不泄露存在性）', () => {
    assert.throws(
      () => AccessPolicy.assertCanvasAttributable(userId, { exists: true, ownerId: otherUserId }),
      (err: any) => err instanceof NotFoundError && err.code === 'NOT_FOUND'
    );
  });

  test('legacy 共享默认画板（isSharedDefault=true）即使非本人也豁免放行', () => {
    assert.doesNotThrow(() =>
      AccessPolicy.assertCanvasAttributable(
        userId,
        { exists: true, ownerId: otherUserId },
        true
      )
    );
  });
});

describe('AccessPolicy — assertCanShareCanvas & assertCanManageShare (画布分享权限)', () => {
  const userId = 'user-123';
  const otherUserId = 'user-456';

  test('属主本人允许创建分享', () => {
    assert.doesNotThrow(() => AccessPolicy.assertCanShareCanvas(userId, userId));
  });

  test('非属主创建分享抛出 403 CANVAS_FORBIDDEN', () => {
    assert.throws(
      () => AccessPolicy.assertCanShareCanvas(userId, otherUserId),
      (err: any) =>
        err instanceof ForbiddenError &&
        err.code === 'CANVAS_FORBIDDEN' &&
        err.message === '只能分享自己的画板'
    );
  });

  test('属主本人允许管理（撤销）分享', () => {
    assert.doesNotThrow(() => AccessPolicy.assertCanManageShare(userId, userId));
  });

  test('非属主管理分享抛出 403 CANVAS_FORBIDDEN', () => {
    assert.throws(
      () => AccessPolicy.assertCanManageShare(userId, otherUserId),
      (err: any) =>
        err instanceof ForbiddenError &&
        err.code === 'CANVAS_FORBIDDEN' &&
        err.message === '只能管理自己的画板分享'
    );
  });
});

describe('AccessPolicy — assertFolderOwnership (画板分组归属校验)', () => {
  const userId = 'user-123';
  const otherUserId = 'user-456';

  test('属主本人修改或删除分组正常放行', () => {
    assert.doesNotThrow(() => AccessPolicy.assertFolderOwnership(userId, userId, 'modify'));
    assert.doesNotThrow(() => AccessPolicy.assertFolderOwnership(userId, userId, 'delete'));
  });

  test('修改他人分组抛出 403 FOLDER_FORBIDDEN 且文案对齐', () => {
    assert.throws(
      () => AccessPolicy.assertFolderOwnership(userId, otherUserId, 'modify'),
      (err: any) =>
        err instanceof ForbiddenError &&
        err.code === 'FOLDER_FORBIDDEN' &&
        err.message === '无权修改其他用户的分组'
    );
  });

  test('删除他人分组抛出 403 FOLDER_FORBIDDEN 且文案对齐', () => {
    assert.throws(
      () => AccessPolicy.assertFolderOwnership(userId, otherUserId, 'delete'),
      (err: any) =>
        err instanceof ForbiddenError &&
        err.code === 'FOLDER_FORBIDDEN' &&
        err.message === '无权删除其他用户的分组'
    );
  });
});

describe('AccessPolicy — assertOrderOwnership (订单归属校验)', () => {
  const userId = 'user-123';
  const otherUserId = 'user-456';

  test('操作自己的订单正常放行', () => {
    assert.doesNotThrow(() => AccessPolicy.assertOrderOwnership(userId, userId));
  });

  test('操作他人订单抛出 ForbiddenError', () => {
    assert.throws(
      () => AccessPolicy.assertOrderOwnership(userId, otherUserId),
      (err: any) => err instanceof ForbiddenError && err.message === '无权操作此订单'
    );
  });
});
