# API 表达与演化：消费端研究记录

状态：已完成阶段 A–D；A 草案先于本轮实验实现记录，不是确定架构。关联[案例1](cases/1-heterogeneous-engineering-workspace.md)的接入、非标准接口、替换、不完整信息和知识复用情境。本文保留先前判断、变化推演及运行后的限定，旧结论不改写。

## A：已有证据与 API 差距

已读仓库规则、README、案例1、结论1–6及提交历史。历史不是必须延续的架构。

| 已有成果 | 已验证范围 | 消费端缺口 |
| --- | --- | --- |
| [身份、操作、经验](conclusions/1-core.md) | 恢复边界、显式 call trace、模拟连接策略 | 内存对象无需第二套 ID；连接 revision 由人同步；不是自动变化发现 |
| [任务与工作区](conclusions/2-workspace-tasks.md) | list/show/run、调用前协作授权、真实 pnpm、部分失败 | 普通函数增加 name/input/permissions/effects/validate/run；组合需显式 step；声明不证明真实行为 |
| [研究价值审查](conclusions/3-operational-experiments.md) | 机制正确性不等于工程价值 | 没有原生基线，不足以认定统一入口减少接洽 |
| [范围](conclusions/4-infrastructure-scope.md) | 选题和公开边界决定，不是新实验 | 真实设施不自动成为合适任务；本轮不用私有目标 |
| [发布审计](conclusions/5-release-lineage.md) | Git/制品/HTTP内容证据，缺证据 unknown | 已是独立普通函数；无需再包进目录才能使用；声明相同不是独立验证 |
| [知识闭环](conclusions/6-operations-truth-loop.md) | 配置覆盖、重启干预、证据化 Markdown 有条件复用 | 适用条件仍由领域选择；没有通用冲突消解、变化传播或语义认证 |

当前 API 的主要偏差不是缺少一个统一对象类型，而是默认从“执行什么任务”开始，消费者为了发现和记录普通调用必须进入任务定义；真实对象、原生方法与组合本身却已经存在。任务调用成功、发布判定通过、请求就绪是不同命题，不应合并为一个 success。

需区分三个问题：原生引用如何继续有效；历史观测属于哪次实例；历史知识的适用条件是否仍成立。动态解析只能处理第一个问题的一部分，不能代替后两个问题。

## 同一任务与验收条件

选择已有实验11的本地工程设施：Git构建一个网关制品，活动/退役后端、网关独立 Node 进程，环境覆盖优先于文件且启动时加载。任务为“验收指定制品的网关；配置错误时依据已有知识处理，连接和实例替换后重新验收”。不增加领域功能。

非标准接口为实验服务自定义 diagnostics 配置来源字段与 `environment.json` 覆盖文件；不是标准服务管理协议。复用现有 lab 的专用控制函数，不把它提升为通用 Core。连接替换比较按角色访问的 lab 接口与直接 HTTP 取证；两者仍在同机，不代表 SSH/生产网络验证。

共同验收：初始字节一致但请求502；清空文件后仍502；重启后200；新实例重新观测；旧引用/旧证据不得冒充新实例；冲突证据不按“最新覆盖”吞掉；制品/配置模型改变时不复用旧知识。真实工具为 Git、Node、文件、HTTP；受控设施不能冒充生产事故。

## 基线：普通 JS + 工具 + Agent

以下 `inspect` 是已有适配函数，返回实验11的观测形状；`assessRelease` 是现有包的纯函数。消费组合只有普通函数，没有新执行协议。

```js
import { assessRelease } from '@locus/deployment-audit';

const accept = async inspect => {
  const observation = await inspect();
  return {
    observation,
    release: assessRelease({ expected, artifact, runtime: observation.runtime }),
    ready: observation.request.status === 200,
  };
};
let connection = { inspect: () => lab.observe('gateway-a') };
const run = () => accept(connection.inspect);
const before = await run();
// 工程边界更换，而非更新所有消费者。
connection = { inspect: () => lab.observe('gateway-b') };
const after = await run();
```

`expected/artifact/lab` 来自同一次 lab.build/startGateway。Agent 阅读模块/README、现有工具结果；要机器可枚举契约时可增加普通导出对象，这本身不需要 Locus。失败依靠原生异常；调用者负责保留证据和目标信息。刻意保留 `const cached = connection.inspect` 反例：对象替换不会改写已保存函数。

## 草案 A：函数身份上的可选说明，不接管执行

