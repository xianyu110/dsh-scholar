# Research UI、实时终端与 TeX 工作台规范

> 规范性文档。文件名为兼容旧链接保留；内容是目标 UI 规范，不是未来计划。

## 1. 运行形态

完整科研浏览器 UI 的实现、HTTP host 与 BFF 只有 standalone 一份：本地 HTTP host、同源 BFF、全屏 UI、独立 Token 解锁，并内置 locale/theme adapter。DSH Agent 插件继续提供 tools、commands、Skills 和 Settings → Plugin config 配置卡，同时在会话 `Chat`、`Trajectory` 之后注册 `dsh Scholar` 页签。该页签只以受控 iframe 展示已配置的 standalone URL，并提供“在新页面打开”；它不是第二套 UI/BFF，不发布 legacy `dshClient`、不恢复 `/research-api` 或 `/research-ui-api` 桥，也不复制科研状态模型。

所有页面、状态模型、翻译 key、ResearchClient 和 UI 实现都只有一份。Shadow DOM 可以用于隔离独立 bootstrap 与工作区样式，不得再引入 DSH Web 宿主适配分支。

### 1.1 DSH 会话入口与 Plugin config

- 会话页签固定 `id=dsh-scholar`、顺序在 `Chat` 与 `Trajectory` 之后，标签、iframe title、按钮、状态和错误均支持简体中文/英文；页签卸载时清理 listener，不得抢占 Chat composer、Terminal、编辑器或任意 `input/textarea/select/contenteditable` 的焦点；
- standalone URL 是可配置项，默认 `http://127.0.0.1:18610`。只接受无 userinfo、无 query/hash 的 HTTPS URL，或 loopback HTTP URL；拒绝 `javascript:`、`data:`、非 loopback HTTP 和携带凭据/Token 的 URL；
- `Alt+Shift+S` 为默认全局快捷键，也可在 Plugin config 禁用。仅在非编辑状态、非 IME composition、非按键重复时触发；使用 `noopener,noreferrer` 打开新页面，且与页签内显式按钮指向同一规范化 URL；
- standalone 响应只允许已配置的 loopback DSH origin 嵌入；非白名单 ancestor 仍由 CSP 拒绝。iframe 使用最小 sandbox/referrer policy，不把 Token 放入 URL、postMessage、DOM attribute 或 boot manifest；
- Plugin config 提供“复制 standalone 访问 Token”。复制必须由用户 click/Enter/Space 显式触发，经 loopback-only Host RPC 读取固定 dataDir 下的 `standalone-token`；Host 必须拒绝 symlink、非普通文件、非 `0600`、空值和过大值；客户端只调用 `navigator.clipboard.writeText`，不得把 Token 放入 React state、DOM、aria、URL、日志、Settings snapshot、localStorage/sessionStorage 或 fallback textarea；
- 复制对象仅是 standalone access token，绝不是 `kernel.token`、Kernel/Runner service token、Provider SecretRef 或 SSH 私钥。Clipboard API 不可用/拒绝、Token 文件不安全或非 loopback 时只显示本地化失败状态，不回显 Token。

## 2. 布局

全局品牌字标固定为 `dsh Scholar`。主区域、Project Sidebar、Standalone 首屏、浏览器标题、Chat 和 Settings 复用同一语义，不允许局部回退成 `dsh Research`；技术组件 `Research Kernel` 与 research API 命名保持不变。

### 2.1 全屏

- 左侧 230 px Project Sidebar，可折叠到 44 px；
- 主区包含全局 header、项目 header、分组 tabs 和当前页面；
- 主区右侧或底部可以出现一个 Panel Dock；它承载当前业务页面，不取代左侧 Project Sidebar；
- 小于 720 px 时 Project Sidebar 变抽屉、tabs 横向滚动、右侧 Dock 视觉投影为底部、编辑器改上下分屏；
- 小于 640 px 时占满 viewport，不使用浮动阴影。

Project Sidebar：搜索、All/Active/Done/Archived、收藏、状态、创建、重命名、归档、恢复、详情、复制 ID。支持键盘和右键菜单，批量归档不能包含 running project。

Header：Kernel 状态、Human Gate 数、命令面板、快捷键、活动通知、语言、密度、主题、刷新。Kernel 不可用时显示持续 banner 和 Retry；不能只用 toast。

### 2.2 页面

