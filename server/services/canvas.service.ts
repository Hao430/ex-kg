import {
  listCanvases,
  getCanvas,
  saveCanvas,
  deleteCanvas,
  searchNodes,
  getCanvasOwnerInfo,
  isClaimableCanvas,
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
  // Spec B1：新建或**认领**画板都计入画板数配额（认领会把归属转移给请求者，审计修复）；
  // 更新自己的画板不受限
  if (!isAdmin) {
    const info = await getCanvasOwnerInfo(data.id);
    const adopts =
      !info.exists ||
      (info.ownerId !== userId &&
        isClaimableCanvas(data.id, info.ownerId, userId, {
          includeBoardPrefix: true,
          includeNoOwner: true,
          includeRequesterGuest: true,
        }));
    if (!info.exists || adopts) {
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
