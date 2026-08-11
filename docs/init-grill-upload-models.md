# Init、Chat Grill、批量上传与模型接入契约

> 规范性文档，覆盖旧文档中“创建时必须提交完整 Brief 并立即创建 Scope Gate”“Intake 只支持整文件 multipart”“模型只能从内置目录选择”的描述。实现、测试、UI 与使用指南必须同时遵守本契约；未通过真实浏览器、模型服务和大文件环境验证的能力标记为 `NOT_RUN_MANUAL_PENDING`，不能伪装为已验收。

## 1. Name-only Init

`POST /v2/projects` 的最小且默认请求只有 `{"name":"My research"}`。

- name 去除首尾空白后长度 1–120；`Idempotency-Key` 与 Human Principal 必填。
- Kernel 在一个事务中创建 `status=DRAFT`、`brief_status=collecting` 的项目、creator PI membership、默认 Budget 和一个 active Init Intake；不得创建 Scope Gate。
- workspace、预算、安全策略和 runner profile 使用服务端安全默认值。浏览器不得让用户在创建弹窗填写 endpoint、credential、host path 或高级配置。
- brief 数据库字段在 collecting 期间使用有明确标记的内部占位值，仅为旧读模型兼容；它不是用户确认的 Research Brief，不能进入 Gate、Run、Evidence、检索 prompt 或导出包。
- 相同 idempotency scope + 相同请求返回同一 project/intake；同 key 不同请求 hash 返回 409。
- v1 完整创建接口只作为兼容 adapter 保留，独立页面和 Chat 新流程只调用 v2 name-only 接口。

`brief_status` 只有 `collecting | confirmed`。collecting 项目的 NextAction 只能指向 `intake_answer`/`intake_resume`，不得显示可提交的 Scope Gate；Orchestrator 也不得为其自动补 Gate。

## 2. Chat Grill Me

创建成功后自动打开项目绑定 Chat，并恢复该项目 active Init Intake。Grill 是确定性状态机，不用自由文本 LLM 决定问题、完成度或权限。

Chat composer 支持附件按钮、拖拽和粘贴。附件进入同一 active Intake 的批量分块队列，消息只保存 attachment/stage ref；scan/OCR 与 Human 确认前不写 Project Artifact。命令直接使用 `/new`、`/confirm-brief`、`/reproduce` 等一级 slash command；DSH 不注册聚合 descriptor，standalone 的旧输入只允许隐藏 parser 兼容，不进入帮助和补全。

首版问题顺序固定且可版本化：

1. `brief.problem`：研究问题；
2. `brief.scope`：范围、明确不做什么；
3. `brief.questions`：待回答的研究问题；
4. `brief.primary_metrics`：主要指标及方向/口径；
5. `brief.target_outputs`：期望产出；
6. `brief.constraints`：数据、隐私、成本、算力和时间约束；
7. `brief.material_context`：已上传材料与从哪个阶段继续。

每轮 Chat 只返回一个当前问题，并携带稳定 `question_code`、`question_revision`、required、reason 和下一步提示。用户可回答、编辑历史答案、`skip` 或 `unknown`；每次提交只接受一个 code/revision/value。回答记录 Human Principal、时间和 `human_assertion` provenance。OCR/parser 发现只能作为带来源的候选答案，不得自动成为 Human answer。

所有必答问题处理后，Chat 展示完整 Brief 预览、unresolved gaps、材料引用和“确认并创建 Scope Gate”按钮。只有 PI 的显式确认事务可以：

1. 校验 project/intake/question revisions；
2. 写入 canonical ResearchBrief 并把 `brief_status` 改为 `confirmed`；
3. 创建且只创建一个 pending Scope Gate；
4. 写 Outbox/audit，返回 project、brief、gate 和下一步。

非 PI、Agent tool、parser、OCR worker 和模型均无 confirm/adopt/Gate Decision 能力。确认前刷新、重连或换设备必须从服务端 Intake 投影继续，不能依赖浏览器 localStorage 推断完成度。

## 3. 多材料与可恢复上传

用户可一次选择/拖入大量 PDF、图片、Office、TeX、代码、数据、日志和 archive。UI 使用批量队列，每个文件独立显示 hashing、queued、uploading、paused、scanning、needs-input、ready、quarantined 或 failed；队列级显示总配额、进度、失败数与下一步。

