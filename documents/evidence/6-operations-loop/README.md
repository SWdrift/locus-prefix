# 全流程运行快照

来自实际运行的 `scripts/operations-demo.js`（`pnpm demo:operations` 的入口）：匿名本机子进程、临时Git源码、制品及配置文件，非生产环境。捕获时所有进程已停止。

- [原始手册](knowledge/runbook.before.md)与[修正后手册](knowledge/runbook.md)：原判断保留；新增修正、适用条件、有效期、证据哈希与处理步骤。
- [故障证据](evidence/incident.json)：健康与发布审计通过，但请求失败，记录当时的诊断假设。
- [修复证据](evidence/repair.json)：修改环境文件后未重启仍失败，重启后恢复，同一制品未变化。
- [知识复用](evidence/repeat.json)：新实例重新观测，从Git克隆后的文档与证据中检索适用记录，再执行验证过的方法。
- [基础设施快照](infrastructure.json)、[执行轨迹](events.json)、[摘要](summary.json)：同一次运行的实际阶段、资源登记/停止状态与结果。

复制时已校验手册记录的证据SHA-256，文件内容未作重写。角色名、回环端口、实例标识及源码提交都由本地实验生成；不含真实工程的身份或映射。

这是历史快照，不是当前在线状态。手册记录有明确到期时间，过期后不应据此自动执行操作；历史验证应使用记录当时的时间与条件。重新运行演示会产生新的现场与新文档。`summary.json` 中的 `artifactDirectory` 指向生成此快照时的本地目录，并非公共仓库中的固定路径。

复现与边界见[结论6](../../conclusions/6-operations-truth-loop.md)。
