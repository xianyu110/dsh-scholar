# DSH Scholar 人工验收规范

> 规范性文档。开发阶段先实现完整代码；暂时无法连接的真实环境统一在这里组织后续人工验收，不以缺少 CI 阻塞代码开发，也不把未执行场景伪装成 PASS。

本规范采用“代码优先、人工后验”的两阶段方式。

- **MANUAL-BRAND-DSH-SCHOLAR**：分别打开中文和英文 Standalone 解锁页及主工作台，检查 Header、Sidebar、浏览器标题、Chat 欢迎/导出和 Settings 卡片。预期组合字标均为 `dsh Scholar`，不再出现 `dsh Research`，同时 `Research Kernel` 等技术名保持原样。

## 1. 适用范围

优先交给人工真实环境验证的场景包括：

- Chromium/Firefox/WebKit、桌面/窄屏、键盘与辅助功能；
- 真实 DSH host、Cordis self-referential mount/unmount、插件 reload/dispose；
- 本机 Docker、固定 TeX 镜像、PDF、clean-room bundle；
- 第二台远端机器、mTLS 证书链、断线/重连/吊销、Remote PTY；
- GPU、AV scanner、网络分区、双进程/长期 recovery 和多人身份撤权。

纯单元、模块契约、静态安全边界、Schema、迁移、i18n parity 和可在开发机稳定复现的错误不得推给人工环境；它们应在代码实现阶段自动验证。

## 2. 代码交付给人工前的条件

每个功能交付人工前必须具备：

1. 生产代码路径完整，无 placeholder、fake success、只在测试生效的分支或未接线接口；
2. 负责规范、API/Schema/迁移、i18n、`acceptance-tests.md` 和 hardening 已同步；
3. 当前机器能运行的 build、typecheck、unit、module contract 和 static checks 已运行并记录；
4. 每个真实环境场景有稳定 ID、前置条件、测试数据、操作步骤、预期结果、失败判据、清理方法和证据要求；
5. 未执行真实环境场景统一记 `NOT_RUN_MANUAL_PENDING`，hardening 状态最多为“已实现未验收”。

## 3. 人工验收记录模板

每轮人工测试复制以下模板形成同目录下 `manual-acceptance-YYYYMMDD-<short-sha>.md`：

~~~markdown
# Manual acceptance report

- commit: <full SHA>
- date/timezone: <ISO time + timezone>
- operator: <name/id>
- environment: <OS/browser/DSH/Docker/TeX/remote topology/config pin>
- secrets: <只记 SecretRef/证书指纹，不记录明文>

| scenario_id | result | actual | evidence | notes |
|---|---|---|---|---|
| <acceptance-tests.md ID> | PASS/FAIL/BLOCKED | <观察结果> | <日志/截图/Artifact 路径> | <清理/偏差> |

## Failures and follow-up

- 每个 FAIL/BLOCKED 对应的规范、acceptance 和 hardening 更新位置；
- 修复后需要重跑的最小场景集合；
- 未运行场景保持 NOT_RUN_MANUAL_PENDING。
~~~

截图只能辅助说明，不能替代场景步骤、实际结果和服务端日志。报告不得包含 token、私钥、cookie、原始 secret 或未脱敏 trajectory payload。

## 4. 当前人工验收队列

