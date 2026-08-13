# DSH 宿主集成规范

> 规范性文档。目标宿主是 DeepSeek Harness 当前 Cordis 架构。

## 1. 包与前置条件

根包名为 @dsh-scholar/research-plugin，ESM，导出 Cordis Agent 插件，并通过 `./client` 与 `dsh.client` 提供 DSH Web 半侧。该半侧向 Settings → Plugin config 注入 Scholar 配置卡，并向会话 `conversation.view` 注册 `dsh Scholar` 页签；页签只复用 standalone URL，不包含第二套业务 UI/BFF。宿主提供私有 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 以及 Host/Client 相关 DSH 包；这些 DeepSeek 包不假设存在于公共 npm registry。

开发环境通过 DSH_SCHOLAR_DSH_ROOT 指向 DSH checkout，脚本只建立可恢复的 symlink。生产运行由 DSH profile 的扁平 node_modules 提供同一 Cordis 实例，禁止打包第二份 Cordis。symlink/check-out 验证只用于开发反馈，不能计为宿主兼容性 PASS。

## 2. Cordis 插件形状

~~~typescript
export const name = 'research-plugin'
export const inject = ['tools', 'commands', 'subagents', 'settings']
export const Config = z.object({ /* DSH host-visible Schemastery schema */ })
export async function apply(ctx, config) { /* effect-scoped registrations */ }
~~~

所有工具、命令、事件、Skill provider、settings 注册和 sidecar 生命周期都有 disposer。`Config` 通过 Cordis Standard Schema 在 `apply` 前完成默认值和类型校验；Scholar 的严格适配层额外拒绝未知 root/kernel/standalone key，避免拼写错误静默进入运行时。Host 半侧除可选的 loopback connection RPC 外不依赖 `httpServer`、slots、LocaleFace 或 ThemeFace；浏览器半侧依赖 DSH Client runtime、connection、locale、settings、plugin-config 与 conversation slot。全局可变 toolContextRef 禁止；每个插件实例使用闭包保存 Client、RoleRegistry、Tenant 和 cache。

## 3. 目标配置

以下是 v2 生成目标。当前兼容层已把 v0.1 的 `kernel.host/port/dataDir/token`、`defaultMode`、`unattended`、`models`、`cacheDir` 以及 `standalone.url/shortcut` 暴露为 DSH 可发现的运行时 Schemastery schema：空配置生成 loopback/7412、gate-only、非 unattended、空 model map、`http://127.0.0.1:18610/` 与 `Alt+Shift+S`；端口、URL、快捷键和类型在 `apply` 前校验，token 标记为 secret，未知字段拒绝。插件在 `research-plugin` namespace 下注册该 schema作为 Host 内部持久化权威；浏览器卡片不依赖或修改 DSH 的 settings allowlist，而是通过 Scholar 自有 loopback-only connection RPC 读取仅含 `defaultMode`、`unattended`、`standalone` 的脱敏投影，并以 revision-fenced path mutation 写回。Settings → Plugin config 的卡片保存后在下一次 DSH 重启生效。`defaultMode` 已接入 `research_project create` 与 `/new`，显式调用参数仍优先；`full-auto` 继续要求注册 FixtureProfile。下列 skills/onboarding/trajectory/runner/config 字段仍是 v2 目标，差距记录在 hardening-v0.2-status.md。

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

命令直接注册为一级 slash command：`/help`、`/new`、`/list`、`/status`、`/survey`、`/ideas`、`/gates`、`/jobs`、`/reproduce`、`/contract`、`/run`、`/evidence`、`/claims`、`/write`、`/review`、`/release-bundle`、`/release`。DSH Web 保留 `/export` 用于下载 Session 日志，因此 Scholar 用 `/release-bundle` 生成私有 Release Bundle。DSH Command Registry 与 standalone parser 都不注册、不解析或兼容旧聚合前缀；帮助、补全、descriptor、文档与新审计 provenance 一律使用直接命令。

`/new` 是 name-only Init 引导入口；Grill 回答与 PI `/confirm-brief` 目前属于 authenticated standalone Human Chat/BFF 面，不冒充 Agent command。Agent Intake tool 只操作 observation/question/proposal，不提供 accept/adopt/merge-confirm 或任何 Gate Decision，最终 Adoption 与 Brief confirm 只能由 Human PI 完成。

自然语言 Chat 是 project-scoped turn adapter，不新增 `/research` 聚合 descriptor，也不改变上述 direct command Registry。DSH host 可用 agent/LLM loop 生成回答或 intent，standalone 可在无模型 adapter 时返回确定性阶段引导；两者都必须把 intent 映射到同一 canonical ResearchClient operation。模型不能直接调用 Gate Decision、Brief confirm、adopt 或 release decision，不能把 DSH session 状态当作 Kernel NextAction。

命令只是 ResearchClient adapter，不重复业务逻辑。它使用 invocation.agent.id 解析 session link。错误输出 research: 加稳定错误摘要，不能泄漏内部路径、Token 或上游响应。帮助文本与 i18n 资源生成；宿主命令描述若在注册时固化语言，locale change 时重新注册或保持语言无关。

