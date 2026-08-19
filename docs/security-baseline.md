# 安全与科研完整性基线

> 规范性文档。默认拒绝；任何例外必须在配置、审计和测试中同时可见。

## 1. 默认姿态

| 能力 | 生产默认 | 开发默认 |
|---|---|---|
| DSH permission | workspace-write + ask | 隔离 workspace-write + ask |
| danger-full-access | 禁止 | 仅明确人工任务，可选且不推荐 |
| generic web_fetch | 禁止 | 默认禁止 |
| MCP | 无 server | 按任务显式启用 |
| Cordis self-referential | 硬禁用 | 隔离 profile 可显式启用 |
| 正式 subprocess | 禁止 | 仍禁止；只允许 trusted smoke fixture |
| Runner network | none | none，连接器在控制面运行 |
| automatic release | 禁止 | 禁止 |
| full-auto | fixture-only | fixture-only |

Unknown Agent role 是 none。所有项目读写执行 membership；所有 Human Decision 绑定认证 Principal。

## 2. 身份、AuthZ 与 Gate

- BFF 从 standalone 本地身份或 SSO 解析 Human Principal；DSH session 通常只用于 Agent 命令/工具关联，浏览器 actor 字段无效。唯一创建例外是 `dsh_scholar` 的显式 name-only Init：internal route 同时要求 Kernel bearer、共享 service token、仅 DSH plugin/kernel 持有的独立非空专用 token 与固定 audience 标签；专用 token 配置缺失/空白、Runner 持有的共享 token、自报 `x-service-principal:dsh-plugin`、浏览器 bearer 均不能单独授权。服务端只从 Host path session 派生 pseudonymous creator Principal，并在同一事务检查 idempotency 与原始 `session_links` 行、创建 collecting Project/active Intake/PI membership/exact link；模型、浏览器和 route body 均不能提交或覆盖 Principal/session。项目名必须等于确定性命令解析出的完整后缀名称，子串或模型补名不算 consent；疑问、否定、歧义、标点或连接词引出的后续子句、无标点的“不创建/not create/先别创建”尾句或名称不一致零写。public v2 name-only adapter 可兼容并忽略 legacy 额外字段，但不得把 strict body 当作安全边界；internal DSH request hash 必须是由专用 plugin token 签出的 route/session/name `HMAC-SHA256`，公开请求在任一方向都不能伪造或认领该幂等行。transport 在 fetch、响应头或成功响应体读取/解析阶段失败、超时或 abort 时只可 replay-only 读取同 key 已提交回执，不能用同名 link 猜测成功。任何既有活动/墓碑/悬空 link 均禁止替换；
- Gate Decision 只存在于 Human BFF，Agent Tool 和命令不注册该能力；
- Project 角色至少为 owner/PI、researcher、operator、auditor、viewer；
- 读 Terminal 原始日志是独立权限 job_log_read，不能假设查看 status 就可读 secret-bearing log；
- 编辑 TeX 需要 document_write，编译需要 job_submit 和 document_read；
- 编辑 Workspace 需要 workspace_write，打开/控制 PTY 需要 terminal_write；读取 Trajectory summary/detail 与 subagent follow-up 是三个独立 capability；
- Intake begin/upload 可由 researcher 请求，adoption/merge 只允许 PI Human Principal；DSH Agent 不获得 accept；
- 项目无权限与不存在都返回 404；
- Gate、target freeze、Decision、Project revision 和 Outbox 单事务提交。
- 安全回归必须覆盖 forged actor 被忽略、非成员跨项目 404、PI/member 变更、CSRF token 注入/轮换和撤权后 SSE 关闭。

## 3. Web 安全