```js
const contracts = new WeakMap();
const describe = (fn, contract) => {
  contracts.set(fn, Object.freeze({ ...contract }));
  return fn; // 相同函数，不包装、不注册对象或字符串解析。
};
const inspect = describe(() => lab.observe('gateway-a'), {
  summary: '读取网关发布、请求及启动时配置来源',
  input: '无参数', effects: '本地HTTP只读',
  limit: '多次请求不是原子快照；不证明远端身份',
});
const exposed = { inspect }; // 显式导出边界，而非扫描整个对象世界。
const discover = () => Object.entries(exposed).map(([name, fn]) => ({
  name, contract: contracts.get(fn) ?? null,
}));
const run = () => accept(exposed.inspect);
const result = await run();
exposed.inspect = describe(() => lab.observe('gateway-b'), contracts.get(inspect));
```

新增语义只有“在指定导出边界按函数身份查询说明”。直接函数调用无 trace、无授权、无自动失效。替换函数必须重新关联说明；不能声称 WeakMap 内容天然完备。浅冻结只适用于这里的扁平字符串说明。与普通导出 `{fn, description}` 相比可能没有独立包价值。

## 草案 B：显式采集边界与观测归属，不注册能力

```js
const capture = async (subject, inspect) => ({
  subject: { ...subject }, observation: await inspect(),
});
const sameSubject = (a, b) => a.instanceId === b.instanceId &&
  a.connection === b.connection;
const requireCurrent = (evidence, current) => {
  if (!sameSubject(evidence.subject, current)) throw new Error('stale evidence');
  return evidence.observation;
};
let subject = { instanceId: gateway.instanceId, connection: 'role-api' };
let inspect = () => lab.observe('gateway-a');
const evidence = await capture(subject, inspect);
const observation = requireCurrent(evidence, subject);
const report = assessRelease({ expected, artifact, runtime: observation.runtime });
// 替换时显式更新现场来源，再采集。旧证据保留而非被改写。
subject = { instanceId: replacement.instanceId, connection: 'http' };
inspect = replacementInspect;
const next = await capture(subject, inspect);
requireCurrent(next, subject);
```

不是通用版本图：subject 是本任务的领域选择，`connection` 只是来源标签，不证明远端身份。实现实验时还需检查返回 observation.instanceId 与声明一致，记录失败所属 subject；调用前后变化必须报为未固定观测，不能偷偷重试。原始函数仍能绕过边界。显式机制可删成十余行普通代码；独立 Locus 价值待证。

## 草案 C：调用时动态投影（只投影这一个连接面）

```js
const events = [];
let connection = { inspect: () => lab.observe('gateway-a') };
const view = new Proxy({}, {
  get(_target, key) {
    if (key !== 'inspect') return undefined;
    return async (...args) => {
      const selected = connection;
      try {
        const value = await selected[key](...args);
        events.push({ key, status: 'succeeded', instanceId: value.instanceId });
        return value;
      } catch (error) {
        events.push({ key, status: 'failed', error: error.message });
        throw error;
      }
    };
  },
});
const cached = view.inspect;
const before = await accept(cached);
connection = { inspect: replacementInspect };
const after = await accept(cached); // 调用时取新连接，不是保存旧函数。
```

只承诺顶层方法动态查找，不递归代理普通对象、不推导权限或配置依赖。显式暴露键需维护；无 `ownKeys` 时 Agent 连枚举都得不到。函数在调用开始时选定连接，await 期间替换不能让该次观测自动归属新实例。闭包里未经过 view 的依赖不可见。给 Proxy 添加完整反射/依赖/持久化不是本轮补救路径。

## 外部语义依据

- [MDN import](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import)：ESM 导入是 live binding；从普通对象解构出来的函数不是 live binding。基线可以由模块边界显式重绑定，不能宣称只有 Locus 能替换依赖。
- [MDN Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy)：只能拦截经过代理的操作，代理有不同对象身份与反射不变量，不等于透明追踪所有原生对象。

## 阶段 A 决策

不扩展 Core。保留基线，最小实现 A 的导出说明、B 的显式归属检查、C 的单层动态投影；共享相同领域 accept 函数和设施。优先检验“动态跟随是否掩盖目标变化”和“显式观测边界是否比手写检查更有价值”，不以语法更短作为胜出依据。Agent 可靠性先检查可枚举信息及可执行边界；未经独立 Agent 行为试验，不声称模型能可靠理解任意元数据。

## B：先推演变化，再实现

下表是代码语义推演，**不是运行结果**。四条路径使用相同 accept 领域组合；不让基线故意漏掉已有工具或普通 JS 可实现的检查。

