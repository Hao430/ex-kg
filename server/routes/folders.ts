import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listUserFolders,
  createUserFolder,
  renameUserFolder,
  deleteUserFolder,
} from '../services/folder.service.js';
import { asyncHandler } from '../lib/async-handler.js';
import { authMiddleware, folderActionRateLimiter } from '../middleware/auth.js';
import { validate } from '../lib/validate.js';

export const foldersRouter = Router();

const FolderName = z.string().min(1, '分组名不能为空').max(64, '分组名过长');
const CreateFolderSchema = z.object({
  id: z.string().min(1).max(64),
  name: FolderName,
});
const RenameFolderSchema = z.object({ name: FolderName });

// 分组是个人资产：全部端点要求登录，且只操作本人分组
foldersRouter.use(authMiddleware);

/** GET /api/folders — 当前用户分组列表 */
foldersRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const folders = await listUserFolders(req.user!.id);
  res.json({ folders });
}));

/** POST /api/folders — 新建分组（id 由客户端 UUIDv7 生成，便于离线乐观创建） */
foldersRouter.post('/', folderActionRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const body = validate(CreateFolderSchema, req.body);
  const folder = await createUserFolder(body.id, body.name, req.user!.id);
  res.status(201).json({ success: true, folder });
}));

/** PATCH /api/folders/:id — 改名（严格属主） */
foldersRouter.patch('/:id', folderActionRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const body = validate(RenameFolderSchema, req.body);
  const folder = await renameUserFolder(req.params.id, body.name, req.user!.id);
  res.json({ success: true, folder });
}));

/** DELETE /api/folders/:id — 删除分组（画板解除归属，不删画板） */
foldersRouter.delete('/:id', folderActionRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const success = await deleteUserFolder(req.params.id, req.user!.id);
  res.json({ success });
}));