- Browser -> same-origin BFF -> Kernel；浏览器不能获取 Kernel internal Token；
- Cookie 使用 HttpOnly、Secure（HTTPS）、SameSite；mutation 校验 Origin 和 CSRF；
- standalone Token 保存在 0600 文件，浏览器 localStorage 只用于显式本地解锁；团队部署禁止 localStorage bearer；
- 默认 16 MiB body、60 req/min/IP；上传和 Terminal 连接有独立配额；
- research package 使用 intake staged upload，不得暴露 Runner internal stage；每个 stage 绑定 Principal/intake/TTL/offset/hash；
- 错误脱敏，禁止返回 SQL、绝对路径、环境、Token、stack；
- Artifact 和 SSE 真正流式，保留媒体类型，禁用代理缓冲；
- CSP：default-src self、script-src self+每响应 nonce、style-src self+nonce（运行时 style attribute 暂需 unsafe-inline）、object-src none、base-uri none、img-src self blob data、media-src self blob、frame-src self blob、connect-src self；bootstrap 必须把同一响应 nonce 通过显式参数交给客户端，所有运行时创建的 Shadow DOM `<style>` 在插入前设置该 nonce，不能依赖在 nonce 同时存在时会被浏览器忽略的 `unsafe-inline`。完整 standalone 不嵌入 DSH 页签，`frame-ancestors` 使用最小部署策略；PDF 仍使用受控 Blob `<iframe>` 而非会被 `object-src none` 阻止的 `<embed>`；
- HTML/SVG/XML 原始产物不预览、不顶层打开；SVG 只有经受控转换得到的安全栅格衍生物可进入 img。Office/ODF、archive、model 与未知二进制只提供元数据和 attachment 下载，不执行、不解包、不调用 `Blob.text()`；
- PDF、安全栅格图与明确 allowlist 的 audio/video 只能通过项目鉴权后的 Blob URL 只读展示；Markdown/JSON/CSV/text/ANSI 使用 text node 或白名单 parser，设置字节/字符/行列上限；禁止 innerHTML。关闭、切项目和卸载必须 revoke Blob URL。

## 4. Secret

- DSH provider key、Cookie、Kernel Token、Runner private key 不进入研究容器；
- Sidecar Token 不进入 argv、日志、SessionEvent 或浏览器 boot manifest；
- Runner signing private key 文件 0600，支持 key ID、轮换和撤销；
- 日志写入前过滤 Authorization、Cookie、常见 API key、DSH_HOME 和完整环境 dump；
- 过滤不能代替最小环境：Runner 只得到白名单变量；
- CI 运行 secret scan，Release Bundle 运行二次扫描。
- 所有配置 secret 只以 SecretRef 存储和返回；Settings 不显示 value，effective config、argv、Manifest、Trajectory 和 diagnostic export 都必须脱敏。唯一例外是 Plugin config 中由用户显式触发的一次性 standalone access-token Clipboard 写入：仅限 loopback-only RPC 读取固定 `0600` 普通非 symlink 文件，Token 不进入 DOM、aria、React state、URL、日志、Settings snapshot、storage 或 fallback textarea；`kernel.token`、Kernel/Runner service token、Provider SecretRef、SSH 私钥始终不可复制或回显；

DSH 中的 standalone 启动入口必须满足：配置 URL 无 userinfo/query/hash；HTTP 只允许 loopback，HTTPS 仍执行证书与 Host 信任检查；只以 `noopener,noreferrer` 新页面打开，不把 Token、session 或 project id 放入 URL。全局快捷键不得在可编辑控件、IME composition 或 key repeat 时触发。复制 Token、settings snapshot/mutation 的 Host RPC 保留在 `authority=loopback` 的 `/dsh-scholar`，不接受客户端文件路径，Token 文件缺失、过大、权限非 `0600` 或为 symlink 时 fail closed；DSH 页签仅通过 `authority=trusted-host` 的 `/dsh-scholar-view` 访问字段严格的 session workspace/bind/create，该 handler 对 Token/settings endpoint fail closed。已有不同 link、归档/跨 Principal 项目与竞争改绑必须在 Kernel 内拒绝，不能依赖浏览器隐藏选项。

## 5. Runner 隔离

正式 Job 只使用已登记的固定 image digest 和 CAS Snapshot。对可配置实验镜像，只有 PI/Operator 可写的 RunnerTarget Registry 才是授权 allowlist；项目正文、Chat、Job payload 与浏览器不能自行登记或改写镜像。容器 non-root、read-only root、cap-drop all、no-new-privileges、network none、pids/memory/cpu/time/disk limit、tmpfs、只读输入和独立输出。Docker NVIDIA 模式只能由类型化的 `all` 或数字设备 ID 请求生成受控 `--gpus` 参数；禁止浏览器或 Job 注入 `--runtime`、`--device`、环境变量覆盖或其他任意 flags。NVIDIA runtime/driver/device preflight 失败时 fail closed，不得自动改用 CPU。