首屏和主导航必须简洁。未选项目时不显示完整工作台 Tabs，只显示 Init、Resume、Upload 三张行动卡；选中项目后 primary tabs 只有 Overview、Workspace、Runs、Manuscript。Chat、Approvals、Run Terminal、Interactive Terminal、Artifacts、Evidence、Budget、Trajectory/Topology 从 More、上下文 CTA、命令面板或深链进入。Settings 使用齿轮进入独立页面，不占 primary tab。

| 分组 | 页面 | 说明 |
|---|---|---|
| Start | Init / Resume / Upload | 新研究、恢复平台项目、接入外部研究 |
| Research | Chat | 一级 slash command、附件/结果卡、会话与搜索 |
| Research | Overview | 唯一主 NextAction、状态、Brief、可折叠轨迹/拓扑 |
| Research | Workspace | VS Code 式 Explorer、编辑器、搜索、Problems、PTY |
| Execution | Approvals | Gate 筛选、Human Decision、理由和审计 |
| Execution | Runs | Job 列表、状态、Manifest、取消 |
| Execution | Terminal | 选择 Run，查看 stdout/stderr 实时流 |
| Execution | Interactive Terminal | 真实可输入 PTY，与 Run Terminal 分离 |
| Review | Artifacts | 项目产物搜索、预览、下载 |
| Review | Evidence | Claim–Evidence、CI、效应量、限制 |
| Review | Manuscript | TeX 文件树、编辑、编译、诊断、PDF |
| Operations | Budget | 用量、限制、策略和项目内容计数 |
| Operations | Settings | 所有配置、来源、revision/hash、SecretRef 和 diagnostics |

Tab 可收藏，Alt+1…9 切换。上表全部当前业务页面都必须提供“停靠到右侧”和“停靠到底部”入口；Panel Dock 内的页面选择器也必须覆盖同一组页面。URL 或持久 UI state 保存 active project/tab，但不能把 Token 放 URL。

### 2.3 Panel Dock 契约

- 任一时刻最多一个活动 Dock 页面；同一个页面在主区和 Dock 中不能同时存在，避免 Chat、PTY、Workspace、TeX 和流式面板出现双写或错投；
- 页面可从主区打开到右侧/底部 Dock，也可从 Dock 切换位置、关闭或打开回主区。右侧与底部切换只改变同一已挂载 surface 的布局，不重新执行页面 renderer；
- 主区与 Dock 之间切换时，Run Terminal、PTY、Workspace watch、Trajectory 等流式 adapter 先停止旧宿主，再携带 `after_seq`、`after_revision` 或模型已消费游标连接新宿主，确保无旧闭包继续写已离开的 DOM；
- Dock 默认右侧 420 px、底部 320 px；右侧允许 280–720 px，底部允许 180–640 px。分隔条支持 pointer drag、方向键、Home/End，使用 `role=separator`、正确 orientation、value/min/max aria；
- 本地持久化只保存 schema version、活动页面 key、首选位置和两种尺寸；解析失败、未知页面或越界值回默认。不得保存项目数据、草稿、token、secret 或服务端状态；
- 小于 720 px 时首选 `right` 的 Dock 按 `bottom` 渲染，但不改写持久化首选位置；重新回到宽屏后恢复右侧。所有 Dock chrome、tooltip、aria、空态和动作都来自 i18n 字典并随 locale 即时重绘；
- “Project Sidebar”专指左侧项目导航；“Panel Dock/页面侧栏”专指右侧或底部业务页面容器。实现、文档和翻译不得混用二者。

### 2.4 Start、路由与窄屏

- `/start`：三入口；Resume 按 updated_at 展示 status、pending Gate、下一步并恢复 last route；Upload 显示 preflight/进度/scan/Grill/Proposal；
- `/p/{id}/overview|workspace|runs|manuscript|approvals|artifacts|evidence|budget|trajectory|topology|settings`；
- `/p/{id}/runs/{run}/terminal` 是只读 Run Terminal；`/p/{id}/pty/{session}` 是 Interactive PTY；
- URL 只含 opaque ID；locale/layout/token/secret 不进 URL；未知或无权路由回可见项目列表并显示安全错误；
- 小于 720 px：Project Sidebar 为抽屉、右侧 Dock 有效位置为底部、Start 卡纵向、More 全屏菜单；小于 640 px：Workspace/Manuscript/Terminal 上下分屏或子页面，breadcrumb 和主要 CTA 固定可达。

## 3. 数据与刷新

