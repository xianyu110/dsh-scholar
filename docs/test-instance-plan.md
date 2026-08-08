# 开发、测试与部署运行规范

> 规范性文档。所有实例必须明确 DSH_HOME、Web port、Kernel endpoint 和 dataDir，禁止意外复用。

## 1. 实例矩阵

| 实例 | DSH_HOME / data | Web | Kernel | Self-mod | 用途 |
|---|---|---:|---:|---|---|
| 日常 DSH | 用户默认 | 3080 | 7412 | 禁止 | 非 Scholar 日常工作 |
| Scholar test | ~/.dsh-scholar-test | 3081 | 17412 | 默认禁用 | DSH 嵌入集成 |
| Scholar standalone | ~/.dsh-scholar-standalone | 18610 | 17413 | 不支持 | 独立 UI |
| Scholar selfmod dev | 临时独立目录 | 自选 | 自选 | 显式启用 | Cordis 运行时调试 |
| CI | mktemp workspace | 随机 | 随机/Unix | 仅专门 case | 自动验收 |

端口只是默认值。真正隔离以 dataDir/database_id 为准；health 必须返回 instance_id、protocol_version、schema_version 和 database_id。

## 2. 前置环境

- Node.js 24；
- pnpm 11；
- DSH checkout，通过 DSH_SCHOLAR_DSH_ROOT 指定；
- Docker，用于正式 Job、Terminal、Golden、TeX 和 clean-room；
- 固定 TeX Live image；本机不要求安装 pdflatex；
- Linux/macOS 文件权限语义；团队部署另需反代/SSO/PostgreSQL/K8s 设计。

## 3. Clean setup

~~~bash
pnpm install --frozen-lockfile
./scripts/link-dsh-deps.sh
pnpm build
pnpm typecheck
pnpm test
~~~

link-dsh-deps 只用于本地开发。发布验收必须在没有这些 symlink 的 package tarball 和全新 DSH profile 中运行。

## 4. 独立 UI

~~~bash
bash scripts/start-standalone-ui.sh
~~~

默认 http://127.0.0.1:18610。Token 生成到 0600 文件并由用户在本地解锁页输入。可覆盖：

- DSH_SCHOLAR_STANDALONE_PORT；
- DSH_SCHOLAR_STANDALONE_KERNEL_PORT；
- DSH_SCHOLAR_STANDALONE_DATA。

目标 v2 独立 host 必须使用同源 BFF、正确流式 Artifact/SSE、locale 首屏和单一共享 UI。--no-token 只允许 loopback 明确开发，不作为默认文档路径。

## 5. DSH 嵌入测试实例

~~~bash
bash scripts/start-test-dsh.sh
~~~

脚本设置独立 DSH_HOME、web profile、Web 3081、Kernel 17412 并安装根插件。DSH 的 web 命令实际使用 profile 名 web，因此隔离来自不同 DSH_HOME，不要创建名为 test-web 却期望 dsh web 自动使用。

当前仓库迁移期验证：

~~~bash
curl http://127.0.0.1:3081/
curl http://127.0.0.1:17412/v1/health
curl http://127.0.0.1:3081/research-api/v1/health
~~~

目标 v2 完成后，根插件与独立 UI 合并为同一个 /research-ui-api BFF，再把检查升级为 /v2/health；capabilities 必须含 terminal_stream、tex_workspace 和 locales。当前脚本只安装根 research-plugin，不应把 :7412 推断成第二个 research-ui Kernel。

## 6. 开发模式启用 Cordis self-referential

它不是 dsh web --dev 的隐含能力，必须显式 overlay：

~~~bash
DSH_SCHOLAR_ENABLE_SELFMOD=1 bash scripts/start-selfmod-dev.sh
~~~

wrapper 使用独立 ~/.dsh-scholar-selfmod-dev、loopback Web 3082、Kernel 17414，并显式加载 research-dev-selfmod overlay。可用 DSH_SCHOLAR_SELFMOD_HOME/PORT/KERNEL_PORT 覆盖，但脚本拒绝 HOME、默认 ~/.dsh 和 /；未设置 DSH_SCHOLAR_ENABLE_SELFMOD=1 直接退出。shared、headless、unattended 和 approval=never 仍不支持。

验证流程：

1. cordis_inspect what=temporary；
2. cordis_mount 挂载只注册 dev_probe 的无害临时插件；
3. 下一轮调用 dev_probe；
4. cordis_inspect 确认 dyn-N；
5. cordis_unmount id=dyn-N；
6. 工具立即消失；重启后不恢复。

动态修改需要永久保留时，必须转为源码、测试和 docs 变更。不得复制 dyn-N 作为部署状态。

## 7. Runner

开发 smoke 可以显式 trusted fixture adapter。正式测试运行 Docker Runner，默认轮询 2s、heartbeat 15s、cancel poll 5s、timeout 60s（具体正式合同可覆盖）。Runner key 文件 0600；先注册 public key，再 claim。

Terminal 测试使用产生交错 stdout/stderr、长输出、非零退出、signal 和 cancel 的 fixture。TeX 使用固定 image digest，不依赖宿主 pdflatex。

## 8. 测试命令

以下是目标脚本面，生成项目必须在 package.json 实现；当前迁移仓库使用后面的现有命令：

~~~bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:ui
pnpm test:security
pnpm test:docker
pnpm test:golden
pnpm test:all
~~~

~~~bash
pnpm test
pnpm test:security
bash evals/docker-eval.sh
bash evals/golden-path-v2/run-golden-v2.sh
bash tests/security/run-latex-tests.sh
bash evals/clean-room-rerun.sh
~~~

CI 中 Docker、TeX、Golden、clean-room 不允许因为依赖缺失而 skip 成功。

## 9. 数据清理

开发实例必须先停止进程，再删除它自己的显式 dataDir。不得使用未解析变量、通配符、HOME 根或 workspace 根作为递归删除目标。优先移动到 trash 或备份目录；发布/生产数据按 retention policy 清理。

## 10. Team/Cluster

团队模式改用 SSO Principal、PostgreSQL、S3/MinIO、K8s/Slurm Runner、mTLS internal interface 和集中日志。Browser 仍只走 BFF；Terminal SSE 可由 gateway 转发。Cordis self-mod 在 shared/team 环境保持禁用。

## 11. 运维检查

- health instance/protocol/schema/database 匹配；
- migration 与 backup 成功；
- DB WAL、CAS 空间、孤儿 Blob、过期 lease、孤儿容器；
- Terminal retention/连接数/dropped bytes；
- TeX build queue、image digest 和 PDF Artifact；
- Outbox backlog；
- Runner key 有效期；
- production tool catalog 无 cordis_*；
- zh/en locale 资源 revision 和客户端 bundle 一致。
