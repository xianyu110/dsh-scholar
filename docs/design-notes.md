# RSP-001 — DSH 接口核对笔记(实施阶段 0 产出)

> 依据设计文档附录 C「实施前必须从源码确认的接口」逐项核对。
> 核验对象:`/home/dev/Desktop/test-lzszq`(设计文档 §0 基线仓库)。
> 所有结论均带源码引用(文件:行号)。实施日期:2026-08-06。

## 1. Cordis 插件的最小注册与生命周期

- 插件模块导出 `name`、`inject`、`apply(ctx, config)` 即可被 Loader 加载;
  `inject` 声明依赖服务,缺服务时 fiber 保持 PENDING 直到服务出现
  (参考 `packages/cordis/repository-plugin/src/index.ts:37-39`,
  `packages/todo/tool-todo/src/index.ts:64-67`)。
- `apply` 可同步或异步;fiber 失败会拒绝整个 Loader 事务
  (`vendor/loader/src/config/entry.ts:274`,repository-plugin 注释
  `index.ts:78-90`)。
- 生命周期清理用 `ctx.effect(() => () => {...}, label)`(Cordis effect 模型,
  参考 `packages/mcp/mcp-client/src/index.ts:122-133`)。

## 2. base/web patch-list 的挂载写法

- `packages/bundle/base/cordis.patch.yml` 是整个 base bundle 的 patch 列表:
  顶层数组,元素是 `- insert: [- id, name, config]` 或 id-targeted 覆盖行;
  patch 对同一 row 整体替换 config,不做 merge(`base/cordis.patch.yml:1-13` 注释)。
- mode bundle 再 patch:`packages/bundle/web-app/cordis.patch.yml`、
  `packages/bundle/headless/cordis.patch.yml`。
- **Bundle 包机制**:npm 包 manifest 声明 `"dsh": {"bundle": {"patch":
  "./cordis.patch.yml"}}`,`dsh plugin --profile <name> add <spec>` 安装后
  自动加入 profile 的 `dsh.profile.bundles` 层栈
  (`apps/cli/src/plugin.ts:36-45, 59-91`;`packages/ui/app-boot/src/profile.ts:42-45,
  115-118`)。
- Profile 目录:`$DSH_HOME/profiles/<name>/`(package.json + cordis.patch.yml +
  pnpm-workspace.yaml;`profile.ts:105-112, 148-164`)。
- 插件解析双锚点:先 dsh 安装闭包,再 profile 目录;profile 的扁平
  `node_modules` 回退(healed fallback)让所有插件共享同一 cordis 实例
  (`profile.ts:15-22`)。

## 3. 工具注册 API

- `ctx.tools.register(defineTool({name, description, parameters, output:
  {schema, render}, execute}))`
  (`packages/core/tools/src/schema.ts:483-523`;完整示例
  `packages/todo/tool-todo/src/index.ts:90-140`)。
- parameters 是 JSON Schema 风格的 `ParameterSchemaSpec`:属性用
  `required: true` 标记必填(可选属性不写 required);枚举用 `enum`。
- output.schema 是 `ValueSchemaSpec`;`render(args, value)` 返回
  `ContentBlock[]`(文本块 `{type:'text', text}`,
  `packages/llm/llm/src/types.ts:38-41`)。
- 类型注意:ObjectValueSchemaSpec 必须显式声明 `additionalProperties:
  boolean`;`additionalProperties: true` 时输出推断为 `properties &
  Record<string, JsonValue>`(`schema.ts:66-70, 137-150`)。
- `exec.agent.id` 即会话 id(Agent.id: SessionId,
  `packages/core/agent/src/types.ts:63-75`),用于 session↔project 映射。

## 4. 按 Agent 限制工具面(工具 ACL)

- 事件 `tools/pre-execute(exec, next)` 是 waterfall:返回
  `{kind:'allow'} | {kind:'deny', reason} | {kind:'ask'}`;
  scope-filtered(`@deepseek-ai/dsh-scope`)支持按 agent 作用域
  (`packages/core/tools/src/index.ts:105-113, 526-529`)。
- 本插件实现:全局注册研究工具 + `tools/pre-execute` 中按
  `roles.get(exec.agent.id)` 拒绝角色外工具(见 `src/plugin/acl.ts`)。
- 每 agent 独立挂载(agent.ctx 内注册)是另一条路,但需 composition 为每个
  agent 装配,首版采用 ACL facade(设计文档 §3.3 允许)。

