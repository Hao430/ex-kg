import {
  listCanvases,
  getCanvas,
  saveCanvas,
  deleteCanvas,
  searchNodes,
  getCanvasOwnerInfo,
} from '../repositories/canvas.repository.js';
import { NotFoundError } from '../lib/errors.js';
import { assertCanCreateBoard } from './quota.service.js';
import { findUserById } from '../repositories/user.repository.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
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
  // 配额退化为纯新建计数；更新自己的画板不受限
  if (!isAdmin) {
    const info = await getCanvasOwnerInfo(data.id);
    if (!info.exists) {
      const user = await findUserById(userId);
      if (user) await assertCanCreateBoard(user);
    }
  }
  return saveCanvas(data, userId, isAdmin);
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
