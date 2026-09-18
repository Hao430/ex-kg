/**
 * 未提交提问草稿（`src/lib/chat-draft.ts`）。
 *
 * 用途：提问框的输入在提交前只是组件 state，切走画板/重挂载就没了。草稿存进
 * sessionStorage，标签页内切换与刷新都还在；提交成功后必须清掉，否则下次打开会看到
 * 一条早就问过的旧问题。存储不可用（隐私模式）时不得抛错——丢草稿可以，别连带把画布搞崩。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// 最小 sessionStorage 桩（模块内部按调用时读取，故可在 import 前就位）
const store = new Map<string, string>();
const originalSessionStorage = (globalThis as any).sessionStorage;
(globalThis as any).sessionStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { getChatDraft, setChatDraft, clearChatDraft } = await import('../src/lib/chat-draft.ts');

describe('未提交提问草稿', () => {
  beforeEach(() => {
    store.clear();
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    (globalThis as any).sessionStorage = originalSessionStorage;
  });

  test('写入后可读回（切走画板再回来能恢复）', () => {
    setChatDraft('n1', 'initial', '量子纠错码的核心思路是什么？');
    assert.equal(getChatDraft('n1', 'initial'), '量子纠错码的核心思路是什么？');
  });

  test('提交后清掉：不会把旧问题当成新输入', () => {
    setChatDraft('n1', 'initial', '旧问题');
    clearChatDraft('n1', 'initial');
    assert.equal(getChatDraft('n1', 'initial'), '');
  });

  test('传空串等价于清除', () => {
    setChatDraft('n1', 'followup', '追问');
    setChatDraft('n1', 'followup', '');
    assert.equal(getChatDraft('n1', 'followup'), '');
  });

  test('不同节点、不同输入框互不串味', () => {
    setChatDraft('n1', 'initial', 'A');
    setChatDraft('n1', 'followup', 'B');
    setChatDraft('n2', 'initial', 'C');
    assert.equal(getChatDraft('n1', 'initial'), 'A');
    assert.equal(getChatDraft('n1', 'followup'), 'B');
    assert.equal(getChatDraft('n2', 'initial'), 'C');
    assert.equal(getChatDraft('n2', 'followup'), '');
    clearChatDraft('n1', 'initial');
    assert.equal(getChatDraft('n1', 'followup'), 'B', '清一类不影响另一类');
  });

  test('存储不可用（隐私模式）→ 读回空串且不抛错', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    (globalThis as any).sessionStorage = throwing;

    assert.equal(getChatDraft('n1', 'initial'), '');
    assert.doesNotThrow(() => setChatDraft('n1', 'initial', 'x'));
    assert.doesNotThrow(() => clearChatDraft('n1', 'initial'));
  });
});
