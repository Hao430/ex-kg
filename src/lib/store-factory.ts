/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 作用域 store 骨架工厂：收敛 folder-store / quiz-store / quota-store 共享的
 * 「listeners + 稳定 view 引用 + bindScope + 持久化钩子」样板。
 *
 * useSyncExternalStore 契约：view 引用只在 setState/bindScope 内 rebuild，
 * 其余时刻 getView() 必须返回同一引用。
 *
 * 不含 React 依赖；board-store 刻意不迁移（未确认缓冲/tombstone/ghost 与
 * sync-queue、多标签锁强耦合，抽象收益远小于回归风险）。
 */
import * as scope from './board-scope';

export type ScopeKey = scope.ScopeKey;

export interface ScopedStoreSpec<S, V> {
  /** 日志前缀（listener 异常时输出 `${name} listener error:`） */
  name: string;
  /** 初始状态；每次调用返回新对象（resetForTest / bindScope 复用） */
  initialState: () => S;
  /** 由状态构建对外视图 */
  buildView: (state: S) => V;
  /** 绑定新作用域时的状态（读本地缓存等）；缺省 initialState() */
  onScopeBind?: (key: ScopeKey) => S;
  /** 持久化当前状态；由业务侧显式调用 persistNow()，不随 setState 自动触发 */
  writeCache?: (state: S, key: ScopeKey | null) => void;
}

export interface ScopedStore<S, V> {
  subscribe(cb: () => void): () => void;
  /** useSyncExternalStore 的 getSnapshot：稳定引用 */
  getView(): V;
  getState(): S;
  setState(next: S): void;
  persistNow(): void;
  /** 同 key 重复绑定是空操作（幂等，StrictMode 双跑安全） */
  bindScope(key: ScopeKey): void;
  getBoundScope(): ScopeKey | null;
  /** 登出等场景解绑作用域（不动订阅） */
  clearScope(): void;
  /** 仅供测试：清状态与全部订阅 */
  resetForTest(): void;
}

export function createScopedStore<S, V>(spec: ScopedStoreSpec<S, V>): ScopedStore<S, V> {
  let state: S = spec.initialState();
  let boundScope: ScopeKey | null = null;
  let view: V = spec.buildView(state);
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const cb of listeners) {
      try {
        cb();
      } catch (e) {
        console.error(`${spec.name} listener error:`, e);
      }
    }
  }

  function rebuild(): void {
    view = spec.buildView(state);
    notify();
  }

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    getView: () => view,

    getState: () => state,

    setState(next) {
      state = next;
      rebuild();
    },

    persistNow() {
      spec.writeCache?.(state, boundScope);
    },

    bindScope(key) {
      if (boundScope === key) return;
      boundScope = key;
      state = spec.onScopeBind ? spec.onScopeBind(key) : spec.initialState();
      rebuild();
    },

    getBoundScope: () => boundScope,

    clearScope() {
      boundScope = null;
    },

    resetForTest() {
      state = spec.initialState();
      boundScope = null;
      view = spec.buildView(state);
      listeners.clear();
    },
  };
}