- 项目投影默认每 8 秒刷新；页面隐藏时暂停，恢复可见立即刷新；
- 活动 Terminal 使用 SSE，不能由 8 秒轮询或本地逐字动画模拟；
- TeX save 使用 expected_version，build 使用 expected_document_revision；
- 请求可取消；页面从主区/Dock 离开或 Dock 关闭时清理 listener、Blob URL 和 stream，仍在可见 Dock 中的页面不得被普通 tab cleanup 错误停止；
- 401 只允许一次 session refresh 重试；之后回到解锁/登录，不无限循环；
- UI 不保存权威业务状态，只缓存选择、布局、草稿和 lastSeq。
- NextAction、Intake、Trajectory 和 Topology 都读取 Kernel/BFF projection；浏览器不从文案推断状态或因果；
- route/layout 可恢复，Panel Dock 本地偏好不进入 config pin；Token 不写 localStorage 普通 preference、URL 或导出文件。
- 8 秒背景刷新不得替换当前聚焦的 input/textarea/select/contenteditable/terminal emulator。用户正在输入或 IME composition 时，背景刷新延迟到 focusout，但 SSE/PTY/Terminal 流继续增量消费；手动操作或服务器终态必须重绘时，需恢复 ShadowRoot 内的 active element、选区/光标、输入滚动位置和可识别的焦点目标。
- 全局 render 必须串行化并合并重入请求；较旧的异步响应不得在较新 render 之后再次 `replaceChildren()`。为了恢复焦点，必须从页面 ShadowRoot 读取 `activeElement`，不能只读 `document.activeElement` 宿主节点。
- Chat/Workspace/Manuscript/搜索框的本地输入不能因为投影轮询丢失值、焦点、选区、undo/redo 或未提交的 dirty 状态；PTY 继续采用不重建 emulator DOM 的更严格契约。

## 4. Chat

支持会话新建、切换、重命名、固定、复制、归档、搜索、导出 JSON/Markdown 和最多 200 条本地 transcript。Chat session 必须携带 `project_id`，session 列表、active id、transcript、草稿、引用回复、附件引用和搜索状态按项目分区持久化；项目切换是显式 context switch，不得继续复用固定全局 storage key。异步命令和附件上传必须同时捕获 origin project + origin session，完成时只回写原项目；附件 `project_id` 与当前项目不一致时 fail closed。Chat 同时是 name-only Init 的 Grill Me 主界面：active Init Intake 时，自由文本每次回答当前唯一问题，服务端返回 next question、Brief preview 和下一步。模型文本和服务器 raw error 原样显示；问题 label、CTA、状态、已知错误、aria 等 UI chrome 翻译。

Composer 的输入分派顺序固定为：显式 `/...` → direct command；active Grill/current question → 单题 Human answer；其余 project-scoped prose → natural turn。Natural turn 先读取权威 `next_actions_v2`，再把文本解析为 canonical operation intent；status/ideas/gates/jobs/claims 等只读意图可直接执行，明确的 Agent 动作可在本次发送构成确认后执行，Human-only、blocked、unknown、歧义或参数不完整动作只返回候选命令/参数和可达页面，禁止浏览器或模型猜状态、Gate、revision 或 capability。没有可用模型调用 adapter 时也必须接受普通文本并返回确定性阶段引导，不能退回 `Unknown command`；模型可用时其回答仍不能改变 Kernel 投影或绕过 canonical operation。

DSH 页签中的 standalone iframe 通过 request-id 关联的 `postMessage` 请求 Host browser client，再由 loopback-only Scholar RPC 使用 Harness `ctx.llm` 完成无工具的一次对话调用。模型桥仅对与 Host 不同 origin 的 loopback standalone 开放；配置的远程 HTTPS 工作台可展示，但只能使用 deterministic fallback。standalone HTML 用 `frame-ancestors` 只允许 loopback embedder，iframe 使用 origin-only referrer，子页在发送任何 project/history 前必须从浏览器 `document.referrer` 确认父 origin 为不同 origin 的 loopback。父页面必须同时校验 iframe `contentWindow` 与配置的 standalone origin，已完成 request-id 在有界 128 项窗口内仍拒绝重放，且每个 iframe 最多一个 in-flight turn；iframe 只接受来自 `window.parent` 且 request-id 匹配的响应。父子两端 20 秒超时，iframe 卸载、URL 切换或 RPC 取消必须通过 `AbortSignal` 终止 Host LLM；不可用时立即回退确定性回答。请求最多携带最近 12 条、每条有界且在首次 await 前冻结的当前 project/session 文本以及裁剪后的 `project.status/brief_status/next_actions_v2`，禁止跨项目 transcript、附件字节和任何 secret。模型返回的候选 slash 必须由 direct descriptor allowlist 校验并排除 Human-only command，只渲染为“使用命令”按钮；点击仅把命令写入 composer 并把光标置于末尾，不自动发送。

