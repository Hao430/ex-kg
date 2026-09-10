/**
 * 画板列表 / 配额快照的 React 绑定（2026-09-10 画布列表/同步重构）。
 * subscribe/getSnapshot 必须是模块级稳定函数，否则 useSyncExternalStore 每次渲染重订阅。
 */
import { useSyncExternalStore } from 'react';
import * as boardStore from '../lib/board-store.js';
import * as quotaStore from '../lib/quota-store.js';

export function useBoards() {
  return useSyncExternalStore(
    boardStore.subscribe,
    boardStore.getBoardList,
    boardStore.getBoardList
  );
}

export function useQuotaView(): quotaStore.QuotaView {
  return useSyncExternalStore(quotaStore.subscribe, quotaStore.getQuotaView, quotaStore.getQuotaView);
}
