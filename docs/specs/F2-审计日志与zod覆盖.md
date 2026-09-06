# Spec F2+F3 — 审计日志全量写入 + zod 全入参覆盖

> 来源：`docs/里程碑与分期规划.md` F 组 F2/F3；验收「关键操作在 user_audit_logs 均有对应记录」「畸形 payload 返回 400」
> 状态：本轮实施

## 1. F2 — 审计日志

- `server/repositories/audit.repository.ts`：`recordAuditLog({ userId?, action, targetType?, targetId?, ip?, userAgent?, details? })`（双模：PG user_audit_logs + 内存 `inMemoryStore.auditLogs`）；`listAuditLogs({ page, limit, action?, userId? })` 分页查询
- 写入点（action 命名小写下划线）：
  | 动作 | action |
  | :--- | :--- |
  | 注册成功 | sign_up |
  | 登录成功/失败 | sign_in / sign_in_failed |
  | 登出 | sign_out |
  | 订阅开通（含 mock 支付） | subscribe |
  | 画布删除 | canvas_delete |
  | Admin 冻结/解冻 | user_freeze / user_unfreeze |
  | Admin 赠送/撤销 VIP | vip_grant |
  | Admin 保存模型配置 | model_config_update |
- 查询端点：`GET /api/admin/audit-logs?page=&limit=&action=&userId=`（requireAdmin）
- inMemoryStore 增加 `auditLogs: AuditLogRecord[]`（最新在前，上限 1000）

## 2. F3 — zod 全入参覆盖

- `POST /api/chat`：messages 数组结构 zod（role/content 字符串）+ 保留 validateInputLimits 长度规则
- `POST /api/canvases/:id/save`：body zod（id 可选、title 字符串、nodes/edges 数组、expectedUpdatedAt 可选 ISO 串）
- 既有端点（sign-up/sign-in/profile/feedback/subscribe/admin model-config 等）已有 zod，本轮确认无缺口

## 3. 测试先行（`tests/f2-f3-audit-zod.test.ts`）

1. 登录/登出/订阅后，admin 查 audit-logs 能看到对应 action 记录
2. 画布删除后有 canvas_delete 记录（含 targetId）
3. admin 冻结用户后有 user_freeze 记录
4. 非管理员查 audit-logs → 403
5. F3：chat messages 元素缺 content → 400；save body nodes 非数组 → 400；save title 非字符串 → 400

## 4. 验收标准

- [ ] 新测试全绿；既有 62 用例不回归；`tsc --noEmit` 通过
- [ ] 子代理审计通过后提交
