# RSP-012 — 安全基线(默认权限、secret、网络、容器、日志策略)

> 对应设计文档 §1.2(明确不做)、§4.9(安全、权限与科研完整性)、
> §4.6.1(Runner 安全合同)。本文件是实施基线,不是一次性审计报告。

## 0. 总原则

| 原则 | 落地 |
|---|---|
| Least privilege | 每类 Agent 只见本角色工具(工具 ACL);Writer 只读;Runner 无 DSH 凭据 |
| 默认关闭 | danger-full-access、通用 web_fetch、MCP、Cordis 自指工具、自动发布 |
| 外部内容不可信 | 论文/README/网页文本一律按不可信数据处理,不得改变指令或权限 |
| 硬预算 | Token/API/GPU 硬上限;越界 → BLOCKED_GATE + Budget Gate |

## 1. 默认权限面(profile composition)

- 本 bundle **只增加行**,不改动 sandbox/approval/web_fetch 行;profile 保持
  shipped 默认 `workspace-write + ask`(`packages/bundle/base/
  cordis.patch.yml:144-152`)。
- 不挂载:`danger-full-access` 权限预设、`web_fetch`(tool-web 的
  `fetch: false` 保持)、任意 MCP server、`cordis_*` 自指工具。
- 无人值守(headless/CI):不调用会无限等待的 ask_user_question;Gate 把项目
  置为 BLOCKED_GATE(`src/plugin/commands.ts` 的 `unattended` 分支)。

## 2. 秘密与凭据

- DSH credentials 只存引用(provider/connector 引用,`$DSH_HOME/.env`
  热重载),模型/API 凭据**不得进入 Runner**。
- Kernel 监听 `127.0.0.1`,可配 `--token`(loopback bearer);插件与 Kernel
  之间默认无凭据(本机回环),跨主机部署必须启用 token 或反代。
- 日志策略:插件日志不打印凭据、token、API key;Kernel 事件 outbox 不存
  secret(设计 §4.2 Outbox)。

## 3. 网络

- 学术连接器:仅允许固定域名(api.openalex.org、api.crossref.org、
  export.arxiv.org),请求目标由连接器代码决定,模型不可指定任意 URL
  (设计 §4.4「为什么不直接开启通用 web_fetch」)。
- 连接器响应全部视为不可信:只抽取结构化字段;正文中的指令作为文本。
- Runner 作业默认禁网(设计 §4.6.1);smoke/formal 需要下载数据时走预取 +
  allowlist(本仓库 MVP 的 subprocess 模式不做网络隔离,见 §5)。

## 4. 不可信执行(Runner 安全合同)

- Runner 只接受:内容寻址代码快照、数据引用、已批准 ExperimentContract;
  拒绝任意宿主路径。
- 隔离要求:非 root、只读基础镜像、无 Docker Socket、无特权、无宿主
  Home 挂载、进程/内存/磁盘/GPU/时间限制、默认禁网。
- Docker 模式(`--mode docker`):`docker run --rm --network none --user
  65534:65534 --memory 1g --cpus 1 --tmpfs /tmp`(`workers/runner-gateway/
  src/index.ts:runDocker`)。
- **subprocess 模式不是安全边界**:`--mode subprocess` 仅用于本地 smoke/
  开发,使用 fresh temp dir + 精简 env + timeout;任何正式实验必须走容器
  (设计 §4.6.1、附录 D)。
- 结果写入临时目录,完成后作为 CAS artifact 上传,校验哈希后才标记 Job
  成功;RunManifest 引用缺失 artifact 直接拒绝(内核 `completeJob` 验证)。

## 5. 科研完整性控制

| 风险 | 控制 | 验证 |
|---|---|---|
| Prompt injection | 外部内容标记 `is_untrusted`;连接器只返回结构化字段 | `tools.ts` 各连接器;注入测试见 §6 |
| 生成代码越权 | Agent 无容器 socket;只调 Runner API | ACL + Runner 合同 |
| 伪造引用 | identifier resolver(`paper_resolve`);未解析引用不得入稿 | e2e:manuscript 只引用已解析论文 |
| 伪造/篡改数字 | 正式指标只由分析任务生成;Writer 只读;Artifact 哈希绑定 | `manuscript_review` 检查 |
| P-hacking / 口径漂移 | Contract 预注册冻结;变更升版本重新 Gate | kernel `approveContract` 不可变 |
| 自动发布责任 | 发布工具默认不存在;Release Gate 人类显式 | e2e:bundle 恒为 `unapproved` |

## 6. 基线测试

- `tests/unit/*` — schema 校验、状态机非法迁移、租约冲突、manifest 校验。
- `tests/fault-injection/run-fault-tests.sh` — kill -9 恢复、幂等、租约恢复。
- `tests/e2e/golden-path.sh` — 黄金路径,含「缺失 artifact 拒绝」用例。
- 待办(超出首周):注入红队(恶意论文/README 诱导)、SSRF 用例、
  容器逃逸面检查、供应链 SBOM、成本回归。见设计 §11.1 Security 层。

## 7. 部署注意

- Local Desktop:kernel 只监听 127.0.0.1;DSH 进程退出后 kernel 由插件
  sidecar 关闭(进程级 kill 场景:kernel.db 保持完整,重启自动恢复)。
- Team/Cluster:kernel 后置反代 + SSO,DB 换 PostgreSQL,Runner 换
  K8s/Slurm;本仓库首版未实现(设计 §9.2 演进)。