| 变化/反例 | 原生基线 | A 函数说明 | B 显式采集 | C 动态投影 |
| --- | --- | --- | --- | --- |
| 接入已有角色 API、组合发布与请求验收 | 注入 inspect 即可 | 同左；额外四项说明 | 同左；额外实例和连接来源 | 同左；额外可投影方法边界 |
| 自定义配置协议 | lab 专用适配 | 无法从说明自动适配 | 无法从 subject 自动适配 | 代理也无法理解协议 |
| 新增 gateway-b | 新建连接，组合不改 | 新函数需关联说明 | 新 subject，新采集 | 替换 connection |
| 保存方法后替换连接 | 保存的是旧函数；显式 getter/ESM 可解决 | 相同；WeakMap 不改变引用语义 | 旧证据与新 subject 不匹配则拒绝 | 保存方法跟随新连接，可能静默换了目标 |
| 连接换成直接 HTTP | 改一个边界适配 | 改适配并维护说明 | 改适配和来源标签 | 改适配；动态查找不是协议适配 |
| 同一实例未重启，文件已修正 | 必须重新取证，文件不代表进程 | 相同 | subject 不变也不代表配置没变 | 同样无法拦截外部文件变化 |
| await 期间替换目标 | 此次保留旧调用的返回值 | 相同 | 前后 subject 对比可拒绝；非原子保证 | 若日志用返回时 current，会错归；必须在开始固定连接 |
| 闭包捕获旧 inspect | 调用方修复闭包 | 说明不会发现它 | 显式边界可检查已声明 subject，但不能发现所有隐藏依赖 | 闭包内部绕过代理，不会被追踪 |
| 同条件两条相反知识 | 阅读/领域策略决定，不能自动选最新 | 说明无帮助 | 来源归属不证明语义 | 自动 trace 不证明语义 |
| 制品/配置模型变化 | 复用现有知识包条件检查 | 相同 | 相同；不能只比较实例 ID | 相同；对象引用仍可用不代表知识仍有效 |

### 不用补丁挽救的结构性失败

1. A 的函数说明可以被普通模块导出对象替代；若无第二个消费者需要同样查询，不提炼包。函数替换后忘记关联，说明立即缺失；沿用旧说明也可能错。
2. B 的 subject 是显式第二份断言，必须与实际响应核对。外部实例不返回身份时，只能报告未知，不能靠来源标签宣称目标正确。相同实例中的状态变化仍需新观测。
3. C 看似让旧引用“继续成立”，实为改了引用含义。保存函数原本固定一个实现，现在随 mutable connection 跳转；既不能保证历史归属，也不能发现闭包依赖。不添加递归代理或完整反射去挽救。
4. 所有方案都必须保留矛盾知识；既有知识包校验的是证据字节与条件，不会消解相反修正。新增 API 不应掩盖这个领域决策。

### 最小运行选择

四条路径都保留可执行消费模块，区分机制只留在本实验，不发布包。复用实验11 lab 和现有 audit/knowledge 包；不修改 `tests/lib` 或历史实现。专门运行：缓存方法替换、显式旧证据拒绝、调用中变化、代理外闭包、缺失说明。共同设施路径只启动一次，四方案读取同一阶段现场，避免四套复制设施使比较失真。知识复用与冲突使用同一 Markdown 文件、同一证据与条件，独立于表达方案。

## C：实际消费入口与验证范围

- [consumers.js](../tests/13-api-expression/consumers.js)：四个完整消费者、共同 `accept`、三种局部机制。不是包的新增公共接口。
- [scenario.js](../tests/13-api-expression/scenario.js)：完整实例的构造、取证、专用接口适配、替换、知识选择及停止。直接运行 `node tests/13-api-expression/scenario.js`，输出实际证据目录；自动测试不保留目录。
- [demo.test.js](../tests/13-api-expression/demo.test.js)：共同生命周期、目标混淆、变化期间归属和知识冲突的行为断言。

实际实现有两点比草案明确：B 检查响应实例身份，区分 `STALE_EVIDENCE`、`SUBJECT_CHANGED`、`INSTANCE_MISMATCH`；C 在开始时固定连接并记录来源，不把旧调用错误归到返回时的新连接。没有加入递归代理、重试、依赖图或永久历史。

### 观察与消费成本

以下运行观察来自本轮实际 smoke，程序产物在其输出的 `temp/api-expression-*/` 中。受控日志含本机随机实例标识和回环地址，无生产身份。失败解释与断言留在实验中，不依赖临时目录才能复现。