Composer 输入 `/` 打开命令补全时，textarea 必须保持同一 DOM identity、焦点、selectionStart/selectionEnd 和输入方向；同步 draft publish、异步候选结算、菜单重绘和会话 mirror 都不得把 caret 移到开头。用户从全局 `/` 快捷键、starter、命令面板、模型建议按钮或补全项预填命令后，必须等异步重绘的新 composer DOM 出现，再恢复焦点并把 caret 显式放在预填文本末尾；不得使用一次性短延时假定重绘已完成。IME composition 与普通输入不触发页面级重绘或定时器争夺焦点。

每次 assistant 结果附带当前 phase、主要 NextAction、reason/required_by/阻断与一项 CTA。阶段引导更新不自动切换 tab；用户可继续编辑、追问或显式运行 slash。Slash descriptor、自然语言 intent 和 Overview CTA 最终共享 operation code/权限检查，不能分别维护互相漂移的 `/reproduce`、`/new` 或 `/status` 业务语义。

`.chat-stream` 的滚动策略按 project/session 和 main/dock surface 保存。初次打开或用户本来距底部不足 120 px 时，新增/流式消息后贴底；用户向上滚动后进入 history mode，新消息只显示“跳到最新”，后台 refresh/locale/rerender 必须恢复旧 `scrollTop` 或首条可见消息锚点。滚动恢复只能在 stream 挂载并完成布局后执行；禁止在 detached DOM 上设置 scrollTop 后再挂载。点击“跳到最新”或主动发送消息恢复 follow mode。项目/会话切换恢复各自锚点，右/底 Dock 互换保持同一 DOM，主区/Dock 重建也必须恢复对应 surface 状态。

内置命令直接为 `/help`、`/new`、`/list`、`/status`、`/survey`、`/ideas`、`/gates`、`/jobs`、`/reproduce`、`/contract`、`/run`、`/evidence`、`/claims`、`/write`、`/review`、`/release-bundle`、`/release`、`/confirm-brief`；`/export` 保留给 DSH Web 的 Session 日志下载，不注册、不解析、不展示旧聚合前缀。DSH 与 standalone 都只接受这些直接 descriptor。命令 descriptor 是 help/补全/执行/i18n 单一来源，description 保存 i18n key 并在渲染/搜索时按当前 locale 求值，禁止在 descriptor 中冻结英文。Composer 还支持附件按钮、拖拽和粘贴，多文件卡显示分块、scan、OCR 与 provenance；不渲染任意 HTML。

Chat 中的“运行中”只代表 HTTP 命令未完成。真正命令执行输出必须链接到 Run/Terminal，不在聊天中伪造流。

## 5. Overview

- 显示 14 个主路径阶段和 Block/Stop/Fail/Archive 状态；
- 当前阶段、完成比例、revision 和 status pill；
- Brief 问题、主指标、范围；
- next_actions 卡，空态明确是否等待 Gate；
- Idea 与 Contract 最近版本，点击详情；
- Budget 摘要与快速跳转；
- Project history 默认最近 10 条，可展开全部。

### 5.1 Next-step Guide

Overview 顶部始终显示一张 NextAction 卡：label、state、reason、required human/agent/runner、关联 Gate/Run/Build/gap、required revision 和一项主 CTA。状态为 available、running、waiting-gate、waiting-external、blocked、failed、completed；409 时刷新 projection 并显示最新决定/版本，403 解释只读，429/预算跳 Approvals/Budget，网络失败保留草稿并可重试。

CTA 必须进入能够完成该动作的界面，不能只按宽泛资源类别导航。`survey_run` 属于 Agent/connector 的 Corpus 动作而非 Runner Job：CTA 打开当前项目 Chat，使用 Brief problem 预填 `/survey ...` 并保留一次 Human 发送确认；禁止打开空 Runs 面板或在点击卡片时直接检索。命令成功后刷新 projection，SCOPED 必须变为 SURVEYING，下一张主卡必须变为 `idea_generate`。

短期 legacy string action 只显示 raw + “查看总览”；不能把字符串匹配成 mutation。Init 草稿、Upload、Grill、失败恢复和每个项目阶段都必须产生下一步；终态项目明确显示已完成/停止/失败以及可用的归档或审计动作。

未知服务器状态原样显示为中性色，不能丢失或硬翻译成错误状态。

## 6. Approvals

列表分 pending 和 decided，支持 type/status/search。Pending card 显示 Gate target 类型、ID、版本、summary、请求者、时间和 policy。

