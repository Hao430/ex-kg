# 架构守护测试 (Architecture Guard Tests)

> 把"分层约束 / 双模纪律 / 限流必挂"等架构纪律从文档规范**固化为 CI 校验**。

## 目标

ADR 体系解决"**决策**"问题，架构守护测试解决"**执行**"问题。两者结合：

| 层次 | 工具 | 检查内容 | 触发时机 |
| :--- | :--- | :--- | :--- |
| **L1: 分层约束** | `dependency-cruiser` | 单向依赖、循环依赖、跨层 import | pre-commit / CI |
| **L2: 纪律约束** | `arch-tests/*.test.mjs` (node:test) | 双模写法、限流器必挂、错误码统一 | `npm test` 阶段 |
| **L3: 实时提示**（可选） | `eslint-plugin-boundaries` | IDE 写代码时即时提示违反 | 编辑器 / `npm run lint` |

## L1: dependency-cruiser

### 安装

```bash
npm install --save-dev dependency-cruiser
```

### 脚本

`package.json` 已加：

```json
{
  "scripts": {
    "arch:check": "depcruise . --config .dependency-cruiser.cjs",
    "arch:check:html": "depcruise . --config .dependency-cruiser.cjs --output-type html --output-to arch-report.html",
    "arch:check:graph": "depcruise . --config .dependency-cruiser.cjs --output-type dot --output-to arch-graph.dot"
  }
}
```

### 规则一览

| 规则 | 严重度 | 说明 |
| :--- | :--- | :--- |
| `no-circular` | error | 禁止循环依赖 |
| `no-node-modules-in-src` | error | 禁止内嵌 node_modules |
| `no-backend-imports-frontend` | error | 禁止 `server/` 引 `src/` |
| `no-frontend-imports-backend` | error | 禁止 `src/` 引 `server/` |
| `lib-cannot-depend-on-upper` | error | `lib/*` 是纯工具，禁止反向依赖 |
| `core-cannot-depend-on-{repositories,services,routes}` | error | `core/*` 是基础设施 |
| `repositories-cannot-depend-on-{services,routes,middleware,jobs}` | error | `repositories/*` 是数据访问层 |
| `services-cannot-depend-on-{routes,middleware,jobs}` | error | `services/*` 是业务编排层 |
| `routes-cannot-depend-on-core` | warn | routes 应通过 services 访问 core |
| `middleware-cannot-depend-on-routes` | error | 避免反向耦合 |
| `jobs-cannot-depend-on-{routes,middleware}` | error | jobs 是后台任务 |
| `cross-domain-repository-import` | warn | 跨 repository 引用需 allowlist |
| `test-files-cannot-be-imported-by-src` | error | 禁止 src/server 引 tests |

### 首次运行

```bash
npm run arch:check
```

预期：当前代码应 0 错误。如果出现错误，**说明代码违反 `docs/开发规范.md` §3.2**。

## L2: arch-tests/*.test.mjs (node:test)

### 现有 arch-tests

- `repository-dual-mode.test.mjs` — 检查 `server/repositories/*.ts` 每个 export 函数**都覆盖双模**（PG try + 内存兜底）
- `route-rate-limiter.test.mjs` — 检查 `server/routes/*.ts` 每个 `router.METHOD` 路径**都挂载限流器**（或显式豁免）

### 运行

```bash
# 单独跑
node --test arch-tests/

# 或加进 npm test
# 修改 package.json:
#   "test": "PAYMENT_ENABLED=true tsx --test 'tests/*.test.ts' && node --test arch-tests/"
```

### 新增 arch-test 模板

```javascript
// arch-tests/my-rule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;

test('每个 X 都有 Y', () => {
  const files = readdirSync(join(ROOT, 'server/x'), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => d.name);

  for (const f of files) {
    const content = readFileSync(join(ROOT, 'server/x', f), 'utf-8');
    // 你的断言
    assert.ok(content.includes('Y'), `${f} 应包含 Y`);
  }
});
```

## L3: eslint-plugin-boundaries（可选）

### 安装

```bash
npm install --save-dev eslint eslint-plugin-import eslint-plugin-boundaries
```

### 配置

```js
// eslint.config.js (flat config)
import boundaries from 'eslint-plugin-boundaries';
export default [
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'lib', pattern: 'server/lib/*' },
        { type: 'core', pattern: 'server/core/*' },
        { type: 'repositories', pattern: 'server/repositories/*' },
        { type: 'services', pattern: 'server/services/*' },
        { type: 'routes', pattern: 'server/routes/*' },
        { type: 'middleware', pattern: 'server/middleware/*' },
        { type: 'jobs', pattern: 'server/jobs/*' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'routes', allow: ['services', 'middleware', 'lib'] },
            { from: 'services', allow: ['repositories', 'lib'] },
            { from: 'repositories', allow: ['core', 'lib'] },
            { from: 'core', allow: ['lib'] },
            { from: 'middleware', allow: ['lib', 'core', 'repositories', 'services'] },
            { from: 'jobs', allow: ['repositories', 'lib'] },
            { from: 'lib', allow: [] },
          ],
        },
      ],
    },
  },
];
```

## CI 集成建议

```yaml
# .github/workflows/ci.yml
- name: Architecture Check
  run: |
    npm run arch:check
    node --test arch-tests/
- name: Unit Tests
  run: npm test
- name: Lint
  run: npm run lint
```

## 失败处理流程

1. CI 失败 → 看错误信息（哪个文件、违反哪条规则）；
2. 若是**真实违规** → 修复代码；
3. 若是**架构变更**（如新增层级）→ 改 ADR + 改配置 + 解释 commit message；
4. 若是**配置错误** → 调整 `.dependency-cruiser.cjs`；
5. **禁止**在配置中"加白名单绕过"——白名单必须配 ADR 引用。

## 与现有规范的关系

- `docs/开发规范.md` §3.2 — 分层约束**文字规范**
- `.dependency-cruiser.cjs` — 分层约束**机器校验**
- `arch-tests/*.test.mjs` — 纪律约束**机器校验**
- `docs/adr/` — 决策**why**记录

四者结合 = "**说清楚为什么 + 写得正确 + 跑得过校验**"的闭环。
