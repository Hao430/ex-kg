import {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
} from '../repositories/folder.repository.js';
import type { FolderRecord } from '../core/records.js';

/** Spec L1：单层分组服务层（分组为个人偏好，仅属主可管理，无 admin 放行） */

export async function listUserFolders(userId: string): Promise<FolderRecord[]> {
  return listFolders(userId);
}

export async function createUserFolder(id: string, name: string, userId: string): Promise<FolderRecord> {
  return createFolder(id, name, userId);
}

export async function renameUserFolder(id: string, name: string, userId: string): Promise<FolderRecord> {
  return renameFolder(id, name, userId);
}

export async function deleteUserFolder(id: string, userId: string): Promise<boolean> {
  return deleteFolder(id, userId);
}