Approve/Reject/Revise 通过 Human BFF。UI 不发送 actor/principal；BFF 必须从登录身份构造完整 `principal` body（principal_id/tenant/auth_method/session）并注入 request_id，Kernel 不以仅有 `x-principal-id` 代替 Decision body Principal。Human BFF 从命中路由起即生成 request_id，预检和上游失败都以同一嵌套错误 envelope 返回它。Reject/Revise 强制 reason。Budget Gate 的 resume_to 来自 Gate payload 允许集合，不硬编码 EXPERIMENTING。提交期间禁用重复按钮，409 时刷新并显示已经决定者。任意非 2xx 必须显示后端稳定 error code/可执行提示，不能把 `principal_required`、403、404、409、422 和网络失败统一显示成“桥接错误”。

批量决定默认关闭；若启用，每个 Gate 独立确认且失败不伪装原子批量。

## 7. Runs

按 queued、running、retryable、succeeded、failed、cancelled 筛选。每行显示 kind、contract、snapshot、status、attempt、lease heartbeat、failure class、时间和 id。详情显示 JobSpec、RunManifest、Artifact refs、资源、签名状态和审计。

Cancel 仅对 queued/running/retryable 可见，要求 reason 并通过 BFF。UI 显示“取消请求中”直到 Runner 确认实际进程/容器停止；HTTP 返回不能提前伪装 cancelled。

每个 Run 有“打开终端”动作；running Run 可自动打开，历史 Run 可重放。

Runs 是“实验作业/运行”投影，不是研究阶段活动日志。项目位于 `SURVEYING` 而 `jobs=[]` 时，阶段 pill 使用“调研已就绪 / Survey ready”这类非进行时文案；Runs 空态显示“调研已完成，尚未创建实验运行”并提供“前往总览查看下一步”；CTA 只导航到 Overview，由 `next_actions_v2` 决定 `idea_generate`，不自动执行。其他无 Job 阶段继续显示通用空态，筛选无匹配与真正零 Job 必须区分。

## 8. Terminal

### 8.1 视图

- 左侧或顶部 Run 选择器，默认活动 Run；
- All、stdout、stderr 三个通道；
- monospace、ANSI 白名单颜色、横向滚动、默认不软换行；
- 状态栏显示 connecting/live/reconnecting/exited、cwd display、总字节、截断、exit code 或 signal；
- auto-scroll 可暂停，用户向上滚动自动暂停并显示 Jump to latest；
- copy visible、copy all retained、download full log；
- 搜索、行号可选、最大渲染行数，展开不会无限占内存；
- cancel 与 Runs 共享同一操作；
- 键盘和屏幕阅读器可读取状态变化，不逐字符朗读高频输出。

### 8.2 流与恢复

打开时读取本地 lastSeq 并连接 Terminal SSE。chunk 按 seq 去重和排序；断线指数退避，恢复携带 after_seq。收到 gap 显示永久警告和 dropped bytes；收到 truncated 显示最终日志不完整。exit frame 或权威 Job 终态才结束 running 状态。

切换 Run 关闭旧 stream；隐藏页面可以保留轻量连接或关闭后恢复，策略必须有界。Terminal 输出通过 text nodes 或安全 ANSI parser 渲染，绝不使用 innerHTML。

### 8.3 Interactive Terminal

Interactive Terminal 使用 xterm-compatible adapter 连接真实 PTY，必须支持键盘/粘贴/IME/Unicode 输入、ANSI/VT 光标与 alternate-screen TUI、容器尺寸自动 fit、resize、INT/TERM/KILL、detach/reconnect、显式 close、状态/exit、backpressure/gap。终端 emulator 的 `onData` 必须进入 PTY bytes control，PTY output 必须增量写入同一 emulator，禁止每帧 `replaceChildren()` 重建、禁止用普通 textarea/逐行 `textContent` 冒充终端。连接前选择 Workspace、relative cwd、Runner profile 和受控 shell preset；hostname、SSH credential、Docker socket、host path 和任意启动 argv 不出现在页面。

Web Terminal renderer 必须在主区和 Panel Dock 中保持同一活实例；右/底 Dock 互换不 dispose，主区/Dock 变换可按 `after_seq` 重建并续接。ResizeObserver/fit 只在列行实际变化时发送 resize，离开页面或关闭会话时释放 emulator、observer 和 input listener。gap/exit/lease/权限错误作为独立安全状态显示，不能作为不可信 ANSI 字节写入 terminal control channel。

