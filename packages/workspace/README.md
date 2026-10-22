# @locus/workspace

面向显式工作区目录的普通任务定义，供 `@locus/tasks` 或调用方自己的 runner 使用。无外部依赖，不使用 class。

## 用法

```js
import { createWorkspaceTasks } from '@locus/workspace';

const tasks = createWorkspaceTasks({ root: process.cwd() });
// => [workspace.inspect, workspace.check]
```

`root` 必须是显式的非空目录字符串，相对路径按创建时的 cwd 解析。任务只读取 `root/package.json` 与 `root/pnpm-workspace.yaml`（或 `package.json` 的 `workspaces` 字段），**不会向上扫描祖先工程**。每次 `run` 都重新读文件，不缓存配置或成功结果。

## 任务

### `workspace.inspect`

- 输入：无（`{}` 或省略）。
- 权限：`[]`；effects：`['filesystem:read']`。
- 返回：

```js
{
  root,
  package: {
    source,         // package.json 绝对路径
    name, version, packageManager,
    scripts,        // 原始 name -> command
    scriptNames,    // 排序后的脚本名
    summary,        // "name@version; N script(s)"
  },
  workspace: null | {
    source,         // 'pnpm-workspace.yaml' | 'package.json#workspaces'
    path,
    text,           // YAML 原文（不解释成员集合）；JSON workspaces 则返回 packages
    summary,
  },
}
```

缺少 `pnpm-workspace.yaml` 或 `workspaces` 字段时 `workspace` 为 `null`，其余信息照常返回；不假定目录一定是完整的 workspace。

`pnpm-workspace.yaml` 保留为原始证据，不自行解析或宣称已确认成员集合。初版手写的部分解析器错误解释了双引号转义，已删除；不为本轮展示配置引入 YAML 依赖。若要确定实际成员，应另行授权运行 pnpm 的查询接口。JSON `workspaces` 字段可直接提供 `packages`。

### `workspace.check`

- 输入：`{ script: string }`，脚本名必须与当前 `package.json` 的 `scripts` 键**精确相等**，不会当作命令片段解释。
- 权限：`['process:execute']`；effects：`['filesystem:read', 'process:execute']`。
- 流程：`context.step('inspect', ...)` 读取配置并确认脚本存在；`context.step('execute', ...)` 再次读取配置后调用 pnpm。读取失败或脚本不存在时不会启动任何进程。
- `check` 只依赖 `package.json`；缺少 `pnpm-workspace.yaml` 不影响脚本执行。
- 成功返回报告：

```js
{
  script, packagePath, packageName,
  scriptCommand,   // package.json 中实际选中的命令
  command,         // 实际 argv 数组，例如 [node, .../pnpm.mjs, 'run', '--', script]
  cwd, exitCode, signal, stdout, stderr, durationMs, launcher,
}
```

- 子进程非零退出、被信号终止或无法启动时，`execute` step 抛错，错误对象带可枚举的 `evidence`（上述命令、退出码、stdout、stderr 等）。`@locus/tasks` 会把 `evidence` 保留在失败 step 与顶层 `error` 中。

## pnpm 调用方式

不经过 shell，脚本名只作为独立 argv 传入；`pnpm run -- <script>` 中的 `--` 终止 pnpm 选项解析，避免以 `-` 开头的脚本名被当成 pnpm 选项。启动器按以下顺序解析：

1. `npm_execpath` 指向的 pnpm CLI（在 `pnpm run` / `pnpm exec` 上下文中由 pnpm 设置），用当前 Node 执行；
2. Node 安装目录旁的 `node_modules/pnpm/bin/pnpm.[cm]js`（nvm 等布局）；
3. `PNPM_HOME/pnpm.exe` 或 Windows `PATH` 中的 `pnpm.exe`；
4. 非 Windows 直接使用 `PATH` 上的 `pnpm`。

Windows 上不能直接 `spawn('pnpm')`（ENOENT），也不能 `spawn('pnpm.cmd')`（EINVAL）：Node 不会执行 `.cmd` shim。因此本包优先执行 pnpm 的 JS entry。若环境只有 corepack 的 `.cmd` shim 且既无 `npm_execpath` 也无 `pnpm.exe`，会给出明确的启动失败证据，而不是退回拼接 shell 命令。

本实现只在当前仓库的 Windows + Node.js 24 + pnpm 11 环境实际运行过；其他平台的分支按 Node 标准接口实现，未在本轮实验中运行。

## 信任边界

- `permissions` / `effects` 是任务使用方与任务作者之间的声明，不是强制访问控制。
- `workspace.check` 执行的是仓库 `package.json` 中的真实脚本，脚本内容是**可信本地代码，不是沙箱**：它可以读写任意文件、访问网络或启动更多进程。
- 只应执行用户明确授权、当前仓库中真实存在的脚本。
- **递归陷阱**：在某个仓库的测试套件里检查该仓库的 `test` 脚本会再次运行整个测试套件（例如 `pnpm test` 递归调用自己），可能导致无限递归或资源耗尽。实验/上层 CLI 应选择非递归脚本，或在 fixture 中使用独立的小脚本。
