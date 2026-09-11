/**
 * 探索灵感建议解析（从 DeepDiveCanvas 抽出的纯函数，便于单测）。
 *
 * 模型按 system prompt 在正文末尾输出 `---SUGGESTIONS---` 分隔符 + 3 条后续问题。
 * 历史 bug：仅精确 `split('---SUGGESTIONS---')` 会漏——模型输出全角破折号 / 空格 / 大小写
 * 变体时解析为空，导致每条问答都落到兜底建议。此处做标记归一化，并放宽前缀剥离。
 */

/** 匹配 SUGGESTIONS 标记：兼容半角/全角破折号、中间空格、大小写、无破折号、可选冒号。 */
const SUGGESTIONS_MARKER_RE = /(?:[-—–－]{2,}\s*)?SUGGESTIONS\s*[-—–－]*[:：]?/i;

/** 把模型原始输出切成「正文」与「后续探索问题」；无标记时 suggestions 为空。 */
export function extractSuggestions(raw: string): { answer: string; suggestions: string[] } {
  const m = SUGGESTIONS_MARKER_RE.exec(raw);
  if (!m) return { answer: raw.trim(), suggestions: [] };
  const answer = raw.slice(0, m.index).trim();
  const suggestions = raw
    .slice(m.index + m[0].length)
    .split('\n')
    .map((s) => s.replace(/^[\s\d０-９\.\、\)）:：\-*•·]+/, '').trim())
    .filter((s) => s.length > 3 && !/SUGGESTIONS/i.test(s));
  return { answer, suggestions };
}

/**
 * 模型未给出可用建议时的兜底：多角度、去「物理/工程」腔，并按主题稳定轮转，
 * 避免不同节点兜底文案完全一样（同一主题结果稳定，便于测试与重复渲染一致）。
 */
export function getFallbackSuggestions(topic: string): string[] {
  const clean = topic.replace(/^[请问如何么什]+/, '').trim() || '当前主题';
  const angles = [
    `「${clean}」最容易被误解的地方是什么？`,
    `在「${clean}」被提出之前，人们想解决的是什么问题？`,
    `什么样的例子会动摇对「${clean}」的常见理解？`,
    `「${clean}」与哪些看似无关的领域共享同一套逻辑？`,
    `如果只保留关于「${clean}」的一个结论，应该是什么？`,
  ];
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  const start = h % angles.length;
  return [0, 1, 2].map((i) => angles[(start + i) % angles.length]);
}