Terminal 按权威 Research/Chat/Subagent context 分组，每个 context 可有多个 PTY tab。Chat 与 Topology 的“打开终端”携带 server-resolved context，深链为 `#tab=pty&session=<pty_id>`；切换 context 不复用输入目标。所有 input/resize/signal/attach 携带 expected generation，并校验 owner、lease expiry 与 exact-parent capability。

页面持续显示“交互会话不能产出正式 Evidence”。权限撤销、generation stale、idle TTL、target offline 和 parent session failure 都有可恢复状态；关闭浏览器不是成功退出。Run Terminal 不出现输入框，Interactive PTY 不显示为正式 Run 日志。

### 8.4 Workspace Workbench

桌面布局为 Explorer/Search、可多标签编辑区、Problems/Output/Terminal 下方面板；小屏改为树→编辑器→面板的可返回 navigation。支持 create/read/write/move/delete/upload/download/history/watch/search/snapshot，文本行号/高亮/查找替换/撤销重做/快捷键，图片/PDF/JSON 安全预览，大文件/未知二进制只读。

保存与上传显示 file/workspace revision 和 hash；409 提供 base/current/local 或 keep/current/import/rename，禁止覆盖。所有路径根相对；Workspace 中的 Terminal 打开独立 PTY。Monaco/CodeMirror 是可替换 Adapter，不得在 Kernel contract 中出现。

### 8.5 Trajectory 与 Agent Topology

Overview 提供折叠摘要，全页支持 Research/Session 两条泳道、Timeline/Table 和 Tree/Graph。Research 标记 authoritative，Session 标记 observational。subagent 节点显示 role、mode、activity、duration、四桶 token/cost、failure、children；展开懒加载直接 child，点击进入安全 history，breadcrumb 返回 parent。

one-shot/diagnostic/parent offline 只读；continuable 仅在 `can_continue` 时显示 composer。history 读取不激活 Agent；默认不返回 raw prompt/tool args/results/env。>100 rows 虚拟化，10k nodes DOM 有界，prepend 保持 scroll anchor；orphan/cycle fail-soft，普通 fork 不跨边界汇总。详细契约见 trajectory-subagents.md。

## 9. Artifacts

按 kind、名称、ID 和 metadata 搜索，显示 media type、大小、hash、时间和 provenance。预览规则：

| 类型 | 行为 |
|---|---|
| text/json/log/tex/bib | textContent，截断，可下载 |
| PDF | Blob URL embed，application/pdf，下载/新窗口 |
| raster image | Blob URL img |
| SVG | 仅以 img 隔离预览；禁止新标签页顶层打开，禁止 inline script |
| HTML | 不预览，只下载 |
| binary/model | 元数据和下载 |

Artifact 列表、预览、单文件下载、批量下载和 Range 请求全部携带当前 `project_id`；共享 CAS blob 不得依赖无 scope 的全局反查。下载文件名优先使用服务端安全 `Content-Disposition`/artifact `file_name`，不得退化为 artifact ID 或无条件 `.bin`。BFF 透传 `Content-Range`、`Accept-Ranges`、`Content-Disposition`、ETag 与媒体类型，保持 206/416 语义。关闭 modal、切项目和卸载时 revoke 全部 Blob URL；独立代理必须保持二进制，禁止先 text()。

## 10. Evidence

Claim 列表显示 statement、status、confidence、supporting Evidence、analysis artifact、limitations 和 history。Evidence 显示 provenance_status，不得把所有行固定标为 verified。

Effect 图明确 0 基线、方向、CI、n、adjusted p 和 metric unit。只读页面不能让普通用户直接把 draft 转 accepted。原始动态 statement、server error、论文文本不翻译。

## 11. Manuscript Workbench

### 11.1 布局

桌面三栏：文件树 220 px、编辑器弹性宽度、Preview/Diagnostics 360–45% 可调整。小屏为 Editor、Preview、Diagnostics 子 tabs。

Header 显示 document、revision、保存状态、当前 build、PDF freshness、Compile、Review、Download PDF、Export Sources。

### 11.2 文件树

- 支持 .tex、.bib、.sty、.cls、图片和 generated figures；
- 新建、重命名、删除、上传、下载和历史；
- 路径显示根相对形式，拒绝绝对路径和 ..；
- 未保存、冲突、构建输入、generated/readonly 使用不同标识；
- 引用的 Artifact 图表可“添加到 figures/”，产生新 workspace revision。

### 11.3 编辑器