| 比较项 | 原生基线 | A 函数说明 | B 显式采集 | C 动态投影 |
| --- | --- | --- | --- | --- |
| 同一组合跨实例/连接复用 | 成功 | 成功 | 成功 | 成功 |
| 保存方法再替换后的实际角色 | gateway-a | gateway-a | gateway-b | gateway-b |
| 新增声明 | 无机制元数据 | 4项字符串说明，显式导出，按函数关联 | 同4项说明，2项 subject 字段，显式证据记录 | 1个可投影方法名，2项来源字段，调用事件 |
| 正常替换维护位置 | 连接注入处1处；组合0处 | 相同，另须维护新函数说明 | 连接和 subject 构造处；组合0处 | 连接注入处；组合0处 |
| 缓存结果用于新实例 | 原始对象仍能读，需消费者检查 | 相同 | 本实验显式 reuse 拒绝 | 原始对象仍能读，需消费者检查 |
| 调用中改连接 | 返回原目标结果 | 返回原目标结果 | 拒绝，失败仍归开始目标 | 返回原目标结果，事件归开始目标 |
| 未经过边界的旧闭包 | 实际访问 gateway-a | 实际访问 gateway-a | 与声明 gateway-b 不符，拒绝 | 实际访问 gateway-a，无自动依赖发现 |
| 目标停止后的失败 | 原生异常，无额外来源信封 | 相同 | 失败事件保留开始 subject | 失败事件保留开始 subject |
| 本实验机器可读发现 | 仅导出名称，无结构化说明 | 名称及4项说明 | 显式提供名称及4项说明 | 最小 get 代理无法枚举 |
| 运行成本（未做计时） | 原生调用/领域返回值 | WeakMap及描述维护 | 每次复制subject、检查并保留事件/观测 | 每次属性读取生成闭包；每次调用保留事件 |

“1处”指本实验边界位置，不是任意工程都只需改一处。没有按行数评选，没有测量人类接洽时间。A/B 的说明是相同手写声明，不由实现推导；直接 HTTP 和角色接口使用同一说明，只描述共同的读取边界。两者均为可信模块，发现可能需要执行模块代码，不是无副作用自动扫描。

**公平性边界**：基线不使用本轮 describe/witness/projection，仍允许复用已有领域判定与知识包，正如它可复用成熟工具库。共同的 `assessRelease` 与知识校验不计为本轮 API 新收益。这里没有验证“删掉所有历史领域实现后重新手写发布/知识逻辑”是否更划算。原生基线也能手写与 B 完全相同的身份检查，或用普通 getter 达到 C 的动态解析；不能把基线没自动获得这些特性当作 Locus 独占价值。

### 保留的失败与限制

- 原判断“A 低成本地解决可发现性”：**受限**。新函数未重新关联时说明丢失；一份普通导出对象也能表达同样信息。新增设施仍需人写适配和约束。
- 原判断“C 可以透明保留组合”：**被反例否定其透明性**。缓存函数转向新角色，代理外闭包却仍访问旧角色；动态跟随和固定引用是不同语义。不补递归代理。
- 原判断“B 标记来源即可复用”：**被限定**。还要核对返回身份与适用条件。相同 subject 期间文件改动不会被自动发现；前后比较也不检测 ABA 变化，不提供原子快照、来源认证或不可变证据。
- 错误解释“哈希有效就能选择修复”：**被反例否定**。同条件、同证据的相反建议均返回；明确标注错误解释并保留。实验领域策略转为人工审查，没有让 API 擅自选择最新建议。
- 制品摘要变化、配置模型变化、到期：现有知识包均不再返回旧建议；同一制品与模型的新实例可选择旧方法，但仍执行现场检查和修复后验收。
- 这里的“制品摘要”沿用结论6/知识包字段名，实际值只绑定一个 payload，不是完整制品集合身份。

### 实现审查补充

现有任务目录 `packages/tasks/src/index.js:27–97,148–155` 的追踪仅覆盖显式 step；`locus.tasks.js` 是数组组合，不会发现函数闭包依赖。工作区包执行前重读配置，但没有变更影响图或原子读取保证。

`packages/deployment-audit/index.js` 直接导出独立领域函数，任务适配器 `tasks.js` 不是其必要入口。`packages/operational-knowledge/index.js:63–97` 重查条件和字节，不证明 correction 被 evidence 蕴含。两包已经展示“普通模块可复用”，不需要重新登记为统一设施。

完整提交历史与历史错误仍可按结论1–6对应标签追溯。

## D：研究决策

正式结论见[结论7](conclusions/7-api-expression.md)。本轮不选定总架构，不创建包，不重构 Core。可继续投入的是“原生模块组合 + 必要边界的显式观测”，而不是把普通对象转成另一套运行时对象世界。尚无证据证明这层边界需要成为 Locus 通用机制。
