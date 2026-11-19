/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 用户资料弹窗（薄壳）。
 *
 * 三 Tab 内容、状态、取数、保存、改密、注销、配额均已在共享组件
 * `UserProfileContent` 中单一维护；本文件只负责 Modal 外框与宿主副作用注入：
 *   - onSaved：保存成功后 1.2s 关闭弹窗（/profile 页不传，行为不分叉）；
 *   - onClose：页眉 X / 页脚取消按钮的关闭动作。
 */
import React from 'react';
import { Modal } from './base/Modal';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { UserProfileContent } from '../profile/UserProfileContent';

export interface UserProfileModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const { user } = useAuth();
  const { userProfileModalOpen, closeUserProfileModal } = useModal();

  const isOpen = (propIsOpen ?? userProfileModalOpen) && Boolean(user);
  const onClose = propOnClose ?? closeUserProfileModal;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      showCloseButton={false}
      className="relative w-full max-w-2xl bg-white dark:bg-[#0f172a] border border-slate-200/90 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-slate-900 dark:text-slate-100 p-0"
    >
      <div id="user-profile-modal-container" className="flex flex-col w-full h-full min-h-0 overflow-hidden">
        {user && (
          <UserProfileContent
            onClose={onClose}
            onSaved={() => {
              // 必须用 context 实现：受控用法下 propOnClose 未必关闭 Modal。
              setTimeout(closeUserProfileModal, 1200);
            }}
          />
        )}
      </div>
    </Modal>
  );
};
