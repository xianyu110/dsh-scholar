# DSH Scholar

> Security Alpha / Architecture Prototype。默认 gate-only，禁止作为无人值守正式科研系统发布。

DSH Scholar 是 DeepSeek Harness 的可恢复科研工作台：以 Research Kernel 保存权威项目状态，以隔离 Runner 执行真实计算，以 Claim–Evidence 账本追溯结论，并以 Human Gate 管理范围、Idea、合同、预算和发布。

## 文档是生成权威

从 [docs/README.md](docs/README.md) 开始。该目录已经整合桌面 v2.0 设计稿、旧 docs、当前 dsh-scholar 实现和 DSH 宿主代码，定义产品、架构、领域模型、HTTP/事件、存储、DSH 集成、Runner、UI、i18n、实时 Terminal、TeX Workbench、安全、部署和验收。

任何新增需求或修复必须同步对应 Markdown、验收和当前差距；只改代码视为未完成。

当前实现与目标差距见 [docs/hardening-v0.2-status.md](docs/hardening-v0.2-status.md)。尤其是实时 Terminal、版本化 TeX 编辑/编译、完整 BFF Principal 和全页面 i18n 仍是目标能力，不应被描述成当前已完成。

## 安装与启动

前置：DSH checkout、Node.js 24、pnpm 11；正式执行和完整测试需要 Docker。

~~~bash
pnpm install --frozen-lockfile
./scripts/link-dsh-deps.sh
pnpm build

# DSH 嵌入测试实例：http://127.0.0.1:3081
bash scripts/start-test-dsh.sh

# 当前独立 UI：http://127.0.0.1:18610
bash scripts/start-standalone-ui.sh
~~~

当前 Kernel 使用 /v1；目标生成规范使用 /v2。使用说明见 [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)，实例与迁移期命令见 [docs/test-instance-plan.md](docs/test-instance-plan.md)。

## 当前命令面

~~~text
/research new <name> [brief-json]
/research status
/research survey <query>
/research ideas
/research reproduce [json]
/research contract <json>
/research run <kind> <json>
/research evidence <json>
/research write
/research review
/research export
/research release
~~~

目标 v2 还统一提供 help/list/gates/jobs/claims；当前 UI 中这些快捷命令存在实现差距，见状态文档。正式 run 必须先建立真实 code snapshot，并在 payload 中带 contract_id/code_snapshot_id；不能直接复制空参数示例。

## 开发专用 Cordis self-mod

只在隔离、loopback、人工审批的开发实例启用：

~~~bash
DSH_SCHOLAR_ENABLE_SELFMOD=1 bash scripts/start-selfmod-dev.sh
~~~

它会加载 @deepseek-ai/dsh-tool-cordis，提供 cordis_inspect、cordis_mount、cordis_unmount。该 VM 不是安全边界，生产、headless、shared 和 unattended 配置保持禁用。动态变化需要保留时必须转成源码、测试和 Markdown。

## 验证

~~~bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:security
pnpm test:all
~~~

历史测试计数不是当前通过证据；以当次 CI 和 [docs/acceptance-tests.md](docs/acceptance-tests.md) 为准。
