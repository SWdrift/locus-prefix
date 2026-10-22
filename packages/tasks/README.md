# @locus/tasks

可信代码的任务目录与单次执行。任务用普通对象和普通（可异步）函数描述，不依赖 class，无外部依赖。

## 用法

```js
import { createTasks } from '@locus/tasks';

const tasks = createTasks([
  {
    name: 'math.double',
    description: '把输入数值翻倍',
    input: { description: '数值', example: { value: 3 } },
    permissions: [],
    effects: [],
    validate(input) {
      if (typeof input?.value !== 'number') throw new TypeError('value must be a number');
    },
    async run(input, context) {
      return context.step('double', async () => input.value * 2);
    },
  },
]);

tasks.list();        // 元数据数组，按定义顺序
tasks.show('math.double');
await tasks.run('math.double', { value: 3 }, { permissions: [], allowedEffects: [] });
```

## 目录

- `list()` 返回全部任务描述；`show(name)` 返回单个任务描述。输入描述通过原生 `structuredClone` 隔离，必须可结构化克隆；不暴露执行用的 `validate`/`run`，修改返回值不影响目录或后续执行。CLI 进一步要求描述与结果适合 JSON 表达。
- 未知任务调用 `show` 会抛出 `Error`；`run` 不抛普通失败，而是返回结构化结果。
- 创建时校验收到的定义：名称唯一且非空、描述与输入描述为字符串、`permissions`/`effects` 为元素非空的字符串数组（可为空数组）、`run` 为函数、`validate` 存在时必须为函数。非法定义抛出错误。

## 执行结果

```js
{
  task: 'math.double',
  status: 'succeeded', // 'succeeded' | 'blocked' | 'failed'
  value: 6,
  steps: [{ name: 'double', status: 'succeeded', value: 6 }],
}
```

- `blocked`：任务不存在、缺少 `permissions`/`allowedEffects` 中声明的授权，或 `validate(input)` 抛出/拒绝。此时不会调用 `run`，`steps` 为空；结果带 `error.message`。
- `failed`：`run` 或其中某个 `step` 抛出/拒绝。已经完成的步骤保留在 `steps` 中，失败步骤带 `error`。结果顶层的 `error` 是同一错误的摘要。
- `succeeded`：`run` 正常返回，`value` 为其返回值。

`context` 为 `{ permissions: [], allowedEffects: [] }`，`run` 实际收到的是 `{ permissions, allowedEffects, step }`。`step(name, asyncFunction)` 顺序执行函数、记录 `succeeded`/`failed` 步骤，并把失败的原错误继续抛给 `run`。普通失败和步骤失败都通过结果返回，不向调用方抛出。

错误摘要至少包含 `message`，并保留抛出的错误对象上的自有可枚举属性，例如 `evidence`、`code`、`exitCode`、`stdout`、`stderr`。因此子进程等失败证据会同时出现在失败步骤和顶层 `error` 中。

没有自动重试、补偿或调度：每次 `run` 调用只执行一次；修正外部条件后再次 `run` 才会重新执行。

## 信任边界

`permissions` 和 `effects` 是目录使用方与任务作者之间的协作声明，不是强制访问控制。`run` 调用方必须自行决定授予哪些值；`validate`/`run` 都是进程内可信代码，可以产生任意副作用。本包不提供沙箱、隔离，也不能约束任务启动的子进程或文件系统行为。