禁止 Docker socket、privileged、host namespace、宿主 Home、设备透传（除政策批准的 GPU）、任意 secret 和可变 tag。取消、超时、Runner 崩溃都清理进程树与容器；孤儿扫描是启动恢复的一部分。

TeX source 同样不可信。latex-compile 必须 no-shell-escape、禁网、固定 TeX Live digest、资源限制；.sty/.cls 不能获得宿主访问。

Remote Runner 使用 mTLS service identity、target allowlist、签名 ExecutionPlan、lease generation/token 和 CAS hash。远端地址/证书/SSH bootstrap 只存在服务端 Config/Secret store；浏览器/Job 不得提交 endpoint 或 credential。网络分区、target offline 和 capability mismatch fail closed，不回退宿主 subprocess。

RunnerTarget heartbeat 必须同时通过共享 internal `x-service-token` 门禁和该 target 独立的 service-identity SecretRef 凭证；URL target id、`x-service-principal`、`x-runner-target-id` 等调用方自报字段都不是身份。仅当 Node 观测到的真实 TCP peer 是 loopback（`127.0.0.1`、`::1` 或 IPv4-mapped loopback）时，开发 wire 才可使用 `x-runner-target-token`；`X-Forwarded-For` 等转发头不参与判定。Kernel 只能从 server-side `secretRoot` 内的普通非 symlink `0600` 文件读取该 target 的 token 并恒时比较，且 token 不进入浏览器投影、日志或通用 API 请求。非 loopback/生产部署必须由受信 mTLS 终止器使用 peer certificate 建立 service identity、映射到 target allowlist，再经 loopback 转发；当前 plaintext Kernel listener 直接拒绝所有非 loopback target-token heartbeat，不得把转发头、自报 header 或共享 token 当作 mTLS 替代。未配置、越界、symlink、非 `0600`、不可解析或与 target 不匹配的 identity 一律拒绝 heartbeat，原有 revision CAS、TTL/offline readiness 继续 fail closed。

## 6. 路径与文件

- Workspace、Snapshot 和 TeX path 经过 decode、NUL 检查、POSIX 规范化和根内校验；
- 拒绝绝对路径、..、重复规范路径、设备、Socket、FIFO；
- 默认拒绝 symlink，或 realpath 验证目标仍在根；
- 文件数、单文件和总字节有上限；
- TeX 保存使用 version CAS 和原子 rename，冲突不能覆盖；
- Patch 使用 git apply --check 和 git apply，不维护宽松自制 parser；
- Artifact download 必须 project-scoped 并验证 Blob hash。
- Intake archive 额外拒绝解压炸弹、嵌套深度、大小写冲突和 parser 主动内容；扫描/解析在无网、无执行、受限 sandbox 中，采用前 bytes 只在 quarantine 可见；
- Workspace watch/search/upload 与 TeX file facade 使用同一 path/CAS/revision policy，不能维护较宽松旁路。

## 7. Prompt Injection 与外部内容

- 论文、摘要、Passage、README、代码、数据说明和 Terminal 输出都标记 untrusted；
- 连接器只返回结构化字段，外部文字不能修改系统指令、角色、工具或 Gate；
- 模型不能把外部 URL 交给通用 fetch；来源目标由 Connector 固定；
- 建立恶意论文、README、SVG、TeX、metrics 和 ANSI 控制序列红队集；
- UI 不翻译或解释动态外部内容，避免改变语义。

## 8. Evidence 完整性

- 正式指标只来自固定 metrics file；
- RunManifest 签名、lease、Job/Contract、Snapshot、image 和 Artifact 全部校验；
- HTTP 公共接口不能提交 verified/accepted provenance；
- Analysis Worker 是 verified Evidence 唯一写入身份；
- Claim 只读取 accepted Evidence，缺方向、effect、CI、minimum_n 时 inconclusive；
- Writer 只读 Ledger，不读取聊天或 stdout 作为结果来源；
- Release 前数字、图表、引用、负结果和限制做确定性审计。

## 9. Terminal 安全

