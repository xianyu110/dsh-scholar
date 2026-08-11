# DSH Scholar 人工验收规范

> 规范性文档。开发阶段先实现完整代码；暂时无法连接的真实环境统一在这里组织后续人工验收，不以缺少 CI 阻塞代码开发，也不把未执行场景伪装成 PASS。

本规范采用“代码优先、人工后验”的两阶段方式。

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
   - **Intake 向导视觉项（ONBOARD-01/UPLOAD-01/GUIDE-01，hardening §5 P1 行，acceptance-tests.md §21 `init-resume-intake-grill`）**：Start 屏三入口观感与「打开已有项目」列表（未选中项目时不自动跳 projects[0]）；导入向导 begin→stage（真实 multipart 上传与 32MiB 413 提示、已 staged 文件 verdict/删除/续传、sha256 幂等复用提示）→scan（summary/observations/rejected 拒因）→grill（问题表单与答案持久化）→propose（pre-accept 清单）→PI adopt（AdoptionReceipt）同页观感；刷新/重开页面断点续接；Overview 面板 intake_* NextAction 卡点击打开向导；zh/en 切换即时生效——全部记 `NOT_RUN_MANUAL_PENDING`（Playwright 类环境不可用）；
   - Manuscript P0-3（TEX-01/TEX-03，hardening §5 行）视觉项：打开/rerender/tab 往返零写入；保存→debounce→preview 状态（pending/queued/running/succeeded/failed/cancelled/superseded）与 stale 标识同页实时更新、PDF 自动刷新/下载；Regenerate 确认对话框与旧版本回退；权威 Compile 与 preview 面板分离；窄屏布局——全部记 `NOT_RUN_MANUAL_PENDING`（Playwright 类环境不可用），对应 acceptance-tests.md §21 `manuscript-open-never-regenerates` / `tex-save-live-preview`；
   - **Settings 视觉项（CONFIG-01/UI-02/UI-03，hardening §5 P1 行，acceptance-tests.md §21 `settings-schema-complete-i18n`）**：动态 Settings 同页观感——7 个 ConfigScope Accordion 组（global/project/job reserved/runner-profile/orchestrator/kernel/standalone）默认折叠与展开；每字段 effective 值/secret 掩码（"已设置,不显示明文"且明文零回显）/meta chips（scope、来源、热生效/需重启、安全基线、env）；config pin 显示与「config pin 已变化」提示（改动配置后重开 Settings）；只读注记与禁用提交按钮（"当前配置只读,经 CLI/env 提供"）；zh/en 切换即时生效且无缺 key；640/720/1024 视口——全部记 `NOT_RUN_MANUAL_PENDING`（Playwright 类环境不可用）；
   - **Trajectory/Subagent Topology 视觉项（TRAJ-01/SUBAGENT-01，hardening §5 P1 行，acceptance-tests.md §21 `trajectory-topology-browser`）——UI 逻辑层已实现（commit 待定主代理统一提交）**：More →「轨迹」面板双 lane（Research 权威 / Session 观察）per-lane 分页与脱敏摘要/详情展开；More →「拓扑」面板直系树懒展开、breadcrumb 逐级返回、child 详情 + 只读历史、one-shot 只读 follow-up（message_id 回执）——证据 tests/unit/trajectory-ui.test.ts 32/32。剩余浏览器验收（全部记 `NOT_RUN_MANUAL_PENDING`，Playwright 类环境不可用）：双 lane 滚动/虚拟化观感（10k 节点 DOM 有界）、树展开/键盘/ARIA、进入 child 与 follow-up 交互观感、跨项目 child ID 与撤权浏览器观感、SSE 实时流；
   - **Workspace 视觉项（WORK-01 §5 P1，hardening §5 行，acceptance-tests.md §21 `workspace-browser-workbench` / `workspace-client-tree-tabs`）——Workspace tree client 逻辑层已实现（commit 待定主代理统一提交）**：More →「工作区」面板（#tab=workspace 深链）——workspace 选择器 + 工具栏（新建文件/新建目录/上传/刷新/路径搜索框）；左侧文件树懒展开（目录点击展开/收起、虚拟空目录标记、文件行 hover 移动/删除）；右侧多标签编辑区（tab 栏 dirty ● 标记、textarea 编辑 + 保存按钮、保存 409 冲突横幅 + 重新加载、二进制只读 meta + 下载、历史版本列表 + 回退）；listSince 5s 轮询增量刷新（离开 tab 停止）——证据 tests/unit/workspace-client.test.ts 32/32。剩余浏览器验收（全部记 `NOT_RUN_MANUAL_PENDING`，Playwright 类环境不可用）：文件树渲染观感与拖拽上传、多标签视觉/冲突横幅观感、窄屏（640/720/1024）布局、键盘导航与 a11y；Problems 面板与集成 PTY 入口；SSE 实时流替代轮询（后续轮）。
   - **Interactive Terminal 视觉项（PTY-01，hardening §5 P1 行，acceptance-tests.md §21 `interactive-terminal-browser`）——PTY TUI client 逻辑层已实现（commit 待定主代理统一提交）**：More →「PTY 终端」面板（#tab=pty 深链）——open 表单（workspace/preset/cwd/cols/rows + 钉定 profile/target）→ 会话工具栏（resize、INT/TERM/KILL、detach/reconnect、close）→ 纯文本输出区（gap/retention 截断标记、exit 行）→ 状态行（状态/in-out seq/掩码 lease+过期/generation/字节数、idle TTL/lease 过期/权限撤销 close-reason 提示、lease 失效错误提示重新打开）——证据 tests/unit/pty-client.test.ts 36/36。剩余浏览器验收（全部记 `NOT_RUN_MANUAL_PENDING`，Playwright 类环境不可用）：真实终端渲染（ANSI/xterm 类）、键盘输入、resize 拖拽、完整日志下载与窄屏/断线观感；SSE 实时流替代轮询（后续轮）。