## 5. 命令注册 API

- `ctx.commands.register({name, description, input?: {hint}, handler:
  invocation => {kind:'success', text} | {kind:'error', text}})`
  (`packages/ui/commands/src/index.ts:50-72, 296-303`;
  示例 `packages/goal/command-goal/src/index.ts:164-171`)。
- `invocation.agent.id` 提供会话 id;`invocation.rawInput` 是命令名后的原文。
- Context 增强:`declare module 'cordis' { interface Context { commands:
  CommandService } }`(`commands/src/index.ts:142-145`)。

## 6. 自定义 SessionEvent

- 会话日志是事件源(`packages/session-persistence`);外部插件无法直接追加
  任意事件类型 — 设计文档 §3.3 的兜底成立:研究事件写入 Kernel outbox,
  通过 tool call/result 自然进入 SessionEvent 日志,二者用
  `session_id/event_id` 关联(Gate Decision 已实现此关联)。
- Kernel outbox 支持 at-least-once + 去重(`packages/research-kernel` 的
  `events` 表 + `delivered` 标记)。

## 7. Goal / Plan Review / Question / Approval 的编程 API

- Goal:服务 `ctx.goals`(`packages/goal`),命令 `/goal`
  (`packages/goal/command-goal/src/index.ts`)。
- 审批:approval 服务 `@deepseek-ai/dsh-user-approval`(类型增强即
  `ctx.get('approval')`,`packages/core/tools/src/index.ts:12-15 注释`)。
- 首版 Gate 交互走「工具 + 命令 + Kernel Gate 记录」,不直接调 Approval API;
  设计文档 §5.2 的「结构化 Question/自定义 Web 面板」留待 E7 UI。

## 8. JSON-RPC / Python SDK / Headless 契约

- `dsh -p <task>`(headless one-shot)、`dsh --resume <id>`、`--config`/`
  --config-replace` overlay 见 `apps/cli/src/args.ts` 与 `bin.ts`。
- 同一 session 单 prompt 并发约束见设计文档 §5.3;本插件不创建多 prompt。

## 9. shipped-composition 测试方式

- 组合树通过 `dsh --profile <name> --dump-config` 打印(每层标注 bundle 名);
  新增 bundle 后 `dsh.profile.bundles` 自动包含插件层。
- 本仓库的等价验证:`scripts/dsh-dev --profile research-headless
  --dump-config` + headless 任务 + `tests/e2e/golden-path.sh`(独立 kernel/
  runner 进程,不依赖 DSH)。

## 10. repository-plugin(GitHub 插件加载)机制

- specifier:`github:owner/repo#<ref>&path:/<subpath>/.dsh-plugin`
  (`packages/cordis/repository-plugin/src/source.ts:24, 39-49`);
  **prepared 格式只支持 skills + MCP**(`format.ts:18-23` 要求至少一个
  skill root 或 mcpServers 文件),不支持代码工具插件 — 完整代码插件必须走
  bundle 安装(`dsh plugin add`)。
- 本仓库同时提供 `.dsh-plugin`(skills 路径)与根 bundle(完整功能),见
  `plugins/research-core/.dsh-plugin`。

## 11. Credentials / 设置 / 沙箱

- credentials:`@deepseek-ai/dsh-credentials-local`,环境与 `$DSH_HOME/.env`
  热重载(`packages/bundle/base/cordis.patch.yml:71-77`);设计原则:DSH 侧只存
  引用,Runner 独立凭据域。
- 沙箱默认 `workspace-write + ask`;`danger-full-access` 与通用 web_fetch
  默认关闭(同文件 `144-152, 356-371`)。

## 12. cordis 类型差异(本地开发注意事项)

- DSH 使用 vendored cordis(`vendor/cordis`),其 `Context` 混入
  `plugin/on/inject/logger`;npm 版 4.0.0-rc.7 类型不含这些成员
  (npm `lib/context.d.ts` vs vendor `lib/types/context.d.ts`)。
- 本地类型检查:`scripts/link-dsh-deps.sh` 把 DSH 安装的 `@deepseek-ai/*`
  与 `@cordisjs/*` 链接进本仓库 node_modules,并把 `cordis` 映射到 vendor
  类型(`tsconfig.base.json` paths)。运行时由 DSH profile 的扁平回退提供,
  与本仓库 node_modules 无关。