- stdout/stderr 分通道保存，ANSI 使用白名单 parser，OSC 链接、标题、剪贴板控制和任意 escape 被剥离；
- 日志有总量、热窗口、连接数和背压上限；任何删除产生 gap/truncated；
- Terminal SSE 需要 job_log_read 和项目授权，撤权后关闭；
- lease fencing 拒绝旧 Runner 注入 chunk；
- 下载日志使用 text/plain 或 application/x-ndjson，不能当 HTML；
- 搜索、复制、导出不得把隐藏的已过滤 secret 恢复出来。
- Interactive PTY 与 Run Terminal 完全分离；PTY input/resize/signal/attach/close 每次校验 Principal、project、terminal_write、generation 和 client_seq；
- PTY 只接受 allowlisted shell preset 与根相对 cwd，不接受 hostname、SSH credential、host path、Docker socket 或任意 argv；
- PTY 输出不能成为 Metrics、Manifest、accepted Evidence 或 Gate Decision；权限撤销立即关闭，idle TTL 与 retention 有界且可审计。

## 9.1 Onboarding、Trajectory 与 Subagent

- pre-accept Intake 只能写隔离表/临时 CAS；Observation、Grill answer、PhaseProposal 永远是 unverified，不得制造 Project history、Gate Decision、Run、TerminalLog、accepted Evidence 或 supported Claim；
- Adoption 只由 PI Human BFF，校验 proposal/target revision、所有映射与 quarantine，在单事务完成或全部回滚；
- imported logs/results 仅为 Artifact + ImportedRunObservation/legacy Evidence；没有本 Kernel 接受的签名 Manifest 时要求 clean rerun/reanalysis；
- Research Trajectory 只投影 Outbox；Session Trajectory 默认只返回 allowlisted summary。raw prompt、tool args/results、provider payload、cwd/env/secret 不得透明暴露；
- subagent list/history/followup 服务端校验 exact parent/child/mode 和 project membership；history/cold read 不激活 Agent；one-shot、diagnostic、parent offline 或无 capability 必须只读；
- 阶段 subagent 默认关闭；启用后每个 child 绑定创建时 project scope，允许工具拒绝跨项目显式 project/job 引用。internal topology bridge 同时要求 service token、`dsh-plugin` service principal、session→project 与 exact-parent fence，非规范 path 不得绕过 token；
- 自报 `user_confirmed=true` 不是可信 Human receipt；独立、一次性、session/action/revision 绑定的确认凭据与原子预算预留未落地前，不得将阶段 fan-out 作为生产安全能力。task/completion/perspective 在进入 provider 前必须先脱敏；
- Session detail 使用 redaction、bounded preview/CAS spill 和 TTL；purge 产生 redacted/gap 审计，不能删除对应 Kernel Outbox。

## 9.2 Standalone BFF 与本地监听

- `--no-token` 只可绑定 `localhost`、`::1` 或 `127.0.0.0/8`；任何 wildcard、LAN 或外部 hostname 必须在 listen 前拒绝；
- 开启 token 时，明文 token 只存在于 0600 token file/受控进程通道和浏览器当前会话，不进入 argv、服务日志、错误响应或 URL；
- BFF 对 connector、Kernel 和文件错误只返回稳定错误码与通用消息，内部 URL、dataDir、环境变量和依赖路径不得回显；
- package allowlist、clean pack 与 CI 负向检查共同保证已删除的 DSH host/bridge 不会由 ignored `lib` 重新发布；
- readiness 脚本不得把启动失败报告为成功；超时或子进程退出必须非零结束。
- sidecar 只在 protocol/schema/database identity、dataDir/config 均匹配时复用；port=0 必须由 0600 endpoint handshake 返回实际端口，超时或错配 fail closed。

## 10. Cordis self-referential 开发模式

cordis_inspect、cordis_mount、cordis_unmount 等同高风险运行时代码能力。node:vm、Context façade 和 vmTimeoutMs 不是安全边界；通过注入的 bash/fs/web 可访问真实运行时。

硬要求：

- production、research-headless、shared team 和 unattended profile 不能加载 tool-cordis；
- dsh web --dev 本身不能隐式启用；只有 configs/research-dev-selfmod.cordis.yml 显式插入；
- 使用独立 DSH_HOME、loopback、测试数据库、人工 approval=ask；
- 不向动态 plugin 注入 Kernel internal client、database、Runner key、credential、release 或 Human Decision 能力；
- mount/unmount 作为 DSH tool call/result 审计，动态代码可见；
- 临时插件只存在进程内，重启不恢复；需要保留的变化必须转为正常源码、测试和 Markdown；
- mount 失败、冲突、HMR 和 shutdown 必须 dispose 动态 subtree；
- CI 否定测试证明生产工具目录中不存在三个 cordis_* 工具。

