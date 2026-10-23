# Locus Prefix

**Locus Prefix 的研究阶段已结束。** 项目探索异构事物的**共在（Coexistence）与流畅（Fluidity）**：让设施、代码、对象、操作、知识、人和 Agent 保留各自的语义与生命周期，同时能够被发现、理解、连接、组合和演化。

研究始于 GIS、DevOps 和 Agent 工程实践中的信息割裂、重复声明、人工接洽与状态失真。我们尝试以 JS/TS 的对象、函数和模块作为共同媒介，并通过工程实验检验其价值。

**最终结论：不再以构建统一元系统或 Locus Core 为目标。** 原生语言能够连接对象与操作，却不能自动解决外部事实、因果历史、授权和可靠执行。现有工具、协议及 Agent Harness 已覆盖大量需求；新机制应从实际任务中产生，而非预先追求统一。

本仓库保留可运行的工程成果、实验与允许被修正的研究结论。后续转向 **Locus Harness** 的实践探索，但它不是本仓库已实现的功能。

## 工程成果

| 包                                                                         | 能力                               |
| -------------------------------------------------------------------------- | ---------------------------------- |
| [`@locus/tasks`](packages/tasks/README.md)                                 | 任务发现、授权声明、执行及步骤记录 |
| [`@locus/workspace`](packages/workspace/README.md)                         | 工作区配置、脚本调用与 CLI         |
| [`@locus/deployment-audit`](packages/deployment-audit/README.md)           | Git／HTTP 证据采集与发布一致性判定 |
| [`@locus/operational-knowledge`](packages/operational-knowledge/README.md) | 证据绑定、知识修正与条件筛选       |

这些是可复用的本地工程零件，**不是生产级平台**。任务执行不提供安全沙箱、自动恢复或事务保证；证据一致不等于业务正确；知识记录不等于事实认证。

## 快速开始

已验证环境：Windows、Node.js 24、pnpm 11.24.0、Git。

```sh
pnpm install --ignore-scripts --frozen-lockfile
pnpm locus list
pnpm locus show workspace.check
pnpm locus run workspace.inspect --allow filesystem:read
pnpm test
```

运行主要演示：

```sh
pnpm demo:release
pnpm demo:operations
node tests/14-workspace-evolution/scenario.js
```

演示涉及本地 Git、HTTP 服务、文件及子进程；临时产物位于 `temp/`。任务代码视为可信代码，`--allow`／`--grant` 不构成操作系统级权限隔离。执行后的报告失败也不代表任务没有发生，不能盲目重试。

## 研究结论

1. **统一入口有价值，但统一模型并非必要。** 原生对象与函数结合少量显式契约，已经能够完成部分实际任务。[结论 2](documents/conclusions/2-workspace-tasks.md)
2. **执行成功不等于目标达成。** 发布、配置与运行状态需要独立证据及重新观测。[结论 5](documents/conclusions/5-release-lineage.md) · [结论 6](documents/conclusions/6-operations-truth-loop.md)
3. **持续演化要求管理前提与失效。** 旧知识、旧状态和部分失败必须能够被识别；局部实验尚不足以证明长期收益。[结论 9](documents/conclusions/9-workspace-evolution.md)
4. **不同机制解决不同问题。** Automerge 的因果合并、Vue 的派生更新和 SQLite 的本地事务不能相互替代，更不能自动保证外部执行正确。[结论 10](documents/conclusions/10-semantic-boundaries.md)
5. **统一世界不是唯一发展路径。** 共同活环境、窄接口联邦及强历史／执行基底各有收益和成本，目前没有充分证据选定唯一方案。[结论 11](documents/conclusions/11-coexistence-lineage.md)

实验主要在单机、多进程及受控替身环境下进行，不构成生产 GIS、SSH 或 CI 的验证。历史研究判断可能已被后续实验修正。

## 文档与后续

- [项目回顾](documents/retrospective.md)：完整历程、决策与未解决的问题。
- [研究结论](documents/conclusions/)：按时间保留判断及修正。
- [实验目录](tests/)：可运行的场景与断言。
- [工程工作空间案例](documents/cases/1-heterogeneous-engineering-workspace.md)：长期研究情境。

下一阶段从具体任务出发，组合现有 Harness、工具与协议，观察上下文重建、验证、恢复及人／Agent 协作的实际成本，再决定是否需要新的共享机制。

**Prefix 留下的不是一套必须延续的架构，而是可复用的能力、可重放的反例，以及继续修正问题定义的依据。**
