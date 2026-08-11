# Config Registry（canonical Config Schema）

> 规范性文档（CONFIG-01，hardening-v0.2-status.md §3 CONFIG-01）。所有运行时配置项由
> `packages/research-schemas/src/config-registry.ts` 的 **canonical Config Registry**
> 单一管理；本文描述注册表的形态、校验语义、生成物与接入点。

## 1. 目标

配置不再散落于 Cordis schema、CLI、env 与 UI preferences 各处。每一个运行项只声明一次：

- 一个 **dotted canonical key**（如 `execution.network_policy`、`runner.poll_ms`）；
- 一个 **ConfigScope**（global / project / job / runner-profile，以及 kernel / standalone
  两个二进制作用域）；
- 一个 **Zod schema**（值级校验，唯一事实来源）；
- 一个 **default**、**secret** 标记与 **security-floor** 标记；
- 允许的 **来源**（CLI / env / file / HTTP / UI）。

Registry 是生成权威：JSON Schema、默认值 template、CLI 帮助文本全部从注册表生成，
不会与 Zod 漂移。

## 2. 作用域层次

| Scope | 内容 | 当前覆盖 |
|---|---|---|
| `global` | 全局基础（images.lock 路径与两个固定 digest） | `global.images_lock.*` |
| `project` | 项目执行与完整性配置（design §6.2） | `execution.*`、`integrity.*`（ExecutionConfig + IntegrityConfig 全字段） |
| `job` | 每 Job 策略（timeout、log retention） | 预留：目前由 runner-profile 与 Job payload 派生，无键 |
| `runner-profile` | Runner 网关 CLI 与容器安全面 | `runner.*`（kernel endpoint/mode/poll/heartbeat/timeout/cancel/owner/key-file/token/service-token/network/privileged/docker_socket） |
| `orchestrator` | Durable Research Orchestrator CLI（design §8） | `orchestrator.*`（kernel/db/poll_ms/once/dry_run） |
| `kernel` | Research Kernel 守护进程 | `kernel.*`（host/port/token/service-token/db/cas/endpoint-file/require_signed_manifest） |
| `standalone` | standalone BFF | `standalone.*`（host/port/kernel_port/data_dir/token/principal/no_token） |

env 别名在键上声明（生成 JSON Schema 的 `x-dsh-env` 注解与 template 注释带出）：
`DSH_SCHOLAR_KERNEL_TOKEN`、`DSH_SCHOLAR_SERVICE_TOKEN`（kernel/runner）、
`DSH_SCHOLAR_KERNEL_ENDPOINT_FILE`、`DSH_IMAGES_LOCK`、`DSH_HOME`（standalone
data_dir 缺省基目录）、`DSH_SCHOLAR_STANDALONE_{HOST,PORT,KERNEL_PORT,DATA}`
（start-standalone-ui.sh 翻译为 CLI flag 的别名）。

## 3. 校验语义（`validateConfig`）

`validateConfig(input, { scopes?, imagesLock? })` 对给定对象执行：

1. **合并默认**：以注册表默认值为底，输入覆盖之（仅限请求的 scope 集合）；
2. **拒绝未知键**：不在注册表（或 scope 集合）内的 dotted key → `unknown_config_key`；
3. **值校验**：每个值过对应 Zod schema，失败 → `validation_error`；
4. **security floor 违规拒绝** → `security_floor_violation`：
   - `runner.privileged=true`（禁 privileged 容器，security-baseline.md §5）；
   - `runner.docker_socket=true`（禁 Docker socket 挂载，§5）；
   - `runner.network=host`（禁 host network，§5 / execution-runtime.md §5）；
   - `runner.mode=subprocess` 时 `runner.network` 只能是 `none`（subprocess 无容器；
     每 Job 的 secure-kind 拒绝由 runner 执行层 enforce，见 execution-runtime.md §1）；
   - `execution.network_policy=none` 时 `runner.network` 只能是 `none`；
   - `integrity.allow_automatic_public_release=true`（自动发布禁止，security-baseline.md §1）；
   - `standalone.no_token=true` 时 host 必须是 loopback（127.0.0.0/8、::1、localhost）；
   - 提供 `imagesLock` 时 digest 键必须与锁条目完全一致（RUN-02）；