## 11. 网络与 SSRF

Scholar Connector 只连接 api.openalex.org、api.crossref.org、export.arxiv.org 等显式域。DNS、redirect、proxy 环境和 URL parsing 均执行 allowlist；redirect 不可跳出域。Runner 默认无网，数据由控制面预取、hash、登记后作为只读 Artifact 提供。

自定义 Model Provider base URL 适用同等或更严格的 SSRF 防护：仅服务端解析，校验 scheme/host/port/DNS/redirect/proxy，每次重连重新校验；浏览器、Project、OCR request 和 Job 只传 opaque provider/model ID。credential 只接受 SecretRef，任何 `value`/token/password 字段 fail closed。OCR 文本、页图和候选答案是不可信外部内容，不能执行指令、访问 secret、自动回答 Grill、创建 Gate 或升级 Evidence。

## 12. 供应链

- pnpm lockfile、镜像 digest、Git commit/submodule、数据版本和 TeX image 固定；
- 私有 `@deepseek-ai/*` 兼容性只接受临时 0600 npm userconfig + 全新 `DSH_HOME` 的真实安装证据；registry token 禁止写入仓库 `.npmrc`、argv、stdout/stderr 或报告；
- 构建 SBOM、licenses 和 provenance；
- repository plugin 的 prepare 产物可重现并校验；
- Release Bundle 包含第三方和 AI usage 声明；
- CI action 固定 major 或 digest，依赖更新经过测试。

## 13. 审计与保留

Gate、Principal、Project mutation、Intake/Adoption、Job、Terminal/PTY gap、Artifact、Evidence、Workspace/TeX save/build、Trajectory redaction/follow-up、Release 和 self-mod tool call 都可关联 request_id、session_id、event_id。业务审计保存在 Kernel Outbox/DB；DSH Session 只做关联展示。

日志、Artifact、源稿和数据按 Project retention policy 清理。Project 的交互式删除只允许 PI 对 ARCHIVED 项目创建 tombstone；先生成 `project.deleted` 审计记录并保证引用完整性，正常读取立即隐藏。tombstone 不是物理 purge：Decision、成员、Outbox、Artifact 引用和 released Bundle retention 保留；共享 Blob 仅当所有 Project/Workspace/FileRevision/Bundle 引用均为零且 grace/hold 已结束时由 GC 删除。

## 14. 阻断验收

至少包括：Agent Gate/Adoption 绕过、伪 Principal、跨项目读取、CSRF、Token/Config/Trajectory 泄漏、恶意 archive/SVG/HTML/ANSI/TeX、路径与 symlink、formal subprocess、远端降级、message-only success、旧 lease chunk/complete、无签名 Manifest、导入结果伪 Run/Evidence、Terminal/PTY overflow/gap/越权输入、subagent exact-parent 绕过、TeX shell escape、生产 tool-cordis 存在、self-mod 冲突回滚、Release 未批准发布。

i18n 资源也是发布资产：缺失 key 必须 fail loud，不能把 wire error、外部论文或 Terminal 内容送入机器翻译；翻译插值只接受预定义参数并以 text node 渲染，不能通过 locale 字符串引入 HTML。

论文复现与 Chat 附件适用同一不可信内容边界：PDF/OCR/repo README/notebook 中的指令不执行，附件 adoption 前零 Project authority。远端 SSH target 只接受服务端 allowlisted adapter 与 SecretRef，拒绝客户端 hostname、user、private key、ProxyCommand、任意 argv；host key/CA、DNS/redirect/proxy 和目标轮换 fail closed。Session Terminal 的 context/child ID 必须服务端解析，stale generation/expired lease/跨 context input 一律拒绝。

Natural Chat intent 只解析当前 Human turn，不解析附件/OCR/论文/README 中的指令为命令。Intent router 的可执行集合由当前 `next_actions_v2`、role/capability、revision 与 canonical operation allowlist 相交得出；模型返回的 URL、tool name、slash、principal、Gate decision 或 runner endpoint 都是不可信候选。Human-only、blocked、unknown、歧义或参数缺失一律零副作用；所有自动执行保留原命令的 CSRF、membership、idempotency 与审计边界。
