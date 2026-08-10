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
| `kernel` | Research Kernel 守护进程 | `kernel.*`（host/port/token/service-token/db/cas/endpoint-file/require_signed_manifest） |
| `standalone` | standalone BFF | `standalone.*`（host/port/kernel_port/data_dir/token/principal/no_token） |

## 3. 校验语义（`validateConfig`）

`validateConfig(input, { scopes?, imagesLock? })` 对给定对象执行：

1. **合并默认**：以注册表默认值为底，输入覆盖之（仅限请求的 scope 集合）；
2. **拒绝未知键**：不在注册表（或 scope 集合）内的 dotted key → `unknown_config_key`；
3. **值校验**：每个值过对应 Zod schema，失败 → `validation_error`；
4. **security floor 违规拒绝** → `security_floor_violation`：
   - `runner.privileged=true`（禁 privileged 容器，security-baseline.md §5）；
   - `runner.docker_socket=true`（禁 Docker socket 挂载，§5）；
   - `runner.network=host`（禁 host network，§5 / execution-runtime.md §5）；
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

- `ResearchKernel.configPinHash`：kernel 构造时经 registry 对有效配置（global+project
  默认 + 本实例 db/cas/require_signed_manifest/service identity + images.lock digest）
  计算，构造期校验失败即 fail fast；
- kernel HTTP 每个响应带 `x-config-pin` 头；`/v1/health` 与 `/v2/health` 带
  `config_pin` 字段；
- `bin/kernel.ts` 启动时经 registry 校验完整部署配置（host/port/token/service-token/
  db/cas/endpoint-file），并把 pin 写入 0600 endpoint 文件的 `configPin` 字段与启动日志；
- standalone BFF 启动时经 registry 校验（含 `--no-token` loopback floor），每个响应带
  `x-config-pin` 头。

配置变更后 pin 必然变化，因此运行中 Job/PTY/Build 可与产生它的配置精确关联
（gui-plugin-plan.md：“运行中 Job/PTY/Build 标注 pinned config hash，修改配置只影响新动作”）。

## 6. 接入点与边界

已接入：ResearchKernel 构造（pin + fail fast）、createProject（project scope 经
registry 校验，security floor 生效）、kernel CLI（部署配置校验 + endpoint file）、
kernel HTTP（响应头 + health）、standalone BFF（启动校验 + 响应头）。

后续（如实记录，未在本阶段实现）：Settings UI 由 JSON Schema 生成（`x-dsh-*`
注解已就绪）；runner CLI 与 orchestrator CLI 的 parseArgs 帮助接入；job scope 键；
SecretRef 存储层（当前 secret 仍以 CLI/env/0600 文件提供，仅 registry 层做脱敏与
pin 提交）。