5. **pin hash**：对合并后的 effective config（含 secret）计算 canonical JSON 的
   sha256（`sha256:<64hex>`）。相同配置 → 相同 pin；任何值变化（含 secret）→ pin 变化。

返回值：

- `effective`：合并后的完整配置（含 secret 值，调用方决定如何持久化）；
- `redacted`：明文安全视图——secret 值一律替换为 `<redacted>`；
- `byScope`：按 scope 分组的 effective；
- `pinHash`：单向 sha256，**secret 只进入 pin，不进入任何明文输出**。

## 3.1 CLI 解析（`parseCli`）

`parseCli(argv, scope)` 是各二进制 CLI 解析的唯一入口（kernel / runner-profile /
orchestrator / standalone 四个 scope 全部接入）：

- 只接受注册表 `cli` 声明过的 flag，映射为 canonical key；
- 数字 flag 从字符串转换（`--port 7413` → `kernel.port: 7413`），布尔 flag
  原生解析（`--no-token`/`--once`/`--dry-run`）；
- 未知 flag → `unknown_config_key`，非法数值 → `validation_error`，错误消息
  永不回显 secret 值；
- 只返回 **argv 显式提供** 的键（不合并默认、不读 env）——调用方用
  `validateConfig()` 合并默认并取得 effective + pin；
- 每个 scope 的 `--help`/`-h` 打印 `generateCliHelp(scope)`（注册表生成）。

## 4. 生成物

| 生成物 | 位置 | 说明 |
|---|---|---|
| Zod schema | `@dsh-scholar/research-schemas`（`config-registry.ts` 导出） | 每个键的 `schema` |
| JSON Schema (draft-07) | `configs/generated/config.schema.json` | 按 scope 嵌套，含 default/description/`x-dsh-secret`/`x-dsh-security-floor`/`x-dsh-env` 注解 |
| 默认值 template | `configs/generated/template.yml` | `key: default` 树，附来源与 secret/floor 标记 |
| CLI 帮助文本 | `configs/generated/cli-help.txt`（`generateCliHelp(scope)`） | 每个 scope 的 `--flag` 行 |

重新生成（修改注册表后必须刷新并提交）：

```bash
node scripts/generate-config-artifacts.mjs
```

## 5. 运行中对象 pin hash

- `ResearchKernel.configPinHash` / `ResearchKernel.configRedacted`：kernel 构造时
  经 registry 对有效配置（global+project 默认 + 本实例 db/cas/require_signed_manifest/
  service identity + images.lock digest）计算，构造期校验失败即 fail fast；
- kernel HTTP 每个响应带 `x-config-pin` 头；`/v1/health` 与 `/v2/health` 带
  `config_pin` 字段；
- `GET /v1/config/effective`：部署级 effective config 的 **redacted 明文视图**
  （secret 一律 `<redacted>`）+ 其 pin（`config_pin`）；CLI 未传时回退 kernel
  构造级配置；
- `GET /v1/config/schema`：注册表生成的 JSON Schema（Settings UI 的服务端
  元数据面）；经 standalone BFF 的 `/v1/*` 代理同样可达；
- `bin/kernel.ts` 启动时经 registry 校验完整部署配置（host/port/token/service-token/
  db/cas/endpoint-file），并把 pin 写入 0600 endpoint 文件的 `configPin` 字段与启动日志；
- standalone BFF 启动时经 registry 校验（含 `--no-token` loopback floor），每个响应带
  `x-config-pin` 头。

配置变更后 pin 必然变化，因此运行中 Job/PTY/Build 可与产生它的配置精确关联
（gui-plugin-plan.md：“运行中 Job/PTY/Build 标注 pinned config hash，修改配置只影响新动作”）。

## 6. 接入点与边界

已接入（CLI 解析全部走注册表 `parseCli`）：

- kernel CLI（`bin/kernel.ts`）：parseCli + validateConfig（fail fast + endpoint
  文件 configPin + `/v1/config/effective` redacted 配置）；
