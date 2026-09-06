/**
 * Spec F5 — scrypt 参数提升（向后兼容 + 透明升级标记）
 * Spec F6 — 日志留存清理（memory 模式）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, needsRehash } from '../server/lib/crypto.js';
import { recordAiRequestLog, cleanupOldAiLogs, getAiRequestLogsForTest } from '../server/repositories/ai.repository.js';
import { recordAuditLog, cleanupOldAuditLogs, getAuditLogsForTest } from '../server/repositories/audit.repository.js';

/** 旧版默认参数哈希（重构前格式：salt:hex，N=16384/r=8/p=1） */
function makeLegacyHash(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

describe('F5 scrypt 参数提升', () => {
  test('hashPassword 输出带版本头且往返验证成功', async () => {
    const hash = await hashPassword('MyPass123!');
    assert.match(hash, /^scrypt\$65536\$8\$1\$[a-f0-9]{32}:[a-f0-9]+$/);
    assert.equal(await verifyPassword('MyPass123!', hash), true);
    assert.equal(await verifyPassword('WrongPass', hash), false);
  });

  test('旧默认参数哈希仍可验证（向后兼容）', async () => {
    const legacy = await makeLegacyHash('LegacyPass1');
    assert.match(legacy, /^[a-f0-9]{32}:[a-f0-9]+$/); // 无版本头
    assert.equal(await verifyPassword('LegacyPass1', legacy), true);
    assert.equal(await verifyPassword('wrong', legacy), false);
  });

  test('needsRehash：新格式 false、旧格式 true', async () => {
    const fresh = await hashPassword('Whatever1');
    const legacy = await makeLegacyHash('Whatever1');
    assert.equal(needsRehash(fresh), false);
    assert.equal(needsRehash(legacy), true);
  });

  test('hashPassword 耗时 ≥100ms（64MB scrypt 下界）', async () => {
    const start = Date.now();
    await hashPassword('TimingCheck1');
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 100, `scrypt N=2^16 应耗时 ≥100ms，实际 ${elapsed}ms`);
  });
});

describe('F6 日志留存清理（memory 模式）', () => {
  test('cleanupOldAiLogs(0) 清空全部，retention 90 保留', async () => {
    for (let i = 0; i < 3; i++) {
      await recordAiRequestLog({
        modelName: 'gemini-3.8-flash', totalTokens: 10, latencyMs: 5, status: 'success',
      });
    }
    assert.ok(getAiRequestLogsForTest().length >= 3);

    await cleanupOldAiLogs(90);
    const kept = getAiRequestLogsForTest().length;
    assert.equal(kept, 3, 'retention 90 天不应删除新日志');

    await cleanupOldAiLogs(0);
    console.log('DEBUG ai:', JSON.stringify(getAiRequestLogsForTest().map((l) => l.created_at)));
    assert.equal(getAiRequestLogsForTest().length, 0, 'retention 0 应清空');
  });

  test('cleanupOldAuditLogs 同理', async () => {
    await recordAuditLog({ action: 'test_action', userId: 'u-x' });
    await recordAuditLog({ action: 'test_action', userId: 'u-x' });
    assert.ok(getAuditLogsForTest().filter((l) => l.action === 'test_action').length >= 2);

    await cleanupOldAuditLogs(180);
    assert.ok(getAuditLogsForTest().filter((l) => l.action === 'test_action').length >= 2);

    await cleanupOldAuditLogs(0);
    console.log('DEBUG audit:', JSON.stringify(getAuditLogsForTest().map((l) => l.created_at)));
    assert.equal(getAuditLogsForTest().filter((l) => l.action === 'test_action').length, 0);
  });
});