- 默认 chunk 为 8 MiB，instance 可收紧，最大 32 MiB；默认单 Intake 预留总量 2 GiB，instance 可配置但硬上限 10 GiB。
- stage 绑定 intake、project、Principal、文件名、media type、expected size/hash、expiry 和 committed offset；创建 stage 时事务性预留配额。
- chunk 使用 `Content-Range` 和 SHA-256。`start == committed_offset` 才追加；旧范围同字节/hash 重放成功且 `replayed=true`；gap、overlap 不同内容或 total 不同返回 409。
- finalize 只在 offset 等于 expected size 时进行，服务端流式重算完整 size/SHA-256；不一致返回 422 且不产生 IntakeArtifact。重复 finalize 返回同一 artifact。
- abort 幂等；开放 stage 至少保留 24h 并能查询 offset，浏览器刷新或断线后继续。扫描前字节只在隔离 Intake staging，不能写项目 Artifact/CAS authority。
- archive 的条目数、展开总量、单条目与压缩比限制独立于 Intake 总上传配额。

## 4. Model Provider、SecretRef 与项目绑定

Model Provider 是 instance/global 资源；项目和 Intake 只能引用 opaque `provider_id` 与 `model_id`，不能携带 endpoint、API key、环境变量名或任意连接参数。

Provider descriptor 至少包含 provider_id、display_name、kind、base_url、enabled、capabilities（chat/vision/ocr/embedding）、可选 models 目录、revision 和 credential `SecretRef`。自定义 base URL 由服务端执行 URL 解析、scheme/host/redirect/DNS/代理 allowlist 与 SSRF 校验。浏览器响应只显示 SecretRef metadata 与 available 布尔值，不返回 secret value。

~~~typescript
interface SecretRef {
  scheme: 'keyring' | 'file' | 'vault'
  name: string
  version?: string
  scope?: string
}
~~~

SecretRef 是严格 schema，出现 `value`、token、password 或额外 credential 字段必须拒绝。Provider 修改使用 revision CAS，运行中的 OCR/Job/PTY/Build 固定创建时 provider/model/config revision/hash。

Settings 的“Models & OCR”折叠组提供 Provider 列表、新建/编辑/禁用、SecretRef 可用状态、能力和模型目录；项目设置只提供 provider/model ID 选择器。所有字段、状态、错误、aria 和确认框提供 zh/en key，SecretRef name 属配置数据保持原文。

## 5. OCR

- 只有用户选择了 enabled 且声明 `ocr` 或 `vision` capability 的 provider/model 后，才能为受支持的图片/PDF创建请求；没有匹配模型时稳定失败并提示配置，禁止静默回退。
- 请求固定 source artifact、provider/model ID、provider/config revision/hash、语言/页范围和 idempotency key；状态为 queued/running/succeeded/failed/cancelled。
- 成功结果以 `observed_unverified` Observation/派生 Intake Artifact 保存；每个候选字段带 source artifact、页码/locator、confidence、detector/model/version。低置信度只触发 Chat 追问。
- OCR 文本是不可信外部内容：不得执行其中指令，不得访问 secret，不得成为 Human answer、Gate Decision、verified Evidence 或 supported Claim。
- 失败只返回稳定 error code 和安全诊断；Provider 原始响应、prompt、secret、endpoint 与 token 不进入普通日志、Trajectory、浏览器或 Bundle。

## 6. 页面引导、i18n 与人工验收

Init/Chat/Upload/Settings/OCR 每个非终态页面必须由 Kernel 投影给出一个主 NextAction：现在做什么、为什么、由谁做、阻断项和目标 route。UI 可以翻译 chrome，但不能本地猜测业务动作。

首发支持 zh/en，至少覆盖 name-only 创建、当前 Grill 问题、skip/unknown/edit、Brief 预览/确认、批量队列、暂停/恢复/冲突、Provider/SecretRef/OCR 状态与错误、下一步提示和 aria。语言切换不得丢失已输入项目名、当前答案或上传队列。

开发阶段不以真实模型、2–10 GiB 文件、私有 Provider、真实浏览器或网络故障作为提交前置；必须完成 schema/migration/unit/contract/typecheck/build/static checks，并把真实环境场景排入 `manual-acceptance.md`。