首版可以使用受控 textarea/code editor；后续可接 Monaco/CodeMirror，但接口不变。必须支持行号、定位行列、查找替换、撤销重做、Tab、TeX/BibTeX 基本高亮、脏状态和 Ctrl/Cmd+S。

保存携带 expected_version。409 冲突展示 base/current/local 三方信息，允许复制、重新加载或显式合并；禁止静默覆盖。离开未保存文件需确认。自动保存若启用使用 debounce 且仍执行 version CAS。

### 11.4 编译

Compile 先保存所有脏文件，再冻结 workspace manifest 并提交 latex-compile Job。按钮显示 queued/running/succeeded/failed/cancelled。Build terminal 复用 Terminal 组件并默认 stderr/all。

保存失败（409 document_version_conflict）或 document revision 前进时，Compile 必须立即终止，不得以旧 revision 冻结或创建 Job；queued/running 期间 Compile 按钮禁用（防重复提交，kernel idempotency_key 兜底）。冻结的 manifest 连同每文件字节按 revision 存入 snapshot store；构建输入是冻结 revision 的可物化字节，编译期间的新编辑只前进 document revision 并让旧 PDF 显示 stale，绝不改变本次构建输入。build 卡片展示输入 revision 与 job_id，点击可跳到同一 Job 的实时 Terminal（SSE GET /v1/jobs/{job_id}/terminal）。

诊断按 error/warning/info 分组，显示 file:line:column、pass 和消息；点击定位编辑器。诊断 parser 的本地 code 可翻译，TeX 原始消息保留。undefined citation、missing file、overfull box 和 shell-escape 拒绝有专门类型。

成功保存后按 Settings debounce 自动创建 preview build；状态、编译输出和 diagnostics 实时更新，成功即刷新 PDF。新编辑立即把当前 PDF 标 stale；旧 preview 被新 revision supersede。显式 Compile 仍冻结 manifest 并创建权威 Job，不能被 preview 取消或替代。

### 11.5 PDF

成功后以安全 Blob URL 预览 PDF，显示页数可选、下载和新窗口。Preview 顶部显示 build input revision；源文件改变后显示 stale banner，仍允许查看旧 PDF，但不能标记最新。切换 build history 可比较不同 PDF/log。

## 12. Budget

显示模型费用、GPU 小时、API 请求、存储和并发。低于 80% 用正常色，80–100% 警告，超过 100% 错误。越限说明 BLOCKED_GATE 和恢复 Gate，而不是只显示红条。

详情显示数据策略、网络、Runner、完整性、签名和 clean-room 要求。

### 12.1 Settings 渐进披露

Settings section 首次全部折叠：Essentials、Models & OCR、Execution advanced、Workspace、Terminal、LaTeX、Agent & Trajectory、Security & Secrets、Diagnostics/Config provenance。每项由 Config Schema 生成，显示 effective value、source scope/revision/hash、default/modified、hot/restart、允许范围和 Reset；secret 只显示 SecretRef 与是否可用。Provider 在 global 组管理 endpoint/capabilities/catalog/SecretRef，项目只选 provider/model ID。

Execution advanced 内含可编辑 Runner Target/Profile Registry：目标类型明确显示“本机进程（仅 trusted dev/smoke）”“本机 Docker”“远程 SSH”，配置 label、capabilities、resource/network policy、enabled/draining 与 revision/hash；remote-ssh 表单只提交服务端连接配置和 SecretRef 元数据，私钥/token 不回显。项目和实验只用 opaque target/profile picker，显示健康/能力与 pin；offline、host-key mismatch 或 capability mismatch 给出可操作阻断信息，不提供隐式本机回退按钮。所有 label、validation、secret availability、health、aria 具备 zh/en parity。

Start 的 New Project modal 只含 project name；创建成功立即进入 Chat Grill。Upload 是多文件队列，支持 8 MiB 分块、暂停/恢复/取消、offset/hash 冲突、扫描和 OCR 状态。配置项收缩在 Settings 折叠组，不在创建流程铺开。切换语言不得清空项目名、当前 Grill answer 或队列。

业务页只显示当前策略摘要和“调整”链接，不常驻展开高级项。运行中 Job/PTY/Build 标注 pinned config hash，修改配置只影响新动作。Patch 使用 revision CAS，409 展示 base/current/local；不支持的 target/capability 不隐藏成默认值。

## 13. i18n 硬约束

### 13.1 语言与资源

首发 locale：zh、en。资源目录必须为：

