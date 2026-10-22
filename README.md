# Locus Prefix

通过真实工程任务验证 JS/TS 元机制。当前可用入口是一个显式模块驱动的本地任务工作台，不是插件框架或安全沙箱。

## 运行

Node.js 24、pnpm 11.24.0。所有命令在本工作区执行：

```sh
pnpm install --offline --ignore-scripts
pnpm locus list
pnpm locus show workspace.check
pnpm locus run workspace.inspect --allow filesystem:read
pnpm locus run workspace.check --input '{"script":"check:baseline"}' --allow filesystem:read --allow process:execute --grant process:execute
pnpm test
```

`check:baseline` 实际执行历史实验 1–3；`pnpm test` 执行全部实验。**不要在测试内部通过任务执行完整的 `pnpm test`，否则会递归运行自身。**

CLI 的 list/show/run 输出 JSON；任务开始前被拒绝或请求无效时退出码为 2，执行失败为 1，成功为 0。`pnpm` 自身可能在输出前打印脚本日志；程序需要纯 JSON 时，在完成安装后用 `node scripts/locus.js ...` 调用相同入口。

任务已完成但结果无法编码为 JSON 时，CLI 退出 1，并报告 `phase: "report"` 与真实 `executionStatus`；这不表示任务没执行，不能据此盲目重试。

默认不会自动授权：权限用重复的 `--grant` 指定，允许的副作用用重复的 `--allow` 指定。`workspace.check` 的 script 来自当前 `package.json`，不是任意 shell 命令参数。脚本本身仍然是可信代码，可调用外部工具并产生其他副作用；授权不是 OS 级权限控制，不能阻止脚本越界。

## CI/CD：运行标签相同，实际构建就正确吗？

新增的完整实验回答这个问题，而不是只运行健康检查。需要本机 Git：

```sh
pnpm demo:release
pnpm locus show deployment.audit
```

演示用真实 Git 提交、文件交付和本机 HTTP 目标复现：事件指向 A，实际构建工作树为 B，标签和健康仍能全绿；构建现场见证会拒绝该结果。干净检出 A 重建后通过，再将同一制品交付另一角色并重新观测。

这是单机角色模拟，不是跨物理机器部署。实际只读调查只有版本元数据、没有完整源码/制品见证时，返回 `incomplete`，不声称现场已经部署错。具体操作接口见[部署审计包](packages/deployment-audit/README.md)，证据和错误结论见[结论5](documents/conclusions/5-release-lineage.md)。

任务 `deployment.audit` 的输入为期望版本、运行元数据 URL、可选制品见证与 payload URL；需要 `--grant deployment:inspect --allow network:read`。审计任务执行成功不等于允许发布，应读取 `value.assessment.verdict`。公开材料不保存真实工程名称、地址或私有身份映射。

## 全流程：交付、配置排障、真相更新

```sh
pnpm demo:operations
```

实际启动匿名的独立 Node 进程，完成 Git 构建、制品与配置交付、失败请求、证据辅助诊断、修正覆盖并重启、再验收。随后实际更新 Markdown 运行手册，保留错误判断，提交并克隆知识与证据；第二个实例从克隆后的文档检索并选择已验证的方法。

演示输出 `artifactDirectory`：打开其中的 `knowledge/runbook.md`、`events.json` 和 `evidence/` 即可检查全链路。制品、目标配置和源码也保留在该目录下，所有子进程已停止；`temp/` 不进入 Git。自动测试使用独立目录并清理。

当前是单机多进程、本地流水线，不是物理多机或生产发布。`environment.json` 是部署环境配置层，不代表验证了操作系统环境变量注入。诊断为可解释领域规则，证据哈希不是自动真理认证。

参见[全流程结论](documents/conclusions/6-operations-truth-loop.md)与本次实际生成的[运行手册快照](documents/evidence/6-operations-loop/knowledge/runbook.md)。

## 添加任务

根目录 `locus.tasks.js` 是显式组合入口，default export 一个 `({ root }) => definitions` 函数。CLI 以当前工作目录为 root，读取其中的同名模块；模块可使用已有包或直接组合普通函数，不需要修改 CLI。

```js
import { createWorkspaceTasks } from '@locus/workspace';

const format = input => `report:${input.subject}`;

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
    run: input => format(input),
  },
];
```

模块导入发生在 list/show 阶段，因此仅加载可信模块。描述不是沙箱；validate 应无副作用。CLI 使用 JSON 传参和输出，任务结果和证据应适合 JSON 表达。包内使用普通 JS 值，不建立统一领域 Schema。

## 包与证据

- [`@locus/tasks`](packages/tasks/README.md)：描述发现、显式授权、单次执行与步骤结果。
- [`@locus/workspace`](packages/workspace/README.md)：读取真实配置、通过 pnpm 运行现有脚本、保留执行证据。
- [`@locus/deployment-audit`](packages/deployment-audit/README.md)：发布源码绑定、内容证据及缺证据判定。
- [`@locus/operational-knowledge`](packages/operational-knowledge/README.md)：证据绑定的 Markdown 修正与有条件复用。
- [`tests/4-task-execution/`](tests/4-task-execution/demo.test.js)：调用边界与部分成功。
- [`tests/5-workspace-integration/`](tests/5-workspace-integration/demo.test.js)：真实配置和子进程，以及配置变化。
- [`tests/6-cli/`](tests/6-cli/demo.test.js)：实际 CLI 的发现、拒绝、失败、修正和新增任务。
- [`tests/8-http-evidence/`](tests/8-http-evidence/demo.test.js)、[`9-release-contract/`](tests/9-release-contract/demo.test.js)、[`10-source-binding/`](tests/10-source-binding/demo.test.js)：取证、判定与完整交付反例。
- [`tests/11-operations-loop/`](tests/11-operations-loop/demo.test.js)、[`12-evidence-notebook/`](tests/12-evidence-notebook/demo.test.js)：基础设施到 debug、实际文档修正及知识复用。
- [案例1](documents/cases/1-heterogeneous-engineering-workspace.md)：长期问题域。

历史 `src/` 与实验 1–3 保留为第一轮基线；新包不是它们的兼容层。尚未证明的共享机制不提炼为 Core。当前不提供自动重试、自动补偿、断点续跑或永久执行历史。
