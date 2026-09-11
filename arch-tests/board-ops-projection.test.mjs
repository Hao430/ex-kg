/**
 * Arch Test: 客户端差分投影 ↔ 服务端落库字段的对应关系（ADR-0017）
 *
 * 客户端只上行「本设备改动过的节点」，判据是投影哈希（src/lib/board-ops.ts）。投影里
 * **少一个会被写库的字段**，那个字段的改动就永远不会上传（本地看得见、刷新后消失，
 * 典型的静默数据丢失）；**多一个不落库的字段**，那个字段一动就整块板重传，回到
 * 「挂机设备覆盖他人改动」。所以投影的字段集合必须与服务端落库口径逐字对齐。
 *
 * 本测试守的是：
 *   1. `KNOWN_DATA_KEYS`（客户端 data 里「各占一列」的字段）== `buildNodeRow` 的解构清单
 *      —— 其余字段走 custom_data 原样往返，投影覆盖整个 data 故无需列举
 *   2. `edgeHash` 的字段集合 == `buildEdgeRow` 读取的边字段
 *
 * 守不住的（需要人看）：某个字段被服务端**读回来时做了不同归一化**（例：写进去是 undefined、
 * 读出来是 null）。那类问题由 tests/h3-board-ops.test.ts 的「形状无关（真函数）」用例覆盖，
 * 它拿真的 normalizeMemoryNode 跑一遍往返。新增列时两处都要看。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_SRC = readFileSync(join(REPO_ROOT, 'server', 'repositories', 'canvas.repository.ts'), 'utf-8');
const OPS_SRC = readFileSync(join(REPO_ROOT, 'src', 'lib', 'board-ops.ts'), 'utf-8');

/** 截取一个顶层函数的文本（到下一个列 0 的 `}` 为止） */
function functionText(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}——若已重命名，请同步本测试`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `无法确定 ${signature} 的结束位置`);
  return src.slice(start, end);
}

const sorted = (arr) => [...arr].sort();

test('节点投影字段清单 == 服务端 buildNodeRow 的解构清单', () => {
  const opsKeys = [...OPS_SRC.matchAll(/export const KNOWN_DATA_KEYS[\s\S]*?=\s*\[([\s\S]*?)\];/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.ok(opsKeys.length > 0, '未能从 board-ops.ts 提取 KNOWN_DATA_KEYS');

  const body = functionText(REPO_SRC, 'function buildNodeRow');
  const destructure = /const\s*\{([\s\S]*?)\}\s*=\s*d;/.exec(body);
  assert.ok(destructure, 'buildNodeRow 里应有一段 `const { ... } = d;` 解构');
  const serverKeys = [...destructure[1].matchAll(/(\w+)\s*:\s*_\w+/g)].map((m) => m[1]);
  assert.ok(serverKeys.length > 0, '未能从 buildNodeRow 提取解构字段');

  assert.deepEqual(
    sorted(opsKeys),
    sorted(serverKeys),
    '客户端投影与服务端的「各占一列」字段不一致：少一个字段 = 该字段的改动静默不上传；' +
      '多一个字段 = 该字段一动就整块板重传。改一边必须同时改另一边。'
  );
});

test('边投影字段集合 == 服务端 buildEdgeRow 读取的字段', () => {
  const hashBody = functionText(OPS_SRC, 'export function edgeHash');
  const opsKeys = [...hashBody.matchAll(/^\s{4}(\w+)\s*[:,]/gm)].map((m) => m[1]);
  assert.ok(opsKeys.length > 0, '未能从 edgeHash 提取字段');

  const serverBody = functionText(REPO_SRC, 'function buildEdgeRow');
  const serverKeys = [...serverBody.matchAll(/edge\.(\w+)/g)].map((m) => m[1]);
  assert.ok(serverKeys.length > 0, '未能从 buildEdgeRow 提取字段');

  assert.deepEqual(
    sorted(opsKeys),
    sorted(serverKeys),
    '边投影与服务端落库字段不一致（same 判据：少则不上传，多则整板重传）'
  );
});

test('节点投影只读 data（顶层易变字段不得进哈希）', () => {
  const hashBody = functionText(OPS_SRC, 'export function nodeHash');
  const topLevel = [...hashBody.matchAll(/^\s{4}(\w+)\s*[:,]/gm)].map((m) => m[1]);
  assert.deepEqual(
    sorted(topLevel),
    ['data', 'id', 'type', 'x', 'y'],
    'React Flow 的 selected/dragging/measured/width/height 只挂在节点顶层；' +
      '一旦进哈希，打开画板（每个节点发一次 dimensions）就等于整板重标脏并重传'
  );
});
