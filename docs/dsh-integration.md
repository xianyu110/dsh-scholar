# DSH 宿主集成规范

> 规范性文档。目标宿主是 DeepSeek Harness 当前 Cordis 架构。

## 1. 包与前置条件

根包名为 @dsh-scholar/research-plugin，ESM，只导出 Cordis Agent 插件。它不导出 `./client`、不声明 `dshClient`、不向 DSH Web 注入 Scholar UI。宿主提供 cordis、schemastery 以及 @deepseek-ai/dsh-tools、@deepseek-ai/dsh-commands、@deepseek-ai/dsh-skill-local 等模块；这些 DeepSeek 包不假设存在于公共 npm registry。

开发环境通过 DSH_SCHOLAR_DSH_ROOT 指向 DSH checkout，脚本只建立可恢复的 symlink。生产运行由 DSH profile 的扁平 node_modules 提供同一 Cordis 实例，禁止打包第二份 Cordis。

## 2. Cordis 插件形状

~~~typescript
export const name = 'research-plugin'
export const inject = ['tools', 'commands', 'subagents']
export async function apply(ctx, config) { /* effect-scoped registrations */ }
~~~

所有工具、命令、事件、Skill provider 和 sidecar 生命周期都有 disposer。根插件不依赖 `httpServer`、slots、LocaleFace 或 ThemeFace。全局可变 toolContextRef 禁止；每个插件实例使用闭包保存 Client、RoleRegistry、Tenant 和 cache。

## 3. 目标配置

以下是 v2 生成目标；当前 v0.1 插件只识别 kernel.host/port/dataDir/token、defaultMode、unattended、models、cacheDir，差距记录在 hardening-v0.2-status.md。

~~~yaml
kernel:
  host: 127.0.0.1
  port: 7412
  dataDir: null
  tokenFile: null
  requireSignedManifest: true
  startSidecar: true
defaultMode: gate-only
unattended: false
skills:
  includeCore: true
  includeDomains: [machine-learning, data-science]
  includeVenues: true
onboarding:
  enabled: true
  maxIntakeBytes: 2147483648
trajectory:
  publishSafeSessionProjection: true
  rawDetail: false
runner:
  defaultProfileId: local-docker-cpu
config:
  source: canonical-registry
~~~

该 YAML 只是 Config Schema 的 instance layer；所有字段必须从 canonical registry 生成，未知字段拒绝。Project/Workspace/Session/Target overrides 由 Kernel ConfigDocument 管理，插件不能另建一套 merge/default。Secret 只写 SecretRef。

port=0 必须通过 sidecar handshake 回填，不能把 0 当作客户端 endpoint。Agent 与 headless profile 使用相同 Kernel 数据规则；不同 DSH_HOME 必须得到不同 dataDir。

## 4. 工具注册

使用 ctx.tools.register(defineTool(...))，parameters 和 output 都给精确 JSON Schema，additionalProperties 明确声明。render 返回结构化 ContentBlock 或安全的工具卡意图。

工具组：

| 角色 | 工具 |
|---|---|
| director | research_project、research_phase、research_gate_request、research_budget、research_status、research_onboarding |
| scholar/curator | literature_search、paper_resolve、corpus_snapshot、passage_lookup |
| panel | research_panel、idea_create、idea_compare、novelty_audit |
| engineer | workspace_snapshot、patch_apply、baseline_prepare、test_run、baseline_verify |
| architect/operator | experiment_register、experiment_submit、experiment_status、experiment_cancel |
| statistician | evidence_note_create、claim_create、claim_verify_request、analysis_request |
| writer/reviewer | manuscript_build、manuscript_review、release_bundle_request |

Unknown role 映射 none。tools/pre-execute waterfall 对未授权工具返回 deny；允许时必须调用 next()。Human Gate Decision、accepted Evidence 写入和任意宿主 shell 不注册为 Agent Tool。