本地开发可运行 `scripts/link-dsh-deps.sh` 解析当前 DSH checkout；脚本必须链接 `@deepseek-ai/*`（包括当前 DSH 的 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`）与 vendored `@cordisjs/*`/`cosmokit`，并且只替换因 DSH 包目录重组产生的 dangling symlink，不覆盖仍有效的链接或真实安装包。该链接只用于本地 typecheck，不能作为 DSH 兼容性 PASS；发布兼容性仍必须由 `tests/integration/run-dsh-private-registry-tests.sh` 在全新目录和全新 DSH_HOME 中安装固定私有 `@deepseek-ai/*` 包验证。

每个发布 Skill 的 YAML frontmatter 必须能被当前私有 `dsh-skill-filesystem` 严格解析；含 `: ` 等 YAML 指示符的 description 必须引用。兼容测试必须从 `ctx.skills.list()` 公共接口核对四个 Skill，而不能读取内部 provider collection。

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
3. SkillFilesystem providerName 唯一，includeDefaultRoots=false，customSkillDirs 显式，watch=false；
4. domain 和 venue skill 都要注册，不能只挂 research-core；
5. 静态 GitHub repository plugin 的 dsh.skills 列表包含全部需要发布的 roots；
6. .dsh-plugin/package.json 声明 prepare 所需的 dsh-repository-plugin 开发依赖；
7. generated dsh-plugin.mjs 和 assets 在发布包中存在，源码副本一致性有测试。

Domain/venue 选择必须由项目 brief.domain 和 target_venue 产生确定性 Skill 注入；不能只写在 Skill 正文期待模型自行发现。

## 9. 独立 Web UI

`@dsh-scholar/research-ui` 只发布独立 HTTP server、browser client bundle 和可执行入口。包不得声明 Cordis host export、`dsh.bundle.patch` 或 `dshClient`。根插件的 browser half 可以注册 DSH `conversation.view`，但 renderer 只能嵌入/启动该独立 URL；客户端仍只通过同源 standalone BFF 读写 Kernel，不存在 DSH boot token fallback。

## 10. i18n 集成

独立 UI 内置 locale adapter，接口为 bind(namespace)、getSnapshot、subscribe、setLocale。选择顺序：有效 localStorage dsh.locale、navigator.languages、navigator.language、zh。支持 zh 和 en；存储故障不阻断启动。namespace lookup 顺序是 active locale、zh fallback、common active/zh、原 key。资源和完整规则见 gui-plugin-plan.md。

## 11. Standalone BFF

独立 HTTP server 在同源下提供 `/v2`、`/bff/research` 和迁移期 `/v1`。BFF 验证 bearer/Principal、same-origin、CSRF、Project AuthZ、限流和 body cap。Artifact 与 SSE 必须流式转发；不能对 upstream 调用 text() 后再返回二进制。`/research-api` 和 `/research-ui-api` 必须不存在。

## 12. Composition 与安装

根 package 的 dsh.bundle.patch 只插入 Agent `research-plugin` 行；根 manifest 另声明 `dsh.client` 与 `./client`，由 DSH Web 模块宿主加载配置卡和 `conversation.view` 页签。页签是 standalone 的 iframe/新页面启动器，不插入第二个 BFF 或业务状态层。standalone UI 独立管理自己的 loopback server、BFF、Token、dataDir 和 Kernel sidecar。同一 dataDir 不得同时被 DSH Agent sidecar 和 standalone sidecar 打开。

Plugin config 编辑 `standalone.url` 与 `standalone.shortcut`，并提供显式“复制 standalone 访问 Token”。Host 通过 connection generic RPC 注册固定 `/dsh-scholar` channel，authority 必须是 loopback；`settings-snapshot` 只投影三个浏览器拥有的配置字段，`settings-mutate` 只接受这三个字段的 set/unset 并携带 expected revision，二者都不暴露 `kernel`、`models`、`cacheDir` 或任何 secret。`standalone-token` handler 只读取 `DSH_SCHOLAR_STANDALONE_DATA`（或默认 standalone dataDir）下固定文件名，不接受浏览器路径。浏览器只在用户动作中把成功响应直接交给 Clipboard API，随后丢弃；不能把该能力泛化为读取 `kernel.token`、service token、Provider SecretRef 或任意宿主文件。

Scholar 包尚未发布时，当前可用的用户安装路径是从本地 checkout 构建后加入 DSH profile：

~~~bash
source ~/.bashrc # 仅当 NPM_TOKEN 配置在这里
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add "$PWD"
dsh plugin --profile web why @dsh-scholar/research-plugin
dsh web
~~~

更新时重新 build 并执行同一 add；卸载使用 `dsh plugin --profile web remove @dsh-scholar/research-plugin`。`dsh plugin --profile web add @dsh-scholar/research-plugin` 只在包已发布且当前 registry 可解析后才是有效的用户安装路径。源码安装允许开发期链接当前 checkout；下文兼容性 PASS 仍必须使用 build + pack 后的 tgz 和空 profile，不能用该链接替代。

静态 repository plugin 只承载 Skills/MCP，不能替代完整代码 bundle。安装验收必须使用全新 DSH_HOME 和远程或打包产物，不能只验证本地 symlink。

私有宿主兼容性测试通过 `tests/integration/run-dsh-private-registry-tests.sh` 触发，固定输入为 `DSH_PRIVATE_REGISTRY_URL`、`DSH_PRIVATE_REGISTRY_TOKEN`（可显式选择受控的 `NPM_TOKEN` fallback）、精确版本 `DSH_PRIVATE_DSH_SPEC` 和已发布/可安装的精确 `DSH_SCHOLAR_PLUGIN_SPEC`；token 只写入权限 0600 的临时 npm userconfig，禁止进入仓库、命令行、日志或测试报告。测试必须在空目录安装真实私有 `@deepseek-ai/dsh` 及其 host 包，再经公开 `dsh plugin --profile … add`、profile boot/dump-config、Cordis apply/dispose 观察 Scholar。未提供私有 registry/credential/Scholar 安装 spec 的开发机输出 `NOT_RUN_MANUAL_PENDING`，不能计 PASS；真实 CI/人工执行一旦开始则缺包、版本漂移、symlink、checkout realpath 或生命周期失败必须非零退出。

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
