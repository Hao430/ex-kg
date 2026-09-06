# Spec F5+F6 — scrypt 参数提升 + 审计/推演日志留存清理

> 来源：`docs/里程碑与分期规划.md` F 组 F5/F6；F5 验收「scrypt 单次校验耗时 ≥200ms」；F6 验收「有自动清理任务，不会无限增长」
> 状态：本轮实施

## 1. F5 — scrypt 参数提升（N=2^16 / r=8 / p=1 ≈ 64MB / ~200ms+）

- `server/lib/crypto.ts`：
  - `hashPassword`：参数化派生 `crypto.scrypt(password, salt, 64, { N: 2**16, r: 8, p: 1, maxmem: 128MB })`，输出**带版本头**格式：`scrypt$65536$8$1$<salt>:<key>`
  - `verifyPassword`：解析版本头——带 `scrypt$` 前缀按参数派生；**无前缀按旧默认参数（N=16384）派生**（存量哈希向后兼容）
  - `needsRehash(storedHash)`：无版本头 → true（供登录时透明升级）
- 透明升级：`auth.service.signIn` 验证成功且 `needsRehash` → `updateUserPassword(userId, 新哈希)`（F1 已有该函数，顺带清 reset_token 无害）
- 种子账号 / 新注册 / F1 重置自然使用新参数

## 2. F6 — 日志留存与清理

- `ai.repository` 新增 `cleanupOldAiLogs(retentionDays)`：PG `DELETE ... WHERE created_at < NOW() - make_interval(days => $1)`；内存 `inMemoryStore.aiRequestLogs` 按 created_at 过滤；返回删除条数
- 环境变量 `AI_LOG_RETENTION_DAYS`（默认 90，待定项 #3 定值）
- `server/jobs/log-cleanup.ts`：`startLogCleanupJob()`——启动时执行一次 + 每 24h 执行；异常仅告警；server.ts 调用
- user_audit_logs 同样接清理（`cleanupOldAuditLogs(retentionDays)`，默认 180 天）共用 job

## 3. 测试先行（`tests/f5-f6-crypto-cleanup.test.ts`）

1. hashPassword 输出带 `scrypt$65536$8$1$` 版本头且 verifyPassword 往返成功
2. 旧默认参数哈希（手工构造 N=16384）verifyPassword 仍通过（向后兼容）
3. needsRehash：新格式 false、旧格式 true
4. hashPassword 耗时 ≥100ms（64MB scrypt 的宽松下界）
5. F6：memory 模式插入 3 条 ai 日志 → `cleanupOldAiLogs(0)` 全清；retention 90 → 保留
6. F6：audit 日志同理

## 4. 验收标准

- [ ] 新测试全绿；既有 81 用例不回归；`tsc --noEmit` 通过
- [ ] 里程碑 F5/F6 更新、待定项 #3 定值（90 天）
- [ ] 子代理审计通过后提交
