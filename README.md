# Locus Prefix

**探索异构事物的共在与流畅；当前研究阶段已结项，保留可运行的工程零件、实验和可修正的知识。** Prefix 不是一个已经完成的统一元系统，也不是生产级运维平台。

- **共在（Coexistence）**：设施、代码、对象、操作、知识、人和 Agent 保留自己的语义、接口、身份与生命周期，仍能建立联系与协作。
- **流畅（Fluidity）**：发现、理解、引用、组合、执行与演化尽可能连续，减少不必要的转换、重复声明和人工接洽。

起点是 GIS／DevOps 和 Agent 工程工作空间中的实际摩擦：信息分散在文件、工具、服务和人的经验里，知道一个名字，不等于找到了当前目标；脚本执行成功，不等于现场满足意图。JS/TS 的对象、引用、函数和模块曾是很有吸引力的共同媒介：同一份结构既能描述，也能参与执行。但实践与历史比较逐步限定了这个设想：**语言中的连接不会自动带来外部事实、因果历史、授权或可恢复执行的连接。**

本阶段不再以形成独立 JS/TS 元系统、统一对象世界或 Locus Core 为预定终点。后续倾向于从具体任务出发，复用现有系统与 Agent Harness，在持续使用中检验新机制；**Locus Harness 是后续实践方向，不是本仓库已经实现的功能。** 这不证明通用 Core 无价值，也不证明原生脚本总体最优。

## 从哪里读起