当前队列直接引用 [acceptance-tests.md §21](./acceptance-tests.md#21-2026-08-11-当前复审强制回归场景)：

1. 浏览器：Init/Resume/Upload/Grill、Workspace、Interactive Terminal、TeX live preview、Trajectory/Subagent Topology、Settings/i18n；
   - **Trajectory/Topology BFF 身份转发（TRAJ-01/SUBAGENT-01，acceptance-tests.md `topology-trajectory-bff-principal-forward`）**：以项目成员打开“轨迹”和“拓扑”，空数据必须显示合法空态，不得显示“桥接错误”；展开/分页/刷新仍可读取。用非成员项目验证统一 404、浏览器伪造 `x-principal-id` 不能改变结果；Network 中项目级 `/topology`、`/trajectory`、`/trajectory-lanes` 均应 200。2026-08-12 已用 Headless Chrome 在本地 `demo1` 验证 Topology 实际 DOM：无 `.error-banner`，显示“该项目还没有子代理节点。”；更深节点展开/键盘/视觉项仍记 `NOT_RUN_MANUAL_PENDING`；
   - **调研下一步 CTA（GUIDE-01，acceptance-tests.md `ui-survey-next-action-cta`）**：准备一个处于 SCOPED 的项目且 Brief.problem 非空；点击 Overview 的 `survey_run` 卡后，必须保持当前项目、打开 Chat 并仅预填 `/survey <problem>`，右侧/底部 Dock 的既有面板不得被误当成执行结果，Runs 数量与 Corpus/Outbox 在按 Enter 前不得变化；确认发送后核对 Corpus Snapshot 出现、项目进入 SURVEYING、下一步变为 `idea_generate`，刷新后不得重新显示 `survey_run`。同时覆盖空 problem（预填 `/survey `）、zh/en 文案和旧投影 `route=runs` 的兼容归一化。代码与 HTTP 自动回归已通过，真实浏览器视觉/键盘项记 `NOT_RUN_MANUAL_PENDING`；
   - **Chat 项目隔离（CHAT-SCOPE-01，acceptance-tests.md `ui-chat-project-isolation`）**：在项目 A/B 创建同名 session 和不同草稿/附件/引用，来回切换与刷新后核对零串线；在 A 发起慢命令和大附件上传后立刻切到 B，完成结果只能回到 A；再验证 Chat 主区→右 Dock→底 Dock 不改变当前 project context。代码完成前为 BLOCKED，代码完成后真实浏览器部分记 `NOT_RUN_MANUAL_PENDING`；
   - **全页面 Panel Dock（UI-DOCK-01，acceptance-tests.md §21 `ui-sidebar-dock-all-panels`）**：全部 13 个当前页面逐一执行主区→右侧→底部→主区/关闭；验证同页仅一活实例、右/底互换不 remount、pointer/键盘 resize、刷新恢复与损坏 storage 回退、1024/720/640 响应式、zh/en/theme/ARIA/focus；对 Chat 草稿/附件、Workspace/TeX dirty 与 Preview、Run Terminal/PTY/Trajectory 实时流分别验证状态与游标连续性。代码侧纯模型测试已完成，真实浏览器观感统一记 `NOT_RUN_MANUAL_PENDING`；
   - **Intake 向导视觉项（ONBOARD-01/UPLOAD-01/GUIDE-01，hardening §5 P1 行，acceptance-tests.md §21 `init-resume-intake-grill`）**：Start 屏三入口观感与「打开已有项目」列表（未选中项目时不自动跳 projects[0]）；导入向导 begin→stage（真实 multipart 上传与 32MiB 413 提示、已 staged 文件 verdict/删除/续传、sha256 幂等复用提示）→scan（summary/observations/rejected 拒因，archive 解包展开视图）→grill（问题表单与答案持久化）→propose（pre-accept 清单）→PI adopt（AdoptionReceipt，含 import_mappings 物化报告/CodeSnapshot 结果呈现）同页观感；刷新/重开页面断点续接；Overview 面板 intake_* NextAction 卡点击打开向导；zh/en 切换即时生效——全部记 `NOT_RUN_MANUAL_PENDING`（Playwright 类环境不可用）；**服务端 archive 解包扫描与 TeX/CodeSnapshot 采用物化已实现（2026-08-11，commit 98243ff）——属代码实现阶段自动验证部分，不再进入人工队列**（证据：tests/unit/intake-materialize.test.ts 15/15、intake.test.ts 32/32、pnpm test 1026/1026、research-kernel build 全绿、run-workspace-tests.sh 48/48、run-upload-tests.sh 18/18、verify-docs 19/19；语义见 research-onboarding.md §4.2/§6.1 注记）；
   - Manuscript P0-3（TEX-01/TEX-03，hardening §5 行）视觉项：打开/rerender/tab 往返零写入；保存→debounce→preview 状态（pending/queued/running/succeeded/failed/cancelled/superseded）与 stale 标识同页实时更新、PDF 自动刷新/下载；Regenerate 确认对话框与旧版本回退；权威 Compile 与 preview 面板分离；窄屏布局——全部记 `NOT_RUN_MANUAL_PENDING`（Playwright 类环境不可用），对应 acceptance-tests.md §21 `manuscript-open-never-regenerates` / `tex-save-live-preview`；
   - **Settings 视觉项（CONFIG-01/UI-02/UI-03，hardening §5 P1 行，acceptance-tests.md §21 `settings-schema-complete-i18n`）**：动态 Settings 同页观感——7 个 ConfigScope Accordion 组（global/project/job reserved/runner-profile/orchestrator/kernel/standalone）默认折叠与展开；每字段 effective 值/secret 掩码（"已设置,不显示明文"且明文零回显）/meta chips（scope、来源、热生效/需重启、安全基线、env）；config pin 显示与「config pin 已变化」提示（改动配置后重开 Settings）；只读注记与禁用提交按钮（"当前配置只读,经 CLI/env 提供"）；zh/en 切换即时生效且无缺 key；640/720/1024 视口——全部记 `NOT_RUN_MANUAL_PENDING`（Playwright 类环境不可用）；
   - **Trajectory/Subagent Topology 视觉项（TRAJ-01/SUBAGENT-01，hardening §5 P1 行，acceptance-tests.md §21 `trajectory-topology-browser`）——UI 逻辑层已实现（commit 98243ff）**：More →「轨迹」面板双 lane（Research 权威 / Session 观察）per-lane 分页与脱敏摘要/详情展开；More →「拓扑」面板直系树懒展开、breadcrumb 逐级返回、child 详情 + 只读历史、one-shot 只读 follow-up（message_id 回执）——证据 tests/unit/trajectory-ui.test.ts 32/32。**client SSE 消费已实现（commit 98243ff）**：双 lane 增量经 `TrajectoryStreamClient`（client/sse-client.ts）消费 `GET /v1/projects/{id}/trajectory/stream?after_seq=&lane=`（lane 过滤 + entry_id 去重；流失败回退 keyset 分页；离开 tab 关闭）。剩余浏览器验收（全部记 `NOT_RUN_MANUAL_PENDING`，Playwright 类环境不可用）：双 lane 滚动/虚拟化观感（10k 节点 DOM 有界）、树展开/键盘/ARIA、进入 child 与 follow-up 交互观感、跨项目 child ID 与撤权浏览器观感、SSE 增量流浏览器事件源观感；
   - **Workspace 视觉项（WORK-01 §5 P1，hardening §5 行，acceptance-tests.md §21 `workspace-browser-workbench` / `workspace-client-tree-tabs`）——Workspace tree client 逻辑层已实现（commit 98243ff）**：More →「工作区」面板（#tab=workspace 深链）——workspace 选择器 + 工具栏（新建文件/新建目录/上传/刷新/路径搜索框）；左侧文件树懒展开（目录点击展开/收起、虚拟空目录标记、文件行 hover 移动/删除）；右侧多标签编辑区（tab 栏 dirty ● 标记、textarea 编辑 + 保存按钮、保存 409 冲突横幅 + 重新加载、二进制只读 meta + 下载、历史版本列表 + 回退）；SSE watch 流实时增量刷新（`WorkspaceWatchClient`，client/sse-client.ts，消费 `watch/stream?after_revision=`；流不可用回退 listSince 5s 轮询；离开 tab 停止）——证据 tests/unit/workspace-client.test.ts 38/38。剩余浏览器验收（全部记 `NOT_RUN_MANUAL_PENDING`，Playwright 类环境不可用）：文件树渲染观感与拖拽上传、多标签视觉/冲突横幅观感、窄屏（640/720/1024）布局、键盘导航与 a11y；Problems 面板与集成 PTY 入口；SSE watch 流浏览器事件源观感（client 消费已实现，观感仍 NOT_RUN_MANUAL_PENDING）。
   - **Interactive Web Terminal（WEBTERM-01/PTY-01，acceptance-tests.md §21 `interactive-terminal-browser`）**：旧页面只有 plain-text output 和按钮控制，不能交互，明确视为缺陷而非视觉待验收。代码关闭条件是 xterm-compatible emulator、keyboard/paste/IME→bytes、ANSI/VT/alternate-screen、增量输出、auto-fit resize、dispose 生命周期及 adapter 回归；人工步骤是在真实 LocalPtyAdapter 中输入 `printf 'WEBTERM_OK\\n'`、Unicode、方向键/Tab/Ctrl+C，运行 `vim`/`top` 等 TUI，并在主区/右 Dock/底 Dock、640/720/1024 下验证。代码完成前是 BLOCKED；代码完成后真实浏览器部分仍记 `NOT_RUN_MANUAL_PENDING`，不能用 model 单测代替。
   - **SSE 实时流服务端/BFF（acceptance-tests.md §21「SSE 实时流替代轮询」，api-contracts.md §22，commit 98243ff）**：三个增量流端点（`/v1/pty/sessions/{id}/frames/stream`、`/v1/projects/{id}/workspaces/{wid}/watch/stream`、`/v1/projects/{id}/trajectory/stream`——text/event-stream、after_seq/after_revision 重放、live 追加、命名心跳、gap/exit 结束、鉴权与对应轮询端点一致（422 principal_required / 403 owner/lease / 404 未知或非成员 / 跨项目 404））+ BFF 透传（bearer 401、CSRF GET 豁免、非成员首字节前 404、x-service-token/x-principal-id 注入）已由自动化验收闭环：tests/unit/sse-streams.test.ts 7/7 + tests/security/run-sse-tests.sh 67/67（原 23 断言不破坏；三流 kernel/BFF 真 HTTP：首字节 event、after_seq 续传无重复、live、gap/exit、跨项目 404、无 token 401、非成员首字节前 404、BFF 透传）；轮询端点保留向后兼容。剩余人工项仅为浏览器事件源消费观感（三面板断线重连/心跳/续传观感），记 `NOT_RUN_MANUAL_PENDING`。
2. DSH：Agent plugin、subagent follow-up、Cordis self-mod 隔离与 lifecycle；
   - **Private host install（PACK-01/DSH-01，acceptance-tests.md §9.0/§21 `dsh-private-registry-install`）**：在隔离机器配置 `DSH_PRIVATE_REGISTRY_URL`、短期只读 `DSH_PRIVATE_REGISTRY_TOKEN`、固定 `DSH_PRIVATE_DSH_SPEC` 和已发布/可安装的固定 `DSH_SCHOLAR_PLUGIN_SPEC`，运行 `tests/integration/run-dsh-private-registry-tests.sh`；保存脱敏的包版本、DSH profile dump、boot/apply/dispose 与 realpath 报告。当前开发机没有真实私有 registry/credential/Scholar 安装 spec 时记 `NOT_RUN_MANUAL_PENDING`，本地 checkout/symlink/fake host 结果不得替代；
   - **Latest DSH + local artifact smoke：PASS（2026-08-13，重新 source `.bashrc` 后复跑）**：权限 0600 的临时 npm userconfig 认证通过，并从 npmjs.org 解析、安装精确 `@deepseek-ai/dsh@0.0.1-rc.2`；DSH realpath 位于全新 launcher。根插件及五个当前明确未发布的本地 `@dsh-scholar/*` 运行时包均重新正式 build + pack，根插件 `@dsh-scholar/research-plugin@0.1.0` 本轮 tgz sha256 为 `0edd23f11cda4b8ed7edfecdd0387bcb129a6bf73c3d4c5b20398e24986e1cef`。全部本地包以 tgz override 安装到临时 profile，没有 checkout realpath/symlink；插件与四个直接运行时依赖均为 profile 内 `0.1.0`，`dsh plugin why` 确认宿主工具图为 `0.0.1-rc.2`，profile dump 含 `research-plugin` 与 `kernel.port=0`，真实 DSH Web/Cordis 存活 8 秒、sidecar 物化 `kernel.db`，SIGTERM dispose 为 0；自动 packaging 回归为 `11/11`。单独根插件 tgz 尝试从 registry 解析未发布内部包时出现 404 属当前预期，不计本地兼容失败；等 Scholar 发布时再要求所有正式依赖由 registry 固定版本解析，并另记 published-registry PASS。凭据未进入 argv/报告，临时目录已删除。
3. Remote：容器隔离、mTLS、fencing、binary CAS、断线恢复、Remote PTY；
   - hardening §5 RUN-REMOTE-01 两行（2026-08-11 修复轮）代码侧已闭环的**真实环境剩余项**（记 `NOT_RUN_MANUAL_PENDING`，对应 acceptance-tests.md §21 `remote-secure-container-only` / `remote-identity-fencing-manifest` / `remote-cas-binary-auth` 的剩余段）：真实远端主机上 secure kinds 经 digest-pinned container 执行、无 docker 时 environment 失败且宿主 marker 未执行（`remote-secure-container-only`）；真实 mTLS service identity（CA/第二主机证书链）、证书轮换/吊销即时生效、两主机断线重连与故障注入、`remote-identity-fencing-manifest` 全链（assignment/job/run/owner/generation/token/manifest.run_id）在两台真实机器上核对（本地 wire 的 x-service-token 等价实现仅限本机测试）；两主机间二进制 CAS（随机字节/PDF/压缩包）往返 hash/size 一致（`remote-cas-binary-auth` 剩余）；Remote PTY 跨机 wire（`pty-owner-fencing-all-operations` 剩余）。
4. Reproduction：真实 Docker/TeX、Golden Path、Release Bundle、clean-room；
   - Code Snapshot P0-4（SNAPSHOT-01/API-01，hardening §5 行）端到端项：真实 golden-path Docker 全链（fixture 经项目 workspace 归档 → CAS 物化 → 容器执行）；浏览器/DSH 侧经 `workspace_snapshot` 工具以 workspace_id + root_relative_path 归档；旧 `{path}` 形状调用被 422 拒绝的实测记录；secret 文件（.env/token/key）混入工作区时快照被拒并列出文件名的实测记录——对应 acceptance-tests.md §21 `code-snapshot-approved-workspace-only`，记 `NOT_RUN_MANUAL_PENDING`（Docker/golden 环境可用时先跑 `evals/golden-path-v2/run-golden-v2.sh`）；
5. Recovery/Security：sidecar-kernel-bearer-required（真实 sidecar 实例上直接访问 kernel 端口的读写 401 负向、health 豁免、BFF/Runner/Orchestrator 用 token 全链）、撤权即时生效、多进程、kill/restart、长期 retention 与跨项目负向。
   - **Archived project delete（PROJECT-DELETE-01，acceptance-tests.md §21 `project-delete-after-archive` / `project-delete-archived-browser-i18n`）**：真实浏览器以 PI 归档项目后从收缩操作区删除，验证 exact-name 确认、zh/en、取消零写、删除后 list/get/深链 404 与 active selection 清理；重启 Kernel/standalone 后仍不可见；用两个项目引用同一随机二进制/PDF，删除其一并执行允许的 GC 后另一项目 hash/size/下载不变；验证 researcher/operator/auditor/viewer/被撤权成员负向、同 request id 重放、Outbox/retention/released Bundle 仍保留。真实浏览器与长期 retention/GC drill 当前记 `NOT_RUN_MANUAL_PENDING`；
   - **Workspace crash-recovery drill（WORK-01 §5 P2，hardening §5 行，acceptance-tests.md §21 `workspace-crash-recovery-idempotent`，记 `NOT_RUN_MANUAL_PENDING`）**：代码侧已闭环（`scanWorkspaceIntegrity()` 启动恢复扫描 + `workspaces.quarantine` 隔离，migration 0018；unit 11/11 + HTTP 真实进程 kill+重启段 3/3 已自动验证）。真实环境剩余项：对运行中 kernel 直接 `kill -9`（非 SIGTERM）打在写路径 rename/row 更新/delete unlink/row 删除/move rename/目标 row 插入的每个窗口，重启后确认——前滚/回滚/隔离判定与 unit 一致、隔离 workspace 503 且恢复字节后重启自愈、double 重启收敛、`.ws-tmp-*` 无残留；双进程同时打开同一 dataDir 的行为；长期（跨多天）重复 crash/restart 后的 ledger/revision 单调性与历史完整性。
   - P0-2（API-01/PTY-01，hardening §5 行）已在代码实现阶段自动验证的部分（不再进入人工队列）（真实 sidecar 实例上直接访问 kernel 端口的读写 401 负向、health 豁免、BFF/Runner/Orchestrator 用 token 全链）、撤权即时生效、多进程、kill/restart、长期 retention 与跨项目负向。
   - P0-2（API-01/PTY-01，hardening §5 行）已在代码实现阶段自动验证的部分（不再进入人工队列）：BFF global-id 解析（artifact/document/pty/events 跨项目 404、成员 200、猜 ID 404、无 scope events 404）、kernel PTY principal+owner+lease 强制（direct-kernel 负向矩阵）、membership 实时撤权（同一 BFF 移除成员后下一请求 404）——证据 run-standalone-http-tests.sh P0-2 段、run-hardening-tests.sh direct-kernel PTY 段、tests/unit/pty-session.test.ts 14/14；
   - §5 P1（GOV-01/ONBOARD-01，hardening §5 行）已在代码实现阶段自动验证的部分（不再进入人工队列）：PI-only capability route table（intake adopt、project archive/unarchive 加入 governance write 表）、BFF/Kernel 双层校验（researcher/viewer/auditor 403、非成员 404、缺 principal 422、pi/operator 全链 200）、kernel direct 负向矩阵、撤权后下一请求 404——证据 run-standalone-http-tests.sh §5 P1 段、tests/unit/kernel.test.ts v1 PI-only 矩阵、tests/unit/intake.test.ts 32/32；
   - 剩余人工项（记 `NOT_RUN_MANUAL_PENDING`）：浏览器 Interactive Terminal 真实 stdin/resize/INT/TERM/KILL/detach-reconnect/after_seq-gap 全链（acceptance-tests.md §21 `interactive-terminal-browser`）、多人/多进程真实撤权观感（`membership-revocation-no-stale-cache` 的浏览器侧）、researcher 角色 UX——浏览器视图不向 researcher 呈现 adopt/archive/unarchive 操作入口（`membership-revocation-no-stale-cache` 的 UI 侧）、Remote PTY 共用同一权限 wire 的跨机验证（`pty-owner-fencing-all-operations` 剩余）。

本地可复现项不进入人工队列（§1）：`workspace-permission-under-umask` 与 `ci-current-evidence-no-exclusion`（acceptance-tests.md §21）已在代码实现阶段自动验证并标记“已实现未验收”（hardening §5 WORK-01/CI-01 行），剩余仅 CI job 绑定；不记 `NOT_RUN_MANUAL_PENDING`。

## 5. 结果回写规则

- PASS：在 hardening 对应行记录 commit、场景 ID、环境和报告链接；全部阻断场景通过后才升级“已验收”；
- FAIL：先把缺陷和关闭条件写回负责规范、`acceptance-tests.md` 与 hardening，再修改代码；
- BLOCKED：说明缺失环境或权限，保持 `NOT_RUN_MANUAL_PENDING`，不能计 PASS；
- 新需求或修复建议：遵守 docs/README.md 的文档先行规则，不得只留在人工测试聊天或截图中。

## 6. 2026-08-12 新增人工队列：Init / Upload / Models

以下场景开发期不接真实环境，统一标记 `NOT_RUN_MANUAL_PENDING`（代码侧实现与自动证据见 hardening §3 INIT-GRILL-02 / CHUNK-01 / MODEL-01 行与 acceptance-tests.md §22/§23 标注，2026-08-12）：

1. `MANUAL-INIT-GRILL-I18N`：zh/en 浏览器仅输入 project name 创建；逐题 answer/edit/skip/unknown；中途刷新/换浏览器恢复；确认前零 Gate，PI confirm 后唯一 Gate；语言切换不丢输入，所有下一步/aria 正确。
2. `MANUAL-UPLOAD-2G`：至少 50 个混合材料与一个跨 8 MiB 边界文件；暂停、断网、刷新、重放同 chunk、gap/错误 hash；完成后 hash/页数一致；在可控环境分别验证 2 GiB 默认拒绝和配置到 10 GiB 的边界，保留服务端/浏览器报告但不上传材料内容。队列每文件独立显示 hashing/queued/uploading/paused/scanning/needs-input/ready/quarantined/failed，队列级显示总配额/进度/失败数与下一步；Chat 附件（按钮/拖拽/粘贴）进入同一 active Intake 队列且消息只保存 attachment/stage ref（浏览器观感与真实断网重连属本项）。
3. `MANUAL-EXECUTION-ENVIRONMENTS`：在 Settings 分别创建本机进程、本机 Docker、远程 SSH Target/Profile；验证 revision CAS、zh/en、secret 零回显和 safe health。trusted smoke 可选本机进程，formal 对本机进程必须拒绝；本机 Docker 验证 digest/non-root/read-only/network/resource；远程主机验证 host-key/SecretRef、容器同构、CAS/日志/Artifact、断网恢复。停机、错误 host key、撤权、能力不匹配时任务 blocked/retryable 且本机零执行；显式新 attempt 更换 target 后记录新 pin。保留脱敏 target revision/hash、RunManifest、日志和截图，不保存 credential。
3. `MANUAL-PROVIDER-SECRET`：接私有测试 Provider，创建/编辑/禁用与 restart；确认 SecretRef 明文不出浏览器、argv、日志、Trajectory/Bundle；验证非法 URL/redirect/DNS/proxy；项目选择只提交 ID，运行固定 revision/hash。
4. `MANUAL-OCR-PROVENANCE`：多页 PDF、扫描图片、中英混合、低置信度与 Provider 失败；无显式模型时不发请求、不回退；结果逐项显示 source/page/confidence，Grill 确认前不进入 Brief/Gate/Evidence。

每次 FAIL 先把 error code、重现条件和关闭验收补回 `init-grill-upload-models.md`、`acceptance-tests.md` 与 hardening，再修代码。

## 7. 论文复现、实验环境与 Session Terminal 人工队列

> 2026-08-12 实现轮注记：REPRO-01 代码侧已闭环（spec/attempt/report 存储与 API、纯比较器、verifier service identity、NextAction done 语义、`/reproduce` 一级命令——证据 tests/unit/reproduction.test.ts 33/33、migration 0022、run-hardening-tests.sh REPRO-01 HTTP 段；详见 hardening-v0.2-status.md §3 REPRO-01 行与 acceptance-tests.md §23 场景注记）。以下队列全部保留为真实环境验收（`NOT_RUN_MANUAL_PENDING`）。

1. `MANUAL-REPRO-PAPER`：用 DOI、arXiv 和扫描 PDF 各建一次 `/reproduce`；上传官方代码/数据并核对 source locator、commit/CodeSnapshot、license、environment pin；在真实本机 Docker 运行，比较论文目标指标/表/图并生成 Report。exit 0 + 指标越界必须显示 fail/inconclusive。
2. `MANUAL-REPRO-REMOTE-SSH`：Settings 以 SecretRef 登记两台远端 SSH Runner，验证 known-host/credential/health/revision/hash；选择 target A 执行并中途断网/重启；确认同 attempt 不落到本机/B，显式新 attempt 才可改 target。日志/浏览器/argv/Bundle 零 secret。
3. `MANUAL-CHAT-ATTACH-SLASH`：仅使用 `/new`、`/reproduce`、`/confirm-brief` 等直接命令；help/补全无 `/research`；按钮、拖拽、粘贴混合材料，暂停/刷新/恢复，scan/OCR/引用卡与 zh/en/aria 正确。
4. `MANUAL-SESSION-MULTI-PTY`：两个 Chat session、一个 Research session、父/子 subagent 各打开两个 PTY；切换/深链/detach/reconnect/resize/signal；确认输入只到对应 terminal。撤权、lease expiry、stale generation、跨 parent/跨项目全部拒绝；远端 PTY 复测同一 fencing。
5. `MANUAL-REPRO-MANUSCRIPT-CLEANROOM`：新 dataDir/无 checkout 隐式依赖环境重建 TeX/PDF，验证 Bundle preflight/hash、数据自包含、表图/PDF检查、signed RunManifest 与不可变 Report。

以上均为 `NOT_RUN_MANUAL_PENDING`，需要记录 commit、环境、操作者、期望/实际结果、Report/截图/日志引用。

## 8. 全页面 Panel Dock 人工队列

`MANUAL-PANEL-DOCK` 对应 acceptance-tests.md §21 `ui-sidebar-dock-all-panels`，当前状态为 `NOT_RUN_MANUAL_PENDING`：

1. 在 1024 px 视口选择一个项目，依次检查 Chat、Overview、Approvals、Runs、Artifacts、Evidence、Budget、Manuscript、Run Terminal、Trajectory、Topology、Workspace、Interactive Terminal；每页点击“停靠到右侧”，从 Dock 选择器换页，再点击“停靠到底部”“打开到主区”“关闭”；
2. 检查任一页面在主区与 Dock 不同时出现两个活实例；右侧/底部互换前后 DOM identity、焦点、滚动位置、Chat 草稿/附件卡、Workspace/TeX dirty/选中文件/PDF Preview 不变；
3. 对活动 Run Terminal、PTY、Workspace watch 和 Trajectory 分别在输出/事件持续产生时移动；右侧/底部互换不重连，主区/Dock 变换允许重连但必须从最后 seq/revision 续接，无重复、缺口或旧 DOM 继续写入；
4. pointer 拖动分隔条；键盘使用方向键、Home、End；核对 separator role、orientation、value/min/max、按钮 aria、关闭/打开后的焦点恢复；
5. 刷新后核对活动页面、首选位置、right/bottom 两种尺寸；写入未知版本、未知 panel、越界值和损坏 JSON 后刷新，必须安全回默认；记录不得包含 localStorage 中的 token 或任何研究内容；
6. 在 720 px 与 640 px 重复关键路径：窄屏 right 首选只视觉显示 bottom，扩大视口后恢复 right；左侧 Project Sidebar 与 Panel Dock 的控件和语义不能混淆；切换 zh/en、light/dark 后 Dock chrome 即时更新且面板状态不丢失。

验收报告必须逐项列出 PASS/FAIL/BLOCKED。任何 FAIL 先回写 product-spec.md §5.13、gui-plugin-plan.md §2.3、acceptance-tests.md 与 hardening，再修代码。

## 9. 调研阶段空运行与刷新焦点人工队列

1. `MANUAL-SURVEY-RUNS-SEMANTICS`：用真实 `/survey` 产生 frozen/complete Corpus Snapshot，确认项目进入 SURVEYING、NextAction 为 `idea_generate`、Jobs/Runs 为 0。zh 显示“调研已就绪”，en 显示“SURVEY READY”；Runs 空态说明调研已完成但尚无实验运行，Overview CTA 只导航不产生新对象。保存 projection/corpus/jobs/events 的脱敏摘要与 zh/en 截图。
2. `MANUAL-REFRESH-FOCUS`：在 auto refresh 开启下，依次聚焦 Project Sidebar 搜索、Chat composer、Terminal 搜索、Workspace editor/search 与 Manuscript editor；每个控件输入中英文和 IME 候选，把光标放在中间并设置选区/滚动。等待至少 17 秒并在另一会话触发一次 projection 更新，确认焦点、文本、选区、滚动和 dirty/草稿都不丢；focusout 后页面只补一次刷新。
3. 同时在 Run Terminal 和 Interactive PTY 产生持续输出；编辑控件聚焦期间 SSE/PTY 仍更新，PTY emulator DOM identity 不变。快速连点 Refresh/切换 locale/切换项目，确认延迟 API 响应不会乱序重绘。
4. `MANUAL-CHAT-NATURAL-TURN`：在 collecting 与 confirmed 项目分别输入普通中文/英文；collecting 只提交当前 Grill answer，confirmed 不得显示 unknown command。覆盖状态/想法/Gate/Jobs/Survey 同义句、歧义文本、Human-only 请求和附件内 prompt；保存解析 operation、执行/确认状态与最新 NextAction，确认无 Gate/adopt/release 绕过。
5. `MANUAL-CHAT-SCROLL`：先在底部等待两次刷新和新消息，确认继续贴底；再上滚到历史中间，记录首条可见消息和像素偏移，触发流式回答、投影刷新、locale 切换、main/right/bottom Dock 与 A/B 项目/session 往返，确认不回顶、不强拉底；点击“跳到最新”恢复跟随。
6. `MANUAL-WORKSPACE-TEX-FACADE`：在 Workspace 打开 manuscript 的 `paper.tex` 与 `main.bib`，确认 tree/read 均成功、大小为有限值或 `0 B`、编辑/保存/刷新后仍可读；Network 中 generic nodes read 为 200，真正缺失路径才 404。
7. `MANUAL-CHAT-SLASH-CARET`：在 DSH Chat 与 standalone Chat 中分别聚焦空 composer，逐键输入 `/`、`s`，在菜单初开与候选 settle 后核对焦点仍在原 textarea、caret 分别为 1/2、最终值为 `/s`；再覆盖全局 `/`、starter、命令面板和鼠标/键盘选择补全项，预填后继续输入必须追加在末尾。使用 IME、长按、后台刷新和会话切换重复，禁止 caret 跳到开头。
8. `MANUAL-ARTIFACT-PREVIEW-DOWNLOAD`：创建两个项目并登记相同 PDF 字节（共享 artifact/blob id），从两个项目各自的 Artifacts 页预览和下载；Network 必须含对应 `project_id` 且为 200，PDF 内嵌预览正常，下载名为登记文件名而非 `.bin`/artifact id。用 Range 请求验证 206、Content-Range/Accept-Ranges 与精确字节；切项目、关闭预览、连续打开多个产物后核对 Blob URL 全部回收。

以上真实 IME、多轮询、自然语言模型路由和持续流观感在人工完成前均记 `NOT_RUN_MANUAL_PENDING`；自动 headless 回归不代替本队列。

## 10. DSH Scholar 会话入口与 Token 复制人工队列

1. `MANUAL-DSH-SCHOLAR-VIEW`：启动本机 standalone 与 DSH Web，确认会话顶部顺序为 Chat、Trajectory、dsh Scholar；打开页签后出现同一 standalone 解锁/工作台页面，不创建 `/research-api` 或 `/research-ui-api` 请求。切换三页签后 Chat 草稿、焦点与 Trajectory 状态不丢。
2. 在 Plugin config 把 URL 改为允许的 loopback 地址，重启 DSH 后 iframe、显式“在新页面打开”和 `Alt+Shift+S` 必须同时指向新地址；新窗口必须无 opener/referrer。聚焦 Chat composer、Settings input、Workspace/TeX editor 与 Terminal 时按快捷键不得触发；IME composition、长按重复和插件 dispose 后也不得触发。
3. `MANUAL-DSH-CONFIG-COPY-STANDALONE-TOKEN`：打开配置卡但不点击复制，检查 DOM/aria/Network/Settings snapshot/URL/localStorage/sessionStorage/日志均无 Token；用鼠标和键盘分别显式触发复制，Clipboard 内容应精确通过 standalone `/api/token-check`，页面只显示“已复制”而不显示值。
4. 分别构造 Token 文件缺失、空值、超过上限、权限非 `0600` 与 symlink，确认 Clipboard 不变且仅显示本地化错误；拒绝 Clipboard 权限时不得创建 textarea/input fallback。确认 `kernel.token`、service token、Provider/SSH secret 无复制入口。
5. 切换 zh/en、light/dark 和窄屏，核对页签、iframe title、按钮、快捷键说明、复制成功/失败状态即时更新且键盘可达。记录截图和脱敏 Network/Host 日志，状态为 `NOT_RUN_MANUAL_PENDING` 直到真实浏览器完成。
