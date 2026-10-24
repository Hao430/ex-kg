import { describe, it, expect, vi } from 'vitest';
import { createScopedStore } from '@/src/lib/store-factory';
import type { ScopedStoreSpec } from '@/src/lib/store-factory';

interface TestState {
  items: string[];
  loaded: boolean;
}

interface TestView {
  items: string[];
  loaded: boolean;
}

function makeSpec(overrides: Partial<ScopedStoreSpec<TestState, TestView>> = {}) {
  return {
    name: 'test-store',
    initialState: () => ({ items: [] as string[], loaded: false }),
    buildView: (s: TestState): TestView => ({ items: s.items, loaded: s.loaded }),
    ...overrides,
  } satisfies ScopedStoreSpec<TestState, TestView>;
}

describe('createScopedStore', () => {
  it('keeps view reference stable across reads (useSyncExternalStore 契约)', () => {
    const store = createScopedStore(makeSpec());

    const a = store.getView();
    const b = store.getView();
    expect(a).toBe(b);
  });

  it('rebuilds view reference only on setState', () => {
    const store = createScopedStore(makeSpec());
    const before = store.getView();

    store.setState({ items: ['x'], loaded: true });
    const after = store.getView();

    expect(after).not.toBe(before);
    expect(after.items).toEqual(['x']);
    expect(after.loaded).toBe(true);
  });

  it('fans out notify to subscribers and supports unsubscribe', () => {
    const store = createScopedStore(makeSpec());
    const cb = vi.fn();

    const unsub = store.subscribe(cb);
    store.setState({ items: ['a'], loaded: false });
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    store.setState({ items: ['b'], loaded: false });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not crash when a listener throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createScopedStore(makeSpec());
    store.subscribe(() => {
      throw new Error('boom');
    });

    expect(() => store.setState({ items: [], loaded: true })).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      'test-store listener error:',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('bindScope resets state via onScopeBind and is idempotent per key', () => {
    const onScopeBind = vi.fn(() => ({ items: ['cached'], loaded: false }));
    const store = createScopedStore(makeSpec({ onScopeBind }));

    store.bindScope('user-1');
    expect(onScopeBind).toHaveBeenCalledWith('user-1');
    expect(store.getState().items).toEqual(['cached']);

    // 同 key 重复绑定是空操作
    const viewBefore = store.getView();
    store.bindScope('user-1');
    expect(onScopeBind).toHaveBeenCalledTimes(1);
    expect(store.getView()).toBe(viewBefore);

    // 换 key 重新绑定
    store.bindScope('user-2');
    expect(onScopeBind).toHaveBeenCalledTimes(2);
  });

  it('bindScope falls back to initialState when no onScopeBind', () => {
    const store = createScopedStore(makeSpec());
    store.setState({ items: ['dirty'], loaded: true });

    store.bindScope('user-1');
    expect(store.getState()).toEqual({ items: [], loaded: false });
  });

  it('persistNow passes current state and bound scope to writeCache', () => {
    const writeCache = vi.fn();
    const store = createScopedStore(makeSpec({ writeCache }));

    store.setState({ items: ['a'], loaded: true });
    store.persistNow();
    expect(writeCache).toHaveBeenLastCalledWith({ items: ['a'], loaded: true }, null);

    store.bindScope('user-1');
    store.persistNow();
    // bindScope 无 onScopeBind 时回落 initialState
    expect(writeCache).toHaveBeenLastCalledWith({ items: [], loaded: false }, 'user-1');
  });

  it('clearScope unbinds without notifying', () => {
    const store = createScopedStore(makeSpec());
    const cb = vi.fn();
    store.subscribe(cb);
    store.bindScope('user-1');

    store.clearScope();

    expect(store.getBoundScope()).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1); // bindScope 的那一次
  });

  it('resetForTest clears state, scope and listeners', () => {
    const store = createScopedStore(makeSpec());
    const cb = vi.fn();
    store.subscribe(cb);
    store.setState({ items: ['x'], loaded: true });
    store.bindScope('user-1');
    expect(cb).toHaveBeenCalledTimes(2); // setState 与 bindScope 各 notify 一次

    store.resetForTest();

    expect(store.getState()).toEqual({ items: [], loaded: false });
    expect(store.getBoundScope()).toBeNull();
    store.setState({ items: ['y'], loaded: false });
    expect(cb).toHaveBeenCalledTimes(2); // 重置后订阅已清空
  });
});