~~~text
packages/dsh-research-ui/src/client/i18n/locales/
  common.ts
  shell.ts
  overview.ts
  approvals.ts
  runs.ts
  terminal.ts
  artifacts.ts
  evidence.ts
  manuscript.ts
  budget.ts
  standalone.ts
  start.ts
  guide.ts
  workspace.ts
  settings.ts
  trajectory.ts
  topology.ts
~~~

每个 namespace 导出 zh 字典，keyof zh 作为 key 类型，en 必须精确完整。Key 使用语义点号，如 terminal.status.reconnecting、manuscript.build.stale、common.action.cancel。禁止使用英文原句作为 key。

所有用户可见 chrome 都必须来自 t(key, params)：标题、Tab、按钮、placeholder、aria-label、tooltip、空态、错误摘要、toast、状态 label、设置、快捷键、独立解锁页和 `<html lang>`。动态项目名、Gate title/summary、论文内容、命令输出、TeX 原始诊断、模型文本和 wire error 原样显示。

### 13.2 查找与切换

查找顺序：当前 namespace active locale、当前 namespace zh、common active/zh、原 key。缺失 key 原样显示且开发模式记录一次 warning，不能返回空字符串。

选择顺序：有效 localStorage dsh.locale、navigator.languages、navigator.language、zh。支持 zh-CN/zh-Hans 映射 zh、en-US/en-GB 映射 en。设置中可手动切换；setLocale 持久化并增加 revision，所有已挂载页面、modal、aria 和通知 chrome 立即重渲染。

独立 UI 实现 bind、getSnapshot、subscribe、setLocale 的本地 locale adapter。同一应用实例二次安装 locale adapter 是 assembly error。

### 13.3 插值、复数和格式

插值只使用 {name}，未提供参数保留 placeholder。复数使用显式 .one/.other key 和调用点分支，不假设 ICU。

日期、时间、数字、货币、百分比、文件大小和相对时间必须显式传 active locale 给 Intl formatter 或使用翻译单位 key；禁止 toLocaleString(undefined) 导致切换后混合语言。状态 enum 映射翻译 key，未知值回退原字符串。

### 13.4 i18n 验收

- 静态检查阻止 JSX/DOM 中新增硬编码 chrome；
- zh/en key 集完全一致；
- persisted locale 优先于浏览器，regional locale 映射正确，storage 失败不阻断；
- 切换 locale 后所有已打开 modal、Terminal 状态、TeX 诊断 chrome 和 aria 更新；
- 切换 locale 后已打开 Panel Dock 的标题、页面选择器、位置动作、关闭/打开主区动作和 separator aria 同步更新，不能重建或丢失面板状态；
- standalone 解锁页在首次渲染前选择 locale；
- Start/Upload/Grill、NextAction、Workspace、Settings、Trajectory/Topology 和 PTY 的所有状态/错误/aria 都有 zh/en 精确 parity；
- 动态研究内容和 Terminal 字节不被翻译；
- 所有页面在 zh/en 下无溢出、截断和不可点击控件。

## 14. 主题与偏好

支持 light/dark/system、accent、radius、texture、density、Project Sidebar collapsed、Panel Dock open panel/position/right size/bottom size、favorite tabs/projects、auto refresh、locale，全部由独立 adapter 管理。Panel Dock 只属当前浏览器展示偏好，不进入 Kernel Config Registry/config pin。Token 与普通偏好分开存储；Reset preferences 不删除认证 Token，除非用户明确选择 Sign out。

## 15. 可访问性

- Dialog 有 role=dialog、aria-modal、标题、focus trap、Escape 和焦点恢复；
- Tabs、menu、listbox、tree、editor、terminal 使用正确语义；
- Panel Dock 使用命名的 complementary region；可调整边界使用 separator 语义、正确方向和值域，并支持方向键与 Home/End；移动/关闭后焦点回到可见页面或触发按钮；
- 所有 icon button 有翻译后的 aria-label；
- 颜色不是唯一状态标识；
- 键盘可完成创建项目、Gate、Run、Terminal、编辑保存、编译和下载；
- reduced-motion 禁用本地渐进 reveal 和非必要动画；
- toast 使用 aria-live polite，致命连接错误使用 assertive 但不重复刷屏。

## 16. 安全与性能

- 禁止 innerHTML；Markdown、ANSI、SVG 分别走白名单 renderer；
- 每个列表虚拟化或设置有界窗口；
- Terminal、Transcript 和日志有最大内存；
- 搜索 debounce，异步响应用 request identity 防止旧结果覆盖；
- Modal、SSE、interval、event listener、Blob URL 全部在卸载时释放；
- BFF Token、CSRF 和 Project AuthZ 规则见 security-baseline.md。
