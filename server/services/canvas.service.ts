import {
  listCanvases,
  getCanvas,
  saveCanvas,
  deleteCanvas,
  updateCanvasMeta,
  searchNodes,
  getCanvasOwnerInfo,
  isSharedDefaultCanvas,
} from '../repositories/canvas.repository.js';
import type { CanvasMetaPatch } from '../repositories/canvas.repository.js';
import { NotFoundError } from '../lib/errors.js';
import { assertCanCreateBoard } from './quota.service.js';
import { findUserById } from '../repositories/user.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { recordEventLog } from '../repositories/event-log.repository.js';
import { runWithSystem } from '../core/db-context.js';
import type { CanvasRecord } from '../core/records.js';

/**
 * ADR-0018 的 legacy 共享默认板：`default-board` / `default-canvas` 在 SAVE_DEFAULT_BOARD_MODE
 * 未翻 private 期间对**全体登录用户**放行读写。这是唯一一条绕过严格属主制（ADR-0016）的路径，
 * 而 RLS 策略 `user_id = current_setting('app.user_id')` 无法表达「任何登录用户可读写这一行」。
 *
 * 因此放行**显式**留在组合层：判据命中时把这次仓储调用升级为 system 作用域（BYPASSRLS），
 * 并留下可审计的 reason。仓储自身永不升级（ADR-0019）——升级点必须能在 grep 里一眼数清。
 * 随技术债 #0084 翻 private 后本函数退化为直通，删除它即彻底关闭该旁路。
 */
function withLegacySharedBoard<T>(canvasId: string, fn: () => T): T {
  if (!isSharedDefaultCanvas(canvasId)) return fn();
  return runWithSystem('legacy shared default board（ADR-0018，随 #0084 下线）', fn);
}

export async function listUserCanvases(userId: string): Promise<CanvasRecord[]> {
  return listCanvases(userId);
}

export async function getCanvasOrFail(canvasId: string, userId: string): Promise<CanvasRecord> {
  const canvas = await withLegacySharedBoard(canvasId, () => getCanvas(canvasId, userId));
  if (!canvas) {
    throw new NotFoundError('画板不存在或无权访问 (IDOR Protected)');
  }
  return canvas;
}

export async function saveUserCanvas(
  data: Parameters<typeof saveCanvas>[0],
  userId: string,
  /** 仅服务配额闸门（admin 不受板数限制）；不再透传仓储做属主放行（ADR-0016） */
  isAdmin: boolean
): Promise<CanvasRecord> {
  // Spec B1（H1 修订）：严格属主制下「认领」语义消亡（唯一可写的他人画板是共享默认板，归属不再转移），
  // 配额退化为纯新建计数；更新自己的画板不受限。
  // 配额闸门以回调下沉到 saveCanvas：PG 分支复用事务内已查的 exists（新建才触发），
  // 省掉保存前对同一行的独立 owner 预查；软删画布在事务内先抛 404，不再误耗配额。
  // 统计链路（2026-09-09）：quotaGate 仅在事务内判定为新建（exists=false）时被调用，
  // 借此标记 created——admin 无配额限制也统一走旗标回调，保证创建事件全角色覆盖。
  let created = false;
  const quotaGate = isAdmin
    ? async (exists: boolean) => {
        if (!exists) created = true;
      }
    : async (exists: boolean) => {
        if (!exists) {
          created = true;
          const user = await findUserById(userId);
          if (user) await assertCanCreateBoard(user);
        }
      };
  const record = await withLegacySharedBoard(data.id, () => saveCanvas(data, userId, quotaGate));

  // 服务端画板创建事实源（前端 Umami board_create 有拦截丢失率，此处为准）。
  // 埋点绝不阻塞业务：fire-and-forget，仅保存成功后落一条（更新/冲突/404 均不记）。
  if (created) {
    void recordEventLog({
      category: 'canvas',
      event: 'canvas_create',
      entityType: 'canvas',
      entityId: record.id,
      userId,
    });
  }

  return record;
}

export async function deleteUserCanvas(canvasId: string, userId: string): Promise<boolean> {
  const success = await deleteCanvas(canvasId, userId);
  if (success) {
    await recordAuditLog({
      userId,
      action: 'canvas_delete',
      targetType: 'canvas',
      targetId: canvasId,
    });
  }
  return success;
}

/** Spec L1：画板库元数据更新（收藏/归档/标题），仅服务端校验后透传仓储 */
export async function updateUserCanvasMeta(
  canvasId: string,
  patch: CanvasMetaPatch,
  userId: string
): Promise<CanvasRecord> {
  return updateCanvasMeta(canvasId, patch, userId);
}

/**
 * auto-title 归因校验（ADR-0016）：已存在的画布必须属主本人（共享默认板除外）才能写入 AI 审计归因；
 * 画布尚未落库（首节点对话先于首次自动保存）→ 放行。
 */
export async function assertCanvasAttributableByUser(canvasId: string, userId: string): Promise<void> {
  const info = await withLegacySharedBoard(canvasId, () => getCanvasOwnerInfo(canvasId));
  if (info.exists && info.ownerId !== userId && !isSharedDefaultCanvas(canvasId)) {
    throw new NotFoundError('画板不存在或无权访问 (IDOR Protected)');
  }
}

/** 节点检索：userId 必填（严格属主制，ADR-0016 口径），canvasId 可选（省略 = 检索本人全部画板） */
export async function searchUserNodes(queryText: string, userId: string, canvasId?: string): Promise<any[]> {
  return searchNodes(queryText, userId, canvasId);
}
