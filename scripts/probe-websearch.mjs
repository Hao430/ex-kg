/**
 * DashScope /responses 联网搜索探测脚本（诊断「web_search 从不触发」用）
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/probe-websearch.mjs
 *   DASHSCOPE_API_KEY=sk-xxx BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 MODEL=qwen3.8-flash node scripts/probe-websearch.mjs
 *
 * 跑两组对照：
 *   A) 与 server/routes/chat.ts 完全相同的参数（tools=[web_search] + enable_thinking:false + store:false），tool_choice 缺省（auto）
 *   B) 同参数 + tool_choice:'required'（官方文档：单工具场景可强制调用）
 * 只打印事件类型与来源数，不打印任何密钥。
 */

const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  console.error('缺少 DASHSCOPE_API_KEY 环境变量');
  process.exit(1);
}
const baseUrl = (process.env.BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const model = process.env.MODEL || 'qwen3.8-flash';
// 实时性问题，模型应当需要联网才能回答
const question = '今天杭州的天气如何？请给出来源。';

async function probe(label, extra) {
  console.log(`\n===== ${label} =====`);
  const body = {
    model,
    input: [{ role: 'user', content: question }],
    tools: [{ type: 'web_search' }],
    stream: true,
    temperature: 0.7,
    max_output_tokens: 2048,
    ...extra,
  };
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  console.log('HTTP', res.status);
  if (!res.ok || !res.body) {
    console.log('错误响应:', (await res.text()).slice(0, 500));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const eventTypes = {};
  let sources = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        const chunk = JSON.parse(t.slice(5).trim());
        const type = chunk?.type || '?';
        eventTypes[type] = (eventTypes[type] || 0) + 1;
        if (type === 'response.output_item.done' && chunk?.item?.type === 'web_search_call') {
          const srcs = chunk?.item?.action?.sources;
          sources += Array.isArray(srcs) ? srcs.length : 0;
          console.log('  web_search_call 完成，query:', JSON.stringify(chunk?.item?.action?.query), 'sources:', Array.isArray(srcs) ? srcs.length : typeof srcs);
        }
        if (type === 'response.output_text.delta' && typeof chunk?.delta === 'string') text += chunk.delta;
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  console.log('事件类型统计:', eventTypes);
  console.log('web_search_call 来源总数:', sources);
  console.log('回答前 120 字:', text.slice(0, 120).replace(/\n/g, ' '));
}

try {
  await probe('A) chat.ts 同款参数（tool_choice 缺省 = auto）', { enable_thinking: false, store: false });
  await probe('B) 强制联网（tool_choice: required，单工具场景）', { enable_thinking: false, store: false, tool_choice: 'required' });
} catch (e) {
  console.error('探测失败:', e?.message || e);
}