## 5. 命令

唯一顶级命令为 /research，子命令：help、init、new、resume、import、grill、list、status、survey、ideas、gates、jobs、reproduce、contract、run、evidence、claims、write、review、export、release。

`init` 是 new 的引导入口；`import/grill` 只操作 Intake observation/question/proposal。Agent command/tool 不提供 accept/adopt/merge-confirm 或任何 Gate Decision，最终 Adoption 只在 standalone Human BFF 完成。

命令只是 ResearchClient adapter，不重复业务逻辑。它使用 invocation.agent.id 解析 session link。错误输出 research: 加稳定错误摘要，不能泄漏内部路径、Token 或上游响应。帮助文本与 i18n 资源生成；宿主命令描述若在注册时固化语言，locale change 时重新注册或保持语言无关。

## 6. DSH Session 与事件

DSH SessionEventMap 可通过 TypeScript declaration merge 扩展。插件可以追加展示事件并调用 session flush，但科研业务审计仍以 Kernel Outbox 为权威。

推荐 Session 事件只保存关联：project_id、kernel_event_id、gate_id/job_id/build_id 和安全摘要。原始 TerminalLog、Artifact 字节和 TeX 文件不复制进 Session 日志。Tool call/result 使用 DSH presentation metadata 生成可回放终端卡和 Artifact link。

独立 UI 的 Session Trajectory 由 `SafeSessionTrajectoryAdapter` 提供：输出稳定 session/node/parent/mode/status/timing/四桶 token/安全 tool summary 与业务 refs，默认删除 prompt、raw tool args/result、provider payload、cwd/env/secret。Kernel Outbox 另行生成 Research Trajectory；两者不能互相覆盖。

## 7. 子代理与 Durable Orchestrator

ctx.subagents 用于短周期文献、Idea 和 Reviewer Panel。长实验、等待 Gate、崩溃恢复不依赖活跃子代理或聊天上下文；由 Durable Orchestrator 和 Kernel projection 管理。

research_panel 必须：

- 使用有界 perspectives 数量和 completion；
- Promise.allSettled 保留部分成功和失败；
- 将 API/模型用量写预算；
- 外部文本保持 untrusted；
- 返回结构化面板结果而不是让子代理直接写权威状态。

每次 `ctx.subagents.start` 保存 exact parent session、child session、role/kind、one-shot/continuable、created_at 与 safe refs。standalone Topology 只通过 BFF adapter 列 direct children、分页读取 cold history，读取不得激活 Agent；进入 child 使用 parent+child+mode address 和 breadcrumb。continuable follow-up 必须由服务端重新验证 exact live parent、项目 membership 和 capability；首版浏览器不提供 spawn/stop/cancel。

DSH Web 的 trajectory/subagent React plugin、slot、SessionHistoryFace 和 localStorage 不能直接打包到 Scholar。只可移植纯折叠、树、时间线、virtual row 和 ARIA 语义，接口以 trajectory-subagents.md 为准。

## 8. Skill 发现与打包

提供四个源 Skill：skills/research-core/SKILL.md、skills/domain-machine-learning/SKILL.md、skills/domain-data-science/SKILL.md、skills/venue-templates/SKILL.md。每个文件有合法 YAML frontmatter name 和 description，name 使用 kebab-case。静态插件 manifest 位于 plugins/research-core/.dsh-plugin/package.json。

构建要求：

1. 主插件运行时以 package URL 解析发布包内 skills，而不是假设 lib/skills 自动存在；
2. build 明确复制或生成 runtime skill assets，并有测试验证安装包内容；
3. SkillLocal providerName 唯一，includeDefaultRoots=false，customSkillDirs 显式，watch=false；
4. domain 和 venue skill 都要注册，不能只挂 research-core；
5. 静态 GitHub repository plugin 的 dsh.skills 列表包含全部需要发布的 roots；
6. .dsh-plugin/package.json 声明 prepare 所需的 dsh-repository-plugin 开发依赖；
7. generated dsh-plugin.mjs 和 assets 在发布包中存在，源码副本一致性有测试。

