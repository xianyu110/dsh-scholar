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
  config/effective + config/schema）、standalone BFF（启动校验 + 响应头）。

后续（如实记录，未在本阶段实现）：

- Settings UI（浏览器层）由 `/v1/config/schema` + `/v1/config/effective` 生成；
  api-contracts.md §19 的 `/bff/research/config/*`（schema/effective/revisions/
  PATCH/reset）随 Settings UI 一并落地；
- job scope 键（每 Job 策略仍由 runner-profile + Job payload 派生）；
- SecretRef 存储层（当前 secret 仍以 CLI/env/0600 文件提供，仅 registry 层脱敏与
  pin 提交）。
