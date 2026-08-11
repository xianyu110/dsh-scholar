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
2. DSH：Agent plugin、subagent follow-up、Cordis self-mod 隔离与 lifecycle；
3. Remote：容器隔离、mTLS、fencing、binary CAS、断线恢复、Remote PTY；
4. Reproduction：真实 Docker/TeX、Golden Path、Release Bundle、clean-room；
5. Recovery/Security：撤权即时生效、多进程、kill/restart、长期 retention 与跨项目负向。

## 5. 结果回写规则

- PASS：在 hardening 对应行记录 commit、场景 ID、环境和报告链接；全部阻断场景通过后才升级“已验收”；
- FAIL：先把缺陷和关闭条件写回负责规范、`acceptance-tests.md` 与 hardening，再修改代码；
- BLOCKED：说明缺失环境或权限，保持 `NOT_RUN_MANUAL_PENDING`，不能计 PASS；
- 新需求或修复建议：遵守 docs/README.md 的文档先行规则，不得只留在人工测试聊天或截图中。