1. **理解整个历程**：[项目回顾](documents/retrospective.md)——为何开始、做成什么、错在哪里、为何转向，以及仍未解决的问题。
2. **运行与复用**：下文的快速开始、工程成果与演示；包文档给出具体契约。
3. **查证研究判断**：[研究导航](#研究导航)——沿实验、结论及其后续限定阅读，不把历史记录当作当前保证。

## 快速开始

已验证环境：Windows、Node.js **24**（本次验收 v24.19.0）、pnpm **11.24.0**，另需本机 Git。其他平台未实际验证。所有命令在仓库根目录执行；演示只操作本工作区内的临时资产，并启动回环 HTTP 服务和本机子进程。

```sh
pnpm install --ignore-scripts --frozen-lockfile
pnpm locus list
pnpm locus show workspace.check
pnpm locus run workspace.inspect --allow filesystem:read
pnpm locus run workspace.check --input '{"script":"check:baseline"}' --allow filesystem:read --allow process:execute --grant process:execute
pnpm test
```

有依赖缓存时可用 `pnpm install --offline --ignore-scripts --frozen-lockfile`。JSON 参数示例适用于保留单引号的 shell（如 PowerShell／sh）；在 cmd.exe 中须按其规则转义双引号。

`check:baseline` 只执行历史实验 1–3；`pnpm test` 使用 Node test runner 执行全部实验。**不要在测试内部通过任务执行完整的 `pnpm test`，否则会递归运行自身。** 当前锁定的外部实验依赖为 Automerge 3.5.0、Vue reactivity 3.5.44；SQLite 使用 Node 内置模块。

CLI 的 `list/show/run` 输出 JSON。pnpm 可能先打印脚本日志，需要纯 JSON 时，在安装后使用相同入口：

```sh
node scripts/locus.js list
```

退出码为 0（任务成功）、1（执行或报告失败）、2（调用被拒绝／请求无效）。任务完成后若结果不能编码为 JSON，报告为 `phase: "report"` 并保留 `executionStatus`，**不能据此认为任务未执行并盲目重试**。

## 已实现的工程成果与保证边界

这些是工作区包及其公开接口，不是已经发布、经过生产验证的产品。

| 成果 | 已实现、可复用的能力 | 不能据此推导 |
| --- | --- | --- |
| [`@locus/tasks`](packages/tasks/README.md) | 普通对象／函数描述任务，发现、显式授权检查、单次执行、保留步骤及部分失败 | 安全沙箱、自动重试／补偿、调度或持久恢复 |
| [`@locus/workspace`](packages/workspace/README.md) 与 [CLI](scripts/locus.js) | 读取真实工作区配置，执行已有 pnpm 脚本，记录 argv、退出码及输出 | 统一资源发现、配置原子快照；YAML 原文展示不等于已解释成员集合 |
| [`@locus/deployment-audit`](packages/deployment-audit/README.md) | 独立采集 Git／HTTP 证据，区分声明、构建见证及指定 payload，返回一致／冲突／缺证据 | 完整制品认证、可重复构建、进程全部代码或业务正确；审计成功不等于允许发布 |
| [`@locus/operational-knowledge`](packages/operational-knowledge/README.md) | 在 Markdown 中保留原判断与修正，绑定证据字节，按条件和时效重新筛选 | 语义真值认证、作者认证、并发追加安全或通用冲突解决 |

**信任边界**：任务模块与脚本都是可信代码。`--grant` 和 `--allow` 是协作声明，不是 OS 访问控制；`list/show` 已会导入模块。哈希绑定字节，不证明来源可信或推论正确；步骤记录不能证明重试安全。包可以直接导入，不必通过 Locus 任务目录调用。

### 三条值得实际运行的路径

```sh
pnpm demo:release
pnpm locus show deployment.audit
pnpm demo:operations
node tests/14-workspace-evolution/scenario.js
```

- **发布取证**：真实创建 Git 提交 A/B，让事件与标签指向 A、实际构建来自 B，健康仍通过；构建见证判为 `mismatch`。干净检出 A 重建后 `consistent`，交付另一角色必须重新观测。只检查指定 payload，不代表整个发布正确。[结论5](documents/conclusions/5-release-lineage.md)区分公开反例与无法公开重放的脱敏现场调查；后者因缺证据为 `incomplete`，并未证明现场部署错误。
- **交付—排障—知识复用**：同一制品审计一致，但请求 502；清除配置覆盖文件仍 502，重启后 200。实际更新运行手册、提交并克隆证据，第二个实例按克隆后的记录选择方法。[结论6](documents/conclusions/6-operations-truth-loop.md)解释全部边界；`environment.json` 是文件配置层，不是 OS 环境变量注入实验。
- **持续演化**：同一工作空间经历入口替换、源码／交付变化、有界 WMS、知识动作门禁及新 Agent 的只读交接组合。旧 A/A、新 B/B 分别可成立，新期望 B 与旧运行 A 被拒绝；失效／冲突知识在动作前阻止受控写入；部分设施失败仍保留其他证据。[结论9](documents/conclusions/9-workspace-evolution.md)说明这是单次 Agent 发现证据，不是通用发现机制或可靠性测量。

这些是**单机角色／多进程受控实验**，不是跨物理机器、真实 SSH、生产 CI 或生产 GIS 验证。WMS 是生成真实 PNG 的有限协议替身，不是完整 OGC 兼容实现。

重跑实验14会执行已经保存的 Agent 交接消费者，验证其行为；不会重新发起一次 Agent 探索。历史发现过程见上述记录，不能由场景重跑推导新的 Agent 成功率。

`demo:release` 清理自己的临时资产；`demo:operations` 输出 `artifactDirectory`，保留实际 `knowledge/runbook.md`、`events.json` 和 `evidence/`；实验14输出临时证据目录并在结束时关闭资源。目录位于被忽略的 `temp/`。自动测试清理自己的实例，不依赖旧临时目录。仓库中的[历史证据](documents/evidence/)是已结束运行的快照，不是在线状态或永久有效的知识。

### 添加可信本地任务

根目录 [`locus.tasks.js`](locus.tasks.js) 是显式组合入口，default export `({ root }) => definitions`；CLI 以当前工作目录为 root 读取该模块。不需要修改 CLI 或继承基类：

```js
import { createWorkspaceTasks } from '@locus/workspace';

export default ({ root }) => [
  ...createWorkspaceTasks({ root }),
  {
    name: 'local.report',
    description: '生成本地摘要',
    input: { description: 'subject 字符串', example: { subject: 'workspace' } },
    permissions: [], effects: [],
    validate(input) {
      if (typeof input?.subject !== 'string') throw new Error('subject required');
    },
    run: input => `report:${input.subject}`,
  },
];
```

这是自行组合时的示例，不替换仓库已有的部署审计任务。`validate` 应无副作用；CLI 的描述与结果须适合 JSON 表达。普通 JS 值不需要进入统一领域 Schema。完整调用契约见[任务包](packages/tasks/README.md)。

## 研究导航

按问题而非全部实验逐项阅读；每个实验的 `demo.test.js` 是可运行实例与断言入口，结论文档的 front matter 指向复现标签。

| 问题与转折 | 实验／实现入口 | 结论与必要限定 |
| --- | --- | --- |
| 原生身份、操作与经验需要什么额外机制？ | [1 身份](tests/1-id/demo.test.js)、[2 操作](tests/2-ops/demo.test.js)、[3 经验](tests/3-exp/demo.test.js)、历史 [src](src/) | [1 基线](documents/conclusions/1-core.md)；身份注册的必要性表述被[2](documents/conclusions/2-workspace-tasks.md)收窄 |
| 可运行的统一入口是否已经有工程价值？ | [4 任务](tests/4-task-execution/demo.test.js)、[5 工作区](tests/5-workspace-integration/demo.test.js)、[6 CLI](tests/6-cli/demo.test.js) | [2 工程闭环](documents/conclusions/2-workspace-tasks.md)、[3 价值审查](documents/conclusions/3-operational-experiments.md)、[4 范围与脱敏](documents/conclusions/4-infrastructure-scope.md) |
| 什么证据足以支持发布与配置判断？ | [8 HTTP](tests/8-http-evidence/demo.test.js)、[9 判定](tests/9-release-contract/demo.test.js)、[10 源码绑定](tests/10-source-binding/demo.test.js)；[11 全流程](tests/11-operations-loop/demo.test.js)、[12 笔记本](tests/12-evidence-notebook/demo.test.js) | [5 发布溯源](documents/conclusions/5-release-lineage.md)、[6 真相更新](documents/conclusions/6-operations-truth-loop.md) |
| API 更短、身份相等、冲突有标签，是否足够？ | [13 API 对照](tests/13-api-expression/demo.test.js)、[消费端研究](documents/api-expression-study.md) | [7 初次判断](documents/conclusions/7-api-expression.md)必须连同[8 撤回与限定](documents/conclusions/8-api-review.md)阅读：没有等价成本排名，冲突标签当时未控制动作 |
| 持续变化与新 Agent 能否复用现有设施？ | [14 连续演化](tests/14-workspace-evolution/demo.test.js)、[研究记录](documents/workspace-evolution.md)、[成本审查](documents/evidence/9-workspace-evolution/cost-review.md)、[发现记录](documents/evidence/9-workspace-evolution/agent-discovery.md) | [9 局部复用与状态责任](documents/conclusions/9-workspace-evolution.md)；没有长期成本或任意 Agent 成功率证据 |
| 因果合并、派生判断、本地事务能否替代彼此？ | [15 Automerge](tests/15-causal-history/demo.test.js)、[16 Vue／SQLite](tests/16-derived-decisions/demo.test.js) | [10 语义边界](documents/conclusions/10-semantic-boundaries.md)：收敛不是真理，图外变化需摄取，本地意图不自动约束外部动作 |
| 共在与流畅是否必须来自一个新系统？ | [范式比较](documents/paradigm-study.md)、[因果历史](documents/causal-history-study.md)、[执行与互操作](documents/execution-history-study.md) | [11 历史路径](documents/conclusions/11-coexistence-lineage.md)：共同活世界、窄接口联邦和强历史／执行基底仍是竞争方向 |

长期问题域见[案例1：持续演化的工程工作空间](documents/cases/1-heterogeneous-engineering-workspace.md)；它定义研究情境，不是已完成的产品规格。全部[结论](documents/conclusions/)保留历史判断及相互修正关系。Nix、Pulumi、Temporal、Smalltalk／Self、Unison、Goblins 等在本仓只做文献／源码研究，**没有运行这些外部引擎**；Automerge、Vue、SQLite 则有上述实际实验。

进一步复现语义反例：

```sh
node tests/13-api-expression/scenario.js
node tests/15-causal-history/scenario.js
node tests/16-derived-decisions/scenario.js
```

实验13保留工作区临时材料并停止进程；实验15在内存运行；实验16创建并清理临时数据库和实际文件副作用。单独运行任意断言入口可用 `node --test tests/<编号-语义>/demo.test.js`。需要历史版本时，在独立检出中使用结论 `commit` 字段的标签，并按该版本说明运行，不将当前依赖或测试数量倒填为历史证据。

## 阶段结束之后

值得继承的是领域取证与判定、窄函数边界、证据绑定且可撤回的知识、变化与部分失败的可执行反例，以及敢于修正问题定义的研究方法；不是一套必须延续的架构。

后续 Locus Harness 实践可以先组合现有工具、协议和文档，记录实际任务的上下文重建、转换、验证与恢复成本，再判断需要什么共享机制。仍待验证的重点包括：长期人／Agent 总成本、离线反证与有界授权的关系、版本前提如何延伸到真实执行器、成熟工作流的崩溃恢复，以及共同活环境是否在特定任务中更值得其代价。详见[回顾中的未解问题](documents/retrospective.md#尚未解决的问题与下一段实践)。本阶段结项不关闭这些问题，也不把它们改名为 Prefix 已交付的能力。
