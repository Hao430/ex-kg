/**
 * 前端 — 探索灵感建议解析（src/lib/suggestions.ts）。
 *
 * 覆盖历史 bug：模型用全角破折号 / 空格 / 大小写 / 无破折号输出 SUGGESTIONS 标记时，
 * 旧的精确 split('---SUGGESTIONS---') 解析为空 → 每条问答都落到兜底建议。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { extractSuggestions, getFallbackSuggestions } = await import('../src/lib/suggestions.js');

describe('extractSuggestions — 标记归一化', () => {
  const body = '这是正文。';
  const q1 = '它最容易被误解的地方是什么';
  const q2 = '它要解决的根本问题从何而来';
  const q3 = '换一个领域看会怎样';

  test('标准半角标记 ---SUGGESTIONS---', () => {
    const { answer, suggestions } = extractSuggestions(`${body}\n---SUGGESTIONS---\n${q1}\n${q2}\n${q3}`);
    assert.equal(answer, body);
    assert.deepEqual(suggestions, [q1, q2, q3]);
  });

  test('全角破折号 ——SUGGESTIONS——', () => {
    const { answer, suggestions } = extractSuggestions(`${body}\n——SUGGESTIONS——\n${q1}\n${q2}`);
    assert.equal(answer, body);
    assert.deepEqual(suggestions, [q1, q2]);
  });

  test('标记含空格 + 小写 + 序号/顿号前缀', () => {
    const { answer, suggestions } = extractSuggestions(`${body}\n--- suggestions ---\n1. ${q1}\n2、${q2}`);
    assert.equal(answer, body);
    assert.deepEqual(suggestions, [q1, q2]);
  });

  test('无破折号，仅 Suggestions: 冒号 + 项目符号', () => {
    const { answer, suggestions } = extractSuggestions(`${body}\nSuggestions:\n- ${q1}\n* ${q2}`);
    assert.equal(answer, body);
    assert.deepEqual(suggestions, [q1, q2]);
  });

  test('无标记 → suggestions 为空，answer 为原文 trim', () => {
    const { answer, suggestions } = extractSuggestions(`  ${body}  `);
    assert.equal(answer, body);
    assert.deepEqual(suggestions, []);
  });

  test('过滤过短行与残留 SUGGESTIONS 行', () => {
    const { suggestions } = extractSuggestions(`${body}\n---SUGGESTIONS---\n嗯\n${q1}\nSUGGESTIONS`);
    assert.deepEqual(suggestions, [q1]);
  });
});

describe('getFallbackSuggestions — 兜底多样性与稳定性', () => {
  test('返回 3 条、互不重复、含主题、无「数学/物理/工程」腔', () => {
    const out = getFallbackSuggestions('量子纠缠');
    assert.equal(out.length, 3);
    assert.equal(new Set(out).size, 3);
    for (const q of out) assert.ok(q.includes('量子纠缠'), q);
    assert.ok(!out.some((q) => /数学|物理|软硬件|工程/.test(q)));
  });

  test('同一主题结果稳定（重复渲染一致）', () => {
    assert.deepEqual(getFallbackSuggestions('自由意志'), getFallbackSuggestions('自由意志'));
  });

  test('空 / 纯语气词主题回落到「当前主题」', () => {
    const out = getFallbackSuggestions('请问');
    for (const q of out) assert.ok(q.includes('当前主题'), q);
  });

  test('不同主题按 hash 轮转，不总是命中同一角度', () => {
    const firsts = new Set(
      ['量子纠缠', '自由意志', 'AI Agent', '特修斯之船', '熵与信息'].map((t) => getFallbackSuggestions(t)[0])
    );
    assert.ok(firsts.size > 1, '不同主题不应永远命中同一角度');
  });
});
