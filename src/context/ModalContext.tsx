/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

export interface ModalContextValue {
  // Auth Modal
  authModalOpen: boolean;
  authModalMode: 'signin' | 'signup';
  openAuthModal: (mode?: 'signin' | 'signup') => void;
  closeAuthModal: () => void;
  // User Profile Modal
  userProfileModalOpen: boolean;
  openUserProfileModal: () => void;
  closeUserProfileModal: () => void;
  // Feedback Modal
  feedbackModalOpen: boolean;
  openFeedbackModal: () => void;
  closeFeedbackModal: () => void;
  // Recharge Modal
  rechargeModalOpen: boolean;
  rechargeCanvasId?: string;
  upgradeModalReason?: string;
  openRechargeModal: (canvasIdOrReason?: string, reasonOrCanvasId?: string) => void;
  closeRechargeModal: () => void;
  // Admin Modal
  adminModalOpen: boolean;
  openAdminModal: () => void;
  closeAdminModal: () => void;
  // My Shares Modal
  mySharesModalOpen: boolean;
  openMySharesModal: () => void;
  closeMySharesModal: () => void;
}

export const defaultModalContextValue: ModalContextValue = {
  authModalOpen: false,
  authModalMode: 'signin',
  openAuthModal: () => {},
  closeAuthModal: () => {},
  userProfileModalOpen: false,
  openUserProfileModal: () => {},
  closeUserProfileModal: () => {},
  feedbackModalOpen: false,
  openFeedbackModal: () => {},
  closeFeedbackModal: () => {},
  rechargeModalOpen: false,
  rechargeCanvasId: undefined,
  upgradeModalReason: undefined,
  openRechargeModal: () => {},
  closeRechargeModal: () => {},
  adminModalOpen: false,
  openAdminModal: () => {},
  closeAdminModal: () => {},
  mySharesModalOpen: false,
  openMySharesModal: () => {},
  closeMySharesModal: () => {},
};

export const ModalContext = createContext<ModalContextValue>(defaultModalContextValue);

export const ModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup'>('signin');
  const [userProfileModalOpen, setUserProfileModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [rechargeModalOpen, setRechargeModalOpen] = useState(false);
  const [rechargeCanvasId, setRechargeCanvasId] = useState<string | undefined>(undefined);
  const [upgradeModalReason, setUpgradeModalReason] = useState<string | undefined>(undefined);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [mySharesModalOpen, setMySharesModalOpen] = useState(false);

  const openAuthModal = useCallback((mode: 'signin' | 'signup' = 'signin') => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
  }, []);

  const openUserProfileModal = useCallback(() => {
    setUserProfileModalOpen(true);
  }, []);

  const closeUserProfileModal = useCallback(() => {
    setUserProfileModalOpen(false);
  }, []);

  const openFeedbackModal = useCallback(() => {
    setFeedbackModalOpen(true);
  }, []);

  const closeFeedbackModal = useCallback(() => {
    setFeedbackModalOpen(false);
  }, []);

  const openRechargeModal = useCallback((param1?: string, param2?: string) => {
    let canvasId: string | undefined;
    let reason: string | undefined;

    if (param1 && param2) {
      const isParam1Reason = /[\u4e00-\u9fa5\s]/.test(param1) || param1.length > 36;
      if (isParam1Reason) {
        reason = param1;
        canvasId = param2;
      } else {
        canvasId = param1;
        reason = param2;
      }
    } else if (param1) {
      const isReason = /[\u4e00-\u9fa5\s]/.test(param1) || param1.length > 40;
      if (isReason) {
        reason = param1;
      } else {
        canvasId = param1;
      }
    }

    setRechargeCanvasId(canvasId);
    setUpgradeModalReason(reason);
    setRechargeModalOpen(true);
  }, []);

  const closeRechargeModal = useCallback(() => {
    setRechargeModalOpen(false);
    setRechargeCanvasId(undefined);
    setUpgradeModalReason(undefined);
  }, []);

  const openAdminModal = useCallback(() => {
    setAdminModalOpen(true);
  }, []);

  const closeAdminModal = useCallback(() => {
    setAdminModalOpen(false);
  }, []);

  const openMySharesModal = useCallback(() => {
    setMySharesModalOpen(true);
  }, []);

  const closeMySharesModal = useCallback(() => {
    setMySharesModalOpen(false);
  }, []);

  const value = useMemo<ModalContextValue>(
    () => ({
      authModalOpen,
      authModalMode,
      openAuthModal,
      closeAuthModal,
      userProfileModalOpen,
      openUserProfileModal,
      closeUserProfileModal,
      feedbackModalOpen,
      openFeedbackModal,
      closeFeedbackModal,
      rechargeModalOpen,
      rechargeCanvasId,
      upgradeModalReason,
      openRechargeModal,
      closeRechargeModal,
      adminModalOpen,
      openAdminModal,
      closeAdminModal,
      mySharesModalOpen,
      openMySharesModal,
      closeMySharesModal,
    }),
    [
      authModalOpen,
      authModalMode,
      openAuthModal,
      closeAuthModal,
      userProfileModalOpen,
      openUserProfileModal,
      closeUserProfileModal,
      feedbackModalOpen,
      openFeedbackModal,
      closeFeedbackModal,
      rechargeModalOpen,
      rechargeCanvasId,
      upgradeModalReason,
      openRechargeModal,
      closeRechargeModal,
      adminModalOpen,
      openAdminModal,
      closeAdminModal,
      mySharesModalOpen,
      openMySharesModal,
      closeMySharesModal,
    ]
  );

  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
};

export function useModal(): ModalContextValue {
  const context = useContext(ModalContext);
  return context ?? defaultModalContextValue;
}
