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

- BFF 从 standalone 本地身份或 SSO 解析 Human Principal；DSH session 只用于 Agent 命令/工具关联，浏览器 actor 字段无效；
- Gate Decision 只存在于 Human BFF，Agent Tool 和命令不注册该能力；
- Project 角色至少为 owner/PI、researcher、operator、auditor、viewer；
- 读 Terminal 原始日志是独立权限 job_log_read，不能假设查看 status 就可读 secret-bearing log；
- 编辑 TeX 需要 document_write，编译需要 job_submit 和 document_read；
- 项目无权限与不存在都返回 404；
- Gate、target freeze、Decision、Project revision 和 Outbox 单事务提交。
- 安全回归必须覆盖 forged actor 被忽略、非成员跨项目 404、PI/member 变更、CSRF token 注入/轮换和撤权后 SSE 关闭。

## 3. Web 安全

- Browser -> same-origin BFF -> Kernel；浏览器不能获取 Kernel internal Token；
- Cookie 使用 HttpOnly、Secure（HTTPS）、SameSite；mutation 校验 Origin 和 CSRF；
- standalone Token 保存在 0600 文件，浏览器 localStorage 只用于显式本地解锁；团队部署禁止 localStorage bearer；
- 默认 16 MiB body、60 req/min/IP；上传和 Terminal 连接有独立配额；
- 错误脱敏，禁止返回 SQL、绝对路径、环境、Token、stack；
- Artifact 和 SSE 真正流式，保留媒体类型，禁用代理缓冲；
- CSP：default-src self、script-src self、object-src none、base-uri none、frame-ancestors self、img-src self blob data、connect-src self；
- HTML 不预览；SVG sanitize 后 img；text/ANSI 使用 text node 或白名单 parser；禁止 innerHTML。

## 4. Secret

- DSH provider key、Cookie、Kernel Token、Runner private key 不进入研究容器；
- Sidecar Token 不进入 argv、日志、SessionEvent 或浏览器 boot manifest；
- Runner signing private key 文件 0600，支持 key ID、轮换和撤销；
- 日志写入前过滤 Authorization、Cookie、常见 API key、DSH_HOME 和完整环境 dump；
- 过滤不能代替最小环境：Runner 只得到白名单变量；
- CI 运行 secret scan，Release Bundle 运行二次扫描。

## 5. Runner 隔离

正式 Job 只使用固定 image digest 和 CAS Snapshot。容器 non-root、read-only root、cap-drop all、no-new-privileges、network none、pids/memory/cpu/time/disk limit、tmpfs、只读输入和独立输出。

禁止 Docker socket、privileged、host namespace、宿主 Home、设备透传（除政策批准的 GPU）、任意 secret 和可变 tag。取消、超时、Runner 崩溃都清理进程树与容器；孤儿扫描是启动恢复的一部分。

TeX source 同样不可信。latex-compile 必须 no-shell-escape、禁网、固定 TeX Live digest、资源限制；.sty/.cls 不能获得宿主访问。

## 6. 路径与文件

- Workspace、Snapshot 和 TeX path 经过 decode、NUL 检查、POSIX 规范化和根内校验；
- 拒绝绝对路径、..、重复规范路径、设备、Socket、FIFO；
- 默认拒绝 symlink，或 realpath 验证目标仍在根；
- 文件数、单文件和总字节有上限；
- TeX 保存使用 version CAS 和原子 rename，冲突不能覆盖；
- Patch 使用 git apply --check 和 git apply，不维护宽松自制 parser；
- Artifact download 必须 project-scoped 并验证 Blob hash。

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

## 9.1 Standalone BFF 与本地监听

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

## 12. 供应链

- pnpm lockfile、镜像 digest、Git commit/submodule、数据版本和 TeX image 固定；
- 构建 SBOM、licenses 和 provenance；
- repository plugin 的 prepare 产物可重现并校验；
- Release Bundle 包含第三方和 AI usage 声明；
- CI action 固定 major 或 digest，依赖更新经过测试。

## 13. 审计与保留

Gate、Principal、Project mutation、Job、Terminal gap、Artifact、Evidence、TeX save/build、Release 和 self-mod tool call 都可关联 request_id、session_id、event_id。业务审计保存在 Kernel Outbox/DB；DSH Session 只做关联展示。

日志、Artifact、源稿和数据按 Project retention policy 清理。删除先生成审计记录并保证引用完整性；released Bundle 使用不可变 retention。

## 14. 阻断验收

至少包括：Agent Gate 绕过、伪 Principal、跨项目读取、CSRF、Token 泄漏、恶意 SVG/HTML/ANSI/TeX、路径与 symlink、formal subprocess、message-only success、旧 lease chunk/complete、无签名 Manifest、伪 verified Evidence、Terminal overflow/gap、TeX shell escape、生产 tool-cordis 存在、self-mod 冲突回滚、Release 未批准发布。

i18n 资源也是发布资产：缺失 key 必须 fail loud，不能把 wire error、外部论文或 Terminal 内容送入机器翻译；翻译插值只接受预定义参数并以 text node 渲染，不能通过 locale 字符串引入 HTML。
