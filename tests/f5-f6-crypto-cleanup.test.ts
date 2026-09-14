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

  /**
   * 2026-09-14 重写：原断言是墙钟下界 `elapsed >= 100`，度量的是**机器速度而不是被测行为**——
   * CI 快 runner 上实测 87ms 即变红（run 34815112227），而它卡在默认套件里，
   * 等于随机拦住所有人的合并，与被测代码的正确性无关。
   *
   * 本用例真正要守的信号是「工作因子确实提升到 N=2^16 / 64MB」，而这个事实**由哈希头如实编码**
   * （且 verify 用的正是头里的参数）。把 N 调小会让头一起变、上一行的精确匹配同时失败——
   * 不需要靠计时。故改为确定性断言，去掉全部墙钟依赖。
   */
  test('工作因子由哈希头如实编码（N=2^16 / r=8 / p=1，推导内存 ≥64MB）', async () => {
    const hash = await hashPassword('TimingCheck1');
    const [N, r, p] = hash.split('$').slice(1, 4).map(Number);

    assert.equal(N, 2 ** 16, `N 应为 2^16，实际 ${N}`);
    assert.equal(r, 8, `r 应为 8，实际 ${r}`);
    assert.equal(p, 1, `p 应为 1，实际 ${p}`);

    // scrypt 推导内存 ≈ 128 * N * r 字节；N=2^16/r=8 即约 64MB（maxmem 128MB 留余量）
    const derivedMb = (128 * N * r) / 1024 / 1024;
    assert.ok(derivedMb >= 64, `scrypt 推导内存应 ≥64MB，实际 ${derivedMb}MB`);
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