2. DSH：Agent plugin、subagent follow-up、Cordis self-mod 隔离与 lifecycle；
3. Remote：容器隔离、mTLS、fencing、binary CAS、断线恢复、Remote PTY；
   - hardening §5 RUN-REMOTE-01 两行（2026-08-11 修复轮）代码侧已闭环的**真实环境剩余项**（记 `NOT_RUN_MANUAL_PENDING`，对应 acceptance-tests.md §21 `remote-secure-container-only` / `remote-identity-fencing-manifest` / `remote-cas-binary-auth` 的剩余段）：真实远端主机上 secure kinds 经 digest-pinned container 执行、无 docker 时 environment 失败且宿主 marker 未执行（`remote-secure-container-only`）；真实 mTLS service identity（CA/第二主机证书链）、证书轮换/吊销即时生效、两主机断线重连与故障注入、`remote-identity-fencing-manifest` 全链（assignment/job/run/owner/generation/token/manifest.run_id）在两台真实机器上核对（本地 wire 的 x-service-token 等价实现仅限本机测试）；两主机间二进制 CAS（随机字节/PDF/压缩包）往返 hash/size 一致（`remote-cas-binary-auth` 剩余）；Remote PTY 跨机 wire（`pty-owner-fencing-all-operations` 剩余）。
4. Reproduction：真实 Docker/TeX、Golden Path、Release Bundle、clean-room；
   - Code Snapshot P0-4（SNAPSHOT-01/API-01，hardening §5 行）端到端项：真实 golden-path Docker 全链（fixture 经项目 workspace 归档 → CAS 物化 → 容器执行）；浏览器/DSH 侧经 `workspace_snapshot` 工具以 workspace_id + root_relative_path 归档；旧 `{path}` 形状调用被 422 拒绝的实测记录；secret 文件（.env/token/key）混入工作区时快照被拒并列出文件名的实测记录——对应 acceptance-tests.md §21 `code-snapshot-approved-workspace-only`，记 `NOT_RUN_MANUAL_PENDING`（Docker/golden 环境可用时先跑 `evals/golden-path-v2/run-golden-v2.sh`）；
5. Recovery/Security：sidecar-kernel-bearer-required（真实 sidecar 实例上直接访问 kernel 端口的读写 401 负向、health 豁免、BFF/Runner/Orchestrator 用 token 全链）、撤权即时生效、多进程、kill/restart、长期 retention 与跨项目负向。
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
