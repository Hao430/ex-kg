import {
  listCanvases,
  getCanvas,
  saveCanvas,
  deleteCanvas,
  searchNodes,
} from '../repositories/canvas.repository.js';
import { NotFoundError } from '../lib/errors.js';
import { assertCanCreateBoard } from './quota.service.js';
import { findUserById } from '../repositories/user.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { recordEventLog } from '../repositories/event-log.repository.js';
import type { CanvasRecord } from '../core/records.js';

export async function listUserCanvases(userId: string | undefined, isAdmin: boolean): Promise<CanvasRecord[]> {
  return listCanvases(userId, isAdmin);
}

export async function getCanvasOrFail(canvasId: string, userId: string | undefined, isAdmin: boolean): Promise<CanvasRecord> {
  const canvas = await getCanvas(canvasId, userId, isAdmin);
  if (!canvas) {
    throw new NotFoundError('画板不存在或无权访问 (IDOR Protected)');
  }
  return canvas;
}

export async function saveUserCanvas(
  data: Parameters<typeof saveCanvas>[0],
  userId: string,
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
  const record = await saveCanvas(data, userId, isAdmin, quotaGate);

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

export async function deleteUserCanvas(canvasId: string, userId: string, isAdmin: boolean): Promise<boolean> {
  const success = await deleteCanvas(canvasId, userId, isAdmin);
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

export async function searchUserNodes(queryText: string, canvasId?: string, userId?: string): Promise<any[]> {
  return searchNodes(queryText, canvasId, userId);
}
