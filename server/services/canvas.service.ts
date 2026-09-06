import {
  listCanvases,
  getCanvas,
  saveCanvas,
  deleteCanvas,
  searchNodes,
} from '../repositories/canvas.repository.js';
import { NotFoundError } from '../lib/errors.js';
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
  return saveCanvas(data, userId, isAdmin);
}

export async function deleteUserCanvas(canvasId: string, userId: string, isAdmin: boolean): Promise<boolean> {
  return deleteCanvas(canvasId, userId, isAdmin);
}

export async function searchUserNodes(queryText: string, canvasId?: string, userId?: string): Promise<any[]> {
  return searchNodes(queryText, canvasId, userId);
}