- runner CLI（`bin/runner.js`）：parseCli + validateConfig（claim 前 fail fast，
  启动日志打印 config pin）；
- orchestrator CLI（`bin/orchestrator.js`）：parseCli（保持 --poll-ms > 0 的
  bin 级检查）；
- standalone BFF（`server.js` `loadOptions`）：parseCli + validateConfig
  （--no-token loopback floor 双保险）；
- 四个二进制均支持注册表生成的 `--help`；
- ResearchKernel 构造（pin + fail fast）、createProject（project scope 经
  registry 校验，security floor 生效）、kernel HTTP（响应头 + health +
  config/effective + config/schema）、standalone BFF（启动校验 + 响应头）；
- Settings UI（浏览器层，2026-08-11 修复轮，hardening §5 CONFIG-01/UI-02/UI-03）：
  由 `/v1/config/schema` + `/v1/config/effective` 动态生成（settings-model.ts
  `settingsConfigModel` 纯模型 + modals/settings.ts 接线）——每 ConfigScope 一组
  Accordion（7 组覆盖注册表全部键），每字段展示 effective 当前值（服务端 redacted，
  secret 只渲染掩码）、scope、声明来源、安全基线标记、env 别名、schema 描述与默认；
  config pin 显示 + 变化提示；本修订无写接口（kernel 仅 GET effective/schema），
  提交按钮禁用并注明“当前配置只读,经 CLI/env 提供”。

注册表尚无 `hot_reload` 标记（如实记录）：Settings UI 的热生效/需重启按键的声明
`sources` 推断——含 `http`/`ui` 来源的键按请求/新对象读取 → “保存后即时生效”；
仅 `cli`/`env`/`file` 的键在进程启动时读取 → “需重启生效”。该推断规则与
sources 客户端镜像一起由 tests/unit/settings-model.test.ts 对真实注册表钉死
（逐键相等，防漂移）。

后续（如实记录，未在本阶段实现）：

- api-contracts.md §19 的 `/bff/research/config/*`（schema/effective/revisions/
  PATCH/reset）写面——落地后 Settings 提交按钮启用（本地校验与错误映射机制已
  就绪并单测）；
- job scope 键（每 Job 策略仍由 runner-profile + Job payload 派生）；
- SecretRef 存储层（当前 secret 仍以 CLI/env/0600 文件提供，仅 registry 层脱敏与
  pin 提交；客户端只显示掩码，明文永不回显）。

## 7. Model Provider 与 OCR 配置增量

global scope 必须提供 `models.providers.*` 与 `onboarding.ocr.*` descriptor：Provider enable/base-url policy/catalog refresh/timeout、OCR provider/model/language/page/concurrency/retry，以及 `onboarding.upload.chunk_bytes`、`onboarding.upload.intake_total_bytes`。默认 chunk=8 MiB、最大=32 MiB；默认 Intake total=2 GiB、最大=10 GiB。安全字段只能由 instance/global 收紧，项目不能覆盖 endpoint 或 credential。

Provider credential 使用严格 SecretRef 存储层；项目仅保存 provider/model ID binding。Settings 的 Models & OCR 分组由 schema/provider API 生成，所有写入使用 revision CAS。运行中 OCR 固定 provider/model/config revision/hash，不因后续编辑漂移。精确 schema 与 fail-closed 规则见 `init-grill-upload-models.md`。

## 8. Experiment Environment 与 Remote SSH Runner

新增 target scope 和 `runner.targets.*`/`runner.profiles.*` descriptor。Settings 可登记 `local-docker` 或 `remote-ssh-runner` target 的 safe label、capabilities、health、draining、image/resource/network policy，以及 endpoint/known-hosts/SSH/mTLS `SecretRef`；普通 effective/API/浏览器只返回 target ID、label、健康、revision/hash 与 secret available，不返回连接明文。

项目、ExperimentContract、PaperReproductionSpec 与 Job 只选择 opaque profile/target ID。secure Job/PTY/Build 固定 target/profile/effective environment revision/hash；修改只影响新 attempt。远端不可用不自动回退本机。真实 SSH adapter 与 mTLS 未通过人工环境验收前状态只能“已实现未验收”或更低。
