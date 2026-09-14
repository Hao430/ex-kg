/**
 * Dependency Cruiser 配置 — 枝想架构守护测试
 *
 * 目的：把"分层约束"从文档规范（`docs/开发规范.md` §3.2）固化为 CI 校验
 *
 * 单向依赖方向：
 *   routes  →  services  →  repositories  →  core
 *      ↓           ↓             ↓             ↓
 *      └─────────→  middleware  ←┴─────────────┘
 *                  └─────→  lib（纯工具）  ←────┘
 *
 * 禁止：
 *   - 反向依赖（services → routes / repositories → services / core → repositories）
 *   - 跨层跳跃（routes → repositories 跳过 services）
 *   - 后端引前端（server/* → src/*）
 *   - 循环依赖
 *   - 跨领域直接 import（admin → user.repository 私有函数，详见 allowlist）
 *
 * 运行：
 *   npm run arch:check        # 校验（CI 必过）
 *   npm run arch:check:html   # 生成 HTML 依赖图
 *   npm run arch:check:graph  # 生成 DOT 依赖图
 *
 * 参考：
 *   - docs/adr/0000-adr-template.md
 *   - docs/开发规范.md §3.2
 */
module.exports = {
  /**
   * 依赖规则（rule 顺序敏感，先匹配先生效）。
   *
   * ⚠️ 键名是 `forbidden`：dependency-cruiser **没有** `rules` 这个顶层键。
   * 本文件此前写作 `rules: { … }`——键名错，且该放数组却放了对象——于是**连语法都解析不过**，
   * `npm run arch:check` 从未真正跑起来过。又因为 CI 只跑 arch-tests、不跑 arch:check，
   * 这个坏掉的配置一直没人发现（2026-09-14 修复）。
   *
   * 另：v16 起其余选项一律收进 `options`，顶层不再接受——原先顶层与 `options` 里各写了一份。
   */
  forbidden: [
    // ---------- 0. 全局禁止 ----------
    {
      name: 'no-circular',
      severity: 'error',
      comment: '禁止循环依赖（A → B → A）',
      from: { path: '^(src|server)' },
      to: { circular: true },
    },
    {
      name: 'no-node-modules-in-src',
      severity: 'error',
      comment: '禁止 src / server 内嵌 node_modules',
      from: { path: '^(src|server)' },
      to: { path: 'node_modules' },
    },
    {
      name: 'no-backend-imports-frontend',
      severity: 'error',
      comment: '禁止后端 import 前端代码（server → src）',
      from: { path: '^server/' },
      to: { path: '^src/' },
    },
    {
      name: 'no-frontend-imports-backend',
      severity: 'error',
      comment: '禁止前端 import 后端代码（src → server）',
      from: { path: '^src/' },
      to: { path: '^server/' },
    },

    // ---------- 1. lib 工具层：纯函数，不能反向依赖 ----------
    {
      name: 'lib-cannot-depend-on-upper',
      severity: 'error',
      comment: 'lib/* 是纯工具，禁止反向依赖 routes/services/repositories/core',
      from: { path: '^server/lib/' },
      to: {
        path: '^server/(routes|services|repositories|core|middleware|jobs)/',
      },
    },

    // ---------- 2. core 基础设施层 ----------
    {
      name: 'core-cannot-depend-on-repositories',
      severity: 'error',
      comment: 'core/* 是基础设施，禁止依赖 repositories',
      from: { path: '^server/core/' },
      to: { path: '^server/repositories/' },
    },
    {
      name: 'core-cannot-depend-on-services',
      severity: 'error',
      comment: 'core/* 是基础设施，禁止依赖 services',
      from: { path: '^server/core/' },
      to: { path: '^server/services/' },
    },
    {
      name: 'core-cannot-depend-on-routes',
      severity: 'error',
      comment: 'core/* 是基础设施，禁止依赖 routes',
      from: { path: '^server/core/' },
      to: { path: '^server/routes/' },
    },

    // ---------- 3. repositories 数据访问层 ----------
    {
      name: 'repositories-cannot-depend-on-services',
      severity: 'error',
      comment: 'repositories/* 是数据访问层，禁止依赖 services（业务编排）',
      from: { path: '^server/repositories/' },
      to: { path: '^server/services/' },
    },
    {
      name: 'repositories-cannot-depend-on-routes',
      severity: 'error',
      comment: 'repositories/* 是数据访问层，禁止依赖 routes',
      from: { path: '^server/repositories/' },
      to: { path: '^server/routes/' },
    },
    {
      name: 'repositories-cannot-depend-on-middleware',
      severity: 'error',
      comment: 'repositories/* 是数据访问层，禁止依赖 middleware（HTTP 概念）',
      from: { path: '^server/repositories/' },
      to: { path: '^server/middleware/' },
    },
    {
      name: 'repositories-cannot-depend-on-jobs',
      severity: 'error',
      comment: 'repositories/* 是数据访问层，禁止依赖 jobs（任务调度概念）',
      from: { path: '^server/repositories/' },
      to: { path: '^server/jobs/' },
    },

    // ---------- 4. services 业务编排层 ----------
    {
      name: 'services-cannot-depend-on-routes',
      severity: 'error',
      comment: 'services/* 是业务编排层，禁止依赖 routes（HTTP 概念）',
      from: { path: '^server/services/' },
      to: { path: '^server/routes/' },
    },
    {
      name: 'services-cannot-depend-on-middleware',
      severity: 'error',
      comment: 'services/* 是业务编排层，禁止依赖 middleware（HTTP 概念）',
      from: { path: '^server/services/' },
      to: { path: '^server/middleware/' },
    },
    {
      name: 'services-cannot-depend-on-jobs',
      severity: 'error',
      comment: 'services/* 是业务编排层，禁止依赖 jobs（任务调度概念）',
      from: { path: '^server/services/' },
      to: { path: '^server/jobs/' },
    },

    // ---------- 5. routes HTTP 层 ----------
    {
      name: 'routes-cannot-depend-on-core',
      severity: 'warn',
      comment: 'routes 应通过 services 访问 core（间接依赖）；直接依赖 core 是耦合信号',
      from: { path: '^server/routes/' },
      to: { path: '^server/core/' },
    },

    // ---------- 6. middleware 横切层 ----------
    {
      name: 'middleware-cannot-depend-on-routes',
      severity: 'error',
      comment: 'middleware/* 是横切层，禁止依赖 routes（避免反向耦合）',
      from: { path: '^server/middleware/' },
      to: { path: '^server/routes/' },
    },

    // ---------- 7. jobs 后台任务层 ----------
    {
      name: 'jobs-cannot-depend-on-routes',
      severity: 'error',
      comment: 'jobs/* 是后台任务，禁止依赖 routes（HTTP 概念）',
      from: { path: '^server/jobs/' },
      to: { path: '^server/routes/' },
    },
    {
      name: 'jobs-cannot-depend-on-middleware',
      severity: 'error',
      comment: 'jobs/* 是后台任务，禁止依赖 middleware（HTTP 概念）',
      from: { path: '^server/jobs/' },
      to: { path: '^server/middleware/' },
    },

    // ---------- 8. 跨领域 import 约束（allowlist 例外） ----------
    {
      name: 'cross-domain-repository-import',
      severity: 'warn',
      comment:
        '跨 repository 引用（user → session, billing → user, ai → canvas）：只在确有必要时使用，并写明理由',
      from: { path: '^server/repositories/' },
      to: {
        path: '^server/repositories/',
        pathNot: '\\.test\\.ts$',
      },
    },

    // ---------- 9. 测试文件豁免 ----------
    {
      name: 'test-files-cannot-be-imported-by-src',
      severity: 'error',
      comment: '禁止 src/server 引用测试文件（tests/* 只能由 tests 自身引用）',
      from: { path: '^(src|server)/' },
      to: { path: '^tests/' },
    },
  ],

  // 输出选项
  options: {
    doNotFollow: {
      path: '(node_modules|/dist|/coverage|/build)',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    // 包含与排除（原先误写在顶层；v16 起必须放这里，否则不生效）
    includeOnly: '^src/|^server/',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    // 注：原先这里配了 reporterOptions.text.showErrorSummary，v18 已不接受该属性
    //（schema 校验直接报 must NOT have additional properties），且它只影响错误摘要的展示，
    // 与判据无关，故移除。
  },
};
