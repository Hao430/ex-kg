import { useState, useCallback } from 'react';

export interface ShareDialogState {
  url: string;
  recreated: boolean;
}

/**
 * 集中管理 App 层弹窗、查看器与全局轻提示状态
 */
export function useAppModals() {
  const [sampleViewerOpen, setSampleViewerOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string, durationMs = 3000) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, durationMs);
  }, []);

  const openSampleViewer = useCallback(() => setSampleViewerOpen(true), []);
  const closeSampleViewer = useCallback(() => setSampleViewerOpen(false), []);

  const openLibrary = useCallback(() => setLibraryOpen(true), []);
  const closeLibrary = useCallback(() => setLibraryOpen(false), []);

  const openShareDialog = useCallback((state: ShareDialogState) => setShareDialog(state), []);
  const closeShareDialog = useCallback(() => setShareDialog(null), []);

  return {
    sampleViewerOpen,
    setSampleViewerOpen,
    openSampleViewer,
    closeSampleViewer,
    libraryOpen,
    setLibraryOpen,
    openLibrary,
    closeLibrary,
    shareDialog,
    setShareDialog,
    openShareDialog,
    closeShareDialog,
    toastMessage,
    showToast,
  };
}