Domain/venue 选择必须由项目 brief.domain 和 target_venue 产生确定性 Skill 注入；不能只写在 Skill 正文期待模型自行发现。

## 9. 独立 Web UI

`@dsh-scholar/research-ui` 只发布独立 HTTP server、browser client bundle 和可执行入口。包不得声明 Cordis host export、`dsh.bundle.patch`、`dshClient` 或 DSH browser slots。客户端只通过同源 standalone BFF 读写 Kernel，不存在浮动面板或 DSH boot token fallback。

## 10. i18n 集成

独立 UI 内置 locale adapter，接口为 bind(namespace)、getSnapshot、subscribe、setLocale。选择顺序：有效 localStorage dsh.locale、navigator.languages、navigator.language、zh。支持 zh 和 en；存储故障不阻断启动。namespace lookup 顺序是 active locale、zh fallback、common active/zh、原 key。资源和完整规则见 gui-plugin-plan.md。

## 11. Standalone BFF

独立 HTTP server 在同源下提供 `/v2`、`/bff/research` 和迁移期 `/v1`。BFF 验证 bearer/Principal、same-origin、CSRF、Project AuthZ、限流和 body cap。Artifact 与 SSE 必须流式转发；不能对 upstream 调用 text() 后再返回二进制。`/research-api` 和 `/research-ui-api` 必须不存在。

## 12. Composition 与安装

根 package 的 dsh.bundle.patch 只插入 Agent `research-plugin` 行，不包含 UI row 或 browser client metadata。standalone UI 独立管理自己的 loopback server、BFF、Token、dataDir 和 Kernel sidecar。同一 dataDir 不得同时被 DSH Agent sidecar 和 standalone sidecar 打开。

静态 repository plugin 只承载 Skills/MCP，不能替代完整代码 bundle。安装验收必须使用全新 DSH_HOME 和远程或打包产物，不能只验证本地 symlink。

## 13. 开发模式的 Cordis self-referential 工具

DSH 的 @deepseek-ai/dsh-tool-cordis 提供 cordis_inspect、cordis_mount、cordis_unmount。它可在运行进程内检查服务、插件、工具、临时插件、接口和事件；执行一段临时代码挂载 dyn-N Cordis 插件；并等待 quiescence 后卸载该临时插件。

该能力只能通过显式开发 overlay 启用。dsh web --dev 只代表前端 HMR，不得隐式开启 self-referential 工具。

推荐新增 configs/research-dev-selfmod.cordis.yml：

~~~yaml
- insert:
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
      config:
        vmTimeoutMs: 5000
~~~

启动必须同时满足：

- 独立 DSH_HOME 和测试数据库；
- loopback Web；
- 人工交互、approval=ask；
- 非 unattended、非 production、非 shared team profile；
- 不注入 bash、fs、web、Kernel internal client、Runner key 等高风险服务，除非当前调试任务明确需要且再次审批；
- 每次 mount/unmount 保留 DSH tool/call、tool/result 和 dyn id 审计；
- 重启不恢复临时插件，重要修改必须转成普通源码、配置和文档变更。

cordis_mount 的 node:vm 和 Context façade 不是安全边界；同步 vmTimeoutMs 不限制所有异步行为。它应按 bash 等级管理。动态 plugin 启动失败必须 dispose；重复工具/服务冲突不得破坏旧注册；provider unmount 后 consumer 回到 pending；父 fiber、HMR 或退出必须级联清理。

生产 research-web、research-headless、根 cordis.patch 和发布包必须没有 tool-cordis 行。CI 同时验证开发 overlay 可 inspect→mount harmless dev_probe→下一轮调用→unmount，以及生产 composition 中三个 cordis_* 工具均不存在。
