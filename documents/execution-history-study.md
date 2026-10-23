# 执行、构建与能力互操作：历史比较及保证边界

本轮专题研究成果，关联[案例1](cases/1-heterogeneous-engineering-workspace.md)的变化、失败、知识修正与跨设施组合；与[本轮范式比较](paradigm-study.md)、[因果历史专题](causal-history-study.md)互补。本文不修改[结论5](conclusions/5-release-lineage.md)、[结论6](conclusions/6-operations-truth-loop.md)和[结论9](conclusions/9-workspace-evolution.md)的既有实测范围，也不提出公共 Core。

## 1. 证据等级与比较问题

- **文献事实**：直接阅读下文链接的一手论文、规范、项目文档及 Temporal TypeScript SDK 源码。Nix CLI 引用固定的 2.28 手册；MCP 引用固定的 `2025-11-25` 规范。其他滚动文档、`main` 源码是本次查阅时的内容，不是永久锁定的实现快照，也不代表“所有版本均如此”。
- **已运行证据，主线程报告**：本轮[实验16](../tests/16-derived-decisions/demo.test.js)的 Vue 3.5.44／SQLite 3.53.3 行为由主线程运行并报告；本专题作者读取了[场景源码](../tests/16-derived-decisions/scenario.js)，未重复执行。本文不把该实验外推成 Temporal、Nix 或分布式协议的实测。
- **来源消费示例，未本机运行**：第6节所有外部系统代码、命令与协议流程均属此级别。没有安装或启动 Nix、Pulumi、Temporal、Goblins／OCapN，也没有运行 MCP 服务器互操作测试。
- **机制推论／待证伪假设**：跨系统组合推演明确单列。它们不是故障注入结果、吞吐测量或生产保证。

共同问题不是“谁能列出更多工具”，而是：**设施和知识持续变化时，组合凭什么跳过、重算、重试、授权或撤销一项操作？** 同一张执行图可能表达完全不同的承诺：

| 思想 | 原始问题 | 正确性的核心对象 | 不能由该对象直接推出 |
| --- | --- | --- | --- |
| 构建／声明式协调 | 不重复构建未变输入；让资源逐步符合期望 | 输入、派生物、依赖；或期望／记录状态与 provider 操作 | 现场此刻健康、已用新配置、数据库可回滚 |
| 持久工作流 | 进程／服务故障后继续同一项长期工作 | 某次执行的事件历史与兼容的控制流 | 旧观测仍然适用、外部副作用只发生一次 |
| 对象能力／协议互操作 | 使异构参与者能连接、调用且限制权力 | 可传递的引用／授权；或可协商的消息契约 | 调用被授权就正确、工具声明就是真实效果 |

三者不只是同一运行时的不同插件：构建器可以**正确地不执行**；工作流可以**正确地复用旧结果继续执行**；能力系统可以**正确地拒绝一个语法完全合法的调用**。

## 2. 构建与声明式协调：重算的对象不是现实世界

### 2.1 Make 到构建系统理论：不是“一个 DAG 运行器”

《[Build Systems à la Carte，2018][build-paper]》第2–5节把构建分成两个正交问题：scheduler 决定执行顺序，rebuilder 决定是否重建。其形式化正确性是：输入不被构建破坏；目标及其依赖的存储值与任务计算结果一致。它不是对任意外部效果的定义。

Make 的代表性取舍是静态依赖、拓扑调度和文件修改时间。它便宜、可解释，但未声明的编译器／环境依赖、时间戳与内容脱节会破坏判断。这里不能把论文对简化 Make 的模型说成所有现代 Make 扩展的完整规范。

更重要的反例来自同一论文：Shake 在读到 `release.txt` 后才能知道归档成员，支持动态依赖并暂停等待；Excel 与论文所研究的 Bazel 路径采用 restart；early cutoff 又是另一个选择。**统一为静态 DAG 会直接排除真实构建需求；统一为可重复调度的任意函数又会把副作用安全问题带进来。** 该论文的简洁抽象确有价值，但以受约束的任务／store 模型为前提，不是“所有执行都已有共同 Core”的证据。

对本项目的竞争性解释是：若摩擦主要是“哪些输入变了、哪些产物要重算”，应先比较现成构建机制，而不是给每个函数增加运行目录和 trace。但若任务是重启服务、发出账单或修改独立数据库，跳过／重启这些函数的合法性必须另行定义。

### 2.2 Nix 的关键不是语法，而是输入、不可变路径和闭包纪律

Dolstra 的《[The Purely Functional Software Deployment Model，2006][nix-thesis]》从“把程序移到另一台机器仍能工作”出发。第3.3–3.4节将部署类比为内存管理：文件路径像引用，完整部署需要携带依赖闭包；任意拼接全局路径则类似不受约束的指针运算。

第5.2.3节给出具体不变量，而不只是“声明依赖”：

1. 被登记为 valid 的 store path 应存在；未完成构建不冒充有效对象。
2. valid 对象的字节应与记录的内容哈希一致。
3. valid 路径集合对已记录的 references 关系闭合，即被引用对象也有效。

这依赖 store 管理、引用识别、锁和事务。原论文中的 Berkeley DB 是当时实现细节，不是本文对现版 Nix 数据库后端的陈述。其 closure 也不是互联网中“一切运行时依赖”的全知图；论文专门讨论了路径扫描和指针纪律的假设。

必须保留一个容易被“内容寻址”口号掩盖的区别：[现版手册的 input addressing 定义][nix-input]是**按产生方式而非产物内容**决定输出路径。不能看到 `/nix/store/<hash>-…` 就断言 `<hash>` 是该产物字节的直接摘要。[输出类型文档][nix-output]另外区分 input-addressed、content-addressed、fixed／floating 及纯／非纯派生。

原论文第5.7节已经主动承认反例：构建可能嵌入时间戳，模型把某些不同字节视为可互换；这是对 builder 的假设，不是哈希自动消除了非确定性。[NixOS Reproducible Builds 项目][nix-repro]今天仍明确说 sandbox 和确定的依赖引用不足以保证 bit-for-bit 重现；构建两次相同也不是普遍证明。

**获得的性质**是版本并存、可定位的构建输入与依赖闭包、受条件约束的复用；**放弃的自由**是任意读取未建模环境、原地改写共享产物、把宿主环境当隐式输入。第9章确实把此模型用于服务软件和配置部署，所以“Nix 只能构建，不能部署”也是错误概括；但静态软件／配置的代际切换不等于撤销已发送请求、恢复数据库内容或证明新配置已被运行进程采用。后者正是[历史实验的文件／进程差异](conclusions/6-operations-truth-loop.md)。

**成熟度与限制**：Nix 不是新原型；但本次采用的 2.28 手册仍把 `nix build`／flake 相关新 CLI 标为 experimental。应分别评价 store 模型、某个 CLI 和具体 builder，不把“项目成熟”当成所有行为无条件成立。

### 2.3 Pulumi：同一门语言没有消灭描述／执行边界

[Pulumi 架构文档][pulumi-how]解释了一个关键过程：Node language host 运行 TypeScript；构造资源对象时向 engine 注册期望资源；engine 调用 provider；provider 操作完成后写入 state。`new aws.s3.Bucket(...)` 返回，**不表示 AWS bucket 已经创建**。这不是普通对象构造的外部语义。

`Output<T>` 是另一个有意暴露的边界：[apply 文档][pulumi-apply]说明资源输出可能还未知，不能随意当成普通字符串；若在未知输出的 `apply` 内创建资源，preview 甚至可能看不到这些资源。描述与执行使用 TypeScript，仍需要特殊数据依赖、未知值和受管副作用语义。

两个反例进一步限制“声明即事实”：

- [`pulumi refresh`][pulumi-refresh]把 provider 观察到的当前状态采纳到 stack state；不等于同步改写程序。程序不相应改变，后续更新仍可能与现场冲突。`pulumi up` 本身会结束，也不能不加说明就把它当作常驻协调循环。
- [update plan 文档][pulumi-plan]明确：计划不是在所有修改前做一次 all-or-nothing 检查；操作随求值／依赖解析分批推进，发现偏离时失败。之前已经发生的计划内修改不因此自动撤销。preview 的 unknown 也会限制可审阅的精度。

因此，Pulumi 是“语言作为资源描述前端、复杂引擎承担状态比较”的真实竞争者，不是原生 JS 的语法糖。它把部分跨资源复杂性集中给 engine／provider，却增加 state backend、资源身份、provider 差异与漂移处理责任。本文没有运行云账户、比较维护总成本或验证任意 provider 的恢复语义。

## 3. 持久工作流：把恢复变成运行时责任，但不能把外部世界变成历史

### 3.1 历史来源：队列不足以提供长期程序的连续性

共同创始人 Samar Abbas 的[2020年一手回顾][temporal-history]描述了具体背景：在 AWS SWF、Azure Durable Task Framework 和 Uber Cadence 的工作中，开发者反复用队列、数据库、重试、持久 timer 手工实现恢复。C# 的 async/await 帮助形成 workflow-as-code，后来在 Uber 与 Maxim Fateev 创建 Cadence，再成立 Temporal。此叙述是作者参与经历与产品动机，不是独立测量的生产力百分比；本文不复述其中营销性的工时比例。

这是人员与思想的演化链，不表示 SWF、DTFx、Cadence、Temporal 共享同一份代码或保证。更早的《[Sagas，1987][sagas]》处理另一种原始问题：长事务长期占用资源，因而允许子事务与其他事务交错，失败时执行补偿事务。它是理解长期工作取舍的重要先例，**不是本文已证实的 Temporal 直接代码祖先**。此次原始 PDF 抽取不完整，关于 Sagas 仅据 Princeton 保存的作者摘要，不冒称读完实现证明。

Sagas 放弃了整个长期过程像一个隔离短事务那样运行的性质。将这一思想迁移到外部服务时，“退款／补偿”也不能抹去对方曾见到收费的事实；这是机制推论，不是某个引擎自动具备或自动完成补偿的承诺。

### 3.2 Temporal 的持久对象是事件历史，不是整个 JS heap

[TypeScript Event History walkthrough][temporal-replay]逐步展示：调度 Activity、启动 timer、完成 Workflow 会发出 Command；服务将相关事件写入历史。普通变量赋值、累加、分支求值等在 Worker 内执行，**不是每一行都作为事件持久化**。

已读的 [SDK `workflow.ts` 源码][temporal-source]进一步揭示调用边界：

- `proxyActivities` 返回 Proxy；访问活动名时构造函数，调用后进入 `scheduleActivity`，而不是调用同进程中的活动实现。
- `scheduleActivity` 要求 Workflow context，分配序号并经过 outbound interceptors。
- `scheduleActivityNextHandler` 序列化参数，将含 activity type、task queue、timeout、retry policy 等内容的 command 放进 activator，并登记 Promise 的完成处理。

这个实现说明**相似函数签名不能证明相同调用语义**。类型参数帮助检查消费代码，但活动名、序列化、队列、Worker 注册与超时仍是跨边界契约；不存在任意闭包被透明搬到持久执行环境的保证。

故障后 replay 使用已记录历史重建控制状态，已经记载完成的 Activity 结果用于继续计算，而非为了“更新事实”重新调用 Activity。[版本文档][temporal-version]要求代码与历史产生兼容的 Command 序列；添加／移除／重排产生 Command 的调用可能要求 patch 或 Worker Versioning。局部不改变命令序列的重构与改变活动次序不能混为一谈。

**获得的性质**是受该模型约束的持续控制流、持久 timer、活动结果复用与跨 Worker 恢复；**放弃的自由**是直接把任意网络／文件／模型调用放在可重放控制流里、随意改变仍在运行的历史所需代码。恢复能力恰来自这些限制，不来自 `async` 语法本身。

### 3.3 最危险的错误等式：replay 一次 ≠ 外部效果一次

[活动执行文档][temporal-activity]与[重试策略文档][temporal-retry]明确要求考虑 Activity 幂等；默认会重试活动，Workflow Execution 本身则不默认采用相同重试策略。不能用“Temporal 会重试”笼统描述三种不同对象：Workflow Execution、Workflow Task、Activity Task。

考虑这个**机制推论，未在本机注入故障**：Activity 已在外部扣款，完成回报在写入服务前丢失；其后重试可能再次扣款。调度／历史恢复本身不能在独立支付系统里原子确认第一次效果。关闭重试可改变重复风险，却可能留下“已经执行还是没执行”的未知，不能凭此得到 exactly-once。

相同地，若 Activity 返回了“知识门通过”，replay 会保留这个过去的决定，而不是自动查询后来的反证。这是恢复契约的正确行为，不是 replay 缓存出错。要感知新信息，需要明确的新 Activity／消息输入；即使重新检查，检查与独立 actuator 动作之间仍可能变化。

外部系统支持的稳定 operation ID／幂等提交、版本前提或 fencing 可以分别解决某些重复／过期问题，但它们不等价：**幂等不证明请求仍获授权；版本检查不证明知识真实；fence 的权威也必须与 actuator 接受规则相连。** 本文不把其中任何一个名字当作万能补丁。

持久历史也不是无限知识库：[执行限制][temporal-limits]给出历史规模限制，[Continue-As-New][temporal-continue]通过结束当前执行并以新历史继续来控制增长。它维护逻辑连续性，不意味着所有历史证据永不被清理；归档、保留和外部证据链接仍是运营责任。

**成熟度与限制**：创始人2020年文章已经报告 v1.0 生产版本，现有 SDK／版本化文档也覆盖真实部署问题；这足以把它作为成熟机制候选，不能因此声称本项目已验证其运维、灾备或跨版本迁移成本。没有真实引擎运行时，用手写日志替代然后宣称证明 Temporal 收益，会失去等价比较。

## 4. 能力与协议：能找到、能调用、被允许，是三件事

### 4.1 对象能力早就挑战了“说明就是权限”

Miller 的《[Robust Composition，2006][cap-thesis]》第8–11章区分 permission 与 authority：能向一个对象发消息是直接权限；能让持有写权限的代理替自己写文件，是间接权力。只列直接权限会漏掉代理行为产生的能力。

第9章把 reference graph 同时作为 access graph。引用不可伪造，交互只能经过持有的引用；新的连接来自创建、endowment 或有权者的 introduction。**安全性既取决于能做什么，也取决于运行时禁止什么。** 普通 Node 模块即使只暴露一个函数，仍可能有文件、网络和进程环境权力；给函数加 `permissions: []` 不会把它变成对象能力隔离环境。

第9.3–9.4节的 caretaker 不是全局授权注册表：授予一个转发引用，另保留可关闭它的 gate，通过代理行为实现可撤销的访问。反例同样具体：若目标把自己的直接引用泄露给调用者，单层 caretaker 不再控制那条旁路；膜必须约束穿越边界的引用。即使撤销了未来调用，也不能据此倒退已经发生的外部效果。

这一体系与“统一能力描述”真正竞争：它把权力放在**被授予的连接和执行限制**中，而不是把一份完整能力清单交给所有消费者再按字符串授权。它也主动放弃无约束的全局发现与 ambient authority。描述仍可附加，但不是 enforcement 的来源。

### 4.2 Unix／HTTP 的流畅来自窄共同契约，而不是共同领域对象

Ritchie／Thompson 的《[The UNIX Time-Sharing System][unix-paper]》所读版本是1978修订重印，尽管镜像文件名含 `ritchie74`。第3.1、3.6、5.2及6节说明：普通文件不由内核强制内部结构；文件、设备和 pipe 复用 I/O；shell 接线，程序保有数据格式责任。统一 byte stream 获得广泛组合，但没有自动获得领域 schema、永久历史或事务补偿。**简单共同面不等于语义成本消失，只是将其留给端点。**

HTTP 又选择了不同共同面。[RFC 9110 §9.2.1–9.2.2][http-semantics]把 safe／idempotent 放进方法语义：幂等限定的是多次相同请求的预期效果，不保证每次响应相同，也不禁止每次记录日志等额外效果。对于非幂等请求，客户端不应在不知道请求实际幂等或从未应用时自动重试。

URI 是定位／命名机制，不天然是不可伪造授权；某些 secret URL 可以被具体系统用作 bearer capability，但不能把一切 URL 与 object capability 画等号。接口规范同样不能强迫一个失信 HTTP 端点遵守声明。

### 4.3 MCP 改善 Agent 互操作，但没有消灭权限、长任务和效果的差异

固定版 [MCP Tools][mcp-tools]定义发现、输入／可选输出 schema、调用及错误结果；[Lifecycle][mcp-lifecycle]要求先协商版本和 capabilities，再进入操作。工具列表变化有通知，列表有分页。这些已有机制能够直接竞争 Locus 自己的全局注册表：Agent 可联邦消费现有服务器，不必先把所有领域对象转换成同一 Core 类型。

但下列限定不能省略：

- Tools 规范明确：除非来自可信服务器，客户端必须把 tool annotations 视为不可信。`readOnlyHint`／幂等提示不是安全沙箱和实际效果证明。
- [Authorization][mcp-auth]主要给出 HTTP transport 的 OAuth 授权；授权在规范中是可选能力，stdio 另从环境取得凭据。协议支持授权不等于每个服务器都提供逐工具最小权力，更不等于模型懂得正确使用权限。
- 不能把 MCP 误写成“只有无状态 `tools/call`”。[2025-11-25 Tasks][mcp-tasks]已引入 **experimental** 的 durable task state machine、receiver 生成的 task ID、轮询、延迟取结果、TTL 与取消。服务器及工具级 task support 都须协商；默认不能随意给所有工具套 task。
- **最强反例来自 Tasks 的 Task Cancellation 条款**：接收方仅 **SHOULD** 尝试停止执行，却 **MUST** 在回复前把 task 设为 `cancelled`，且即使底层继续执行到完成／失败也必须维持该状态。故 `cancelled` 不能证明“没有副作用”。TTL 到期还可以删除 task 及结果，不能把未知 task 当成从未执行。

Tasks 已明确承担一部分持久状态责任，不能一边要求它与纯 RPC 比较，一边忽略这些新增责任；但规范没有因此提供 Temporal 式确定性 replay、业务补偿或任意外部效果的恰好一次提交。具体存储与恢复实现仍应在真实服务器上检验。

### 4.4 OTel：可关联的观察，不是可恢复的执行账本

[OpenTelemetry Tracing SDK 规范][otel-sdk]的 sampler 可返回 `DROP`；BatchSpanProcessor 队列满会丢 span。规范还明确指出应用与 instrumentation 不应把 span 中存的数据当应用逻辑依赖。由此可作的机制推论是：缺 span 不证明未执行，成功 span 不证明效果仍有效；关联 ID 有用，却不替代幂等键、授权凭据或 Workflow Event History。

可以把 Temporal／MCP／原生调用与 OTel trace 关联，但不能因为它们都有 event、status、ID，就把它们投影成一种可互换的历史。

## 5. 失败与反方：透明对象的教训不是“分布式对象不可能”

### 5.1 被反驳的是无代价透明性

Waldo 等人的《[A Note on Distributed Computing，1994][waldo]》第4–5节区分 latency、memory access、partial failure 和 concurrency。其队列反例至今仍具体：超时后重试 enqueue，原调用可能已经成功；若接口没有请求身份或其他去重语义，换一个“更可靠实现”也无法修复消费者的重复效果。

因此失败点不是“RPC 语法丑”，而是把这些差异留到实现阶段才处理。局部函数／远程调用都写成 `await f(x)`，不能推出它们具有相同失败含义。该论文是设计论证，不是对所有后来分布式对象系统的不可能性证明；其对本地故障的简化也不覆盖现代同进程代码的一切副作用与异常情形。

历史上确有撤回路线：[JEP 320][jdk-corba]在 JDK 11 移除内置 CORBA／相关工具，给出的理由包括外部标准与 JDK／应用服务器 ORB 难以同步、现代 Java 应用兴趣不足以及维护成本大于收益。这是**平台内置路线被替代的具体证据**，不是“CORBA 全球已死亡”或“全部因为透明性而失败”的证据。[OMG CORBA 3.4][corba-spec]在2021年仍为正式规范，旧 Java 绑定还显式暴露了 [`COMPLETED_MAYBE`][corba-completion]。CORBA 自身并非完全没有承认远程不确定性。

对本项目可成立的反驳范围是：普通对象／Proxy／统一 API 不能免除远程失败契约；“先把所有东西变成同一种对象，失败以后再补”有已知结构性风险。不能据此禁止受约束的分布式对象设计。

### 5.2 最强反方：Spritely 把约束放入运行时，而不是全部外置

《[The Heart of Spritely][spritely-paper]》并非继续假装远端是普通同步调用。已读第3.4–3.6、4节：

- 对象处于 vat／actormap 中；near 对象可同步 `$` 调用，跨 vat 的 far 对象用异步 `<-` 与 promise。
- 每个 vat 一次处理一个 turn。受管 heap 中的修改在 turn 成功后提交；向外发送的异步消息也只在 turn 成功后发送，未处理异常不提交该 turn。
- 引用同时承载能力，OCapN／CapTP 负责网络引用、异步消息与 promise pipelining，而不要求每个应用重新发明这些机制。

这直接挑战“复杂性只能留在边界、没有独立运行时才轻量”的推论：**若事务 heap、引用权力与异步调度是目标问题的主要负担，一个更强的共同运行时可能减少总体责任。** 它也保留原生语言组合的熟悉感，但以 near／far、受管状态及能力纪律为条件，而非给任意 JS 对象加标签。

边界必须同样清楚：论文开头标为 early draft、仍在技术审查；本次读的 [Goblins 0.18.0 OCapN 手册][goblins-ocapn]明确警告 CapTP 不稳定，[OCapN 项目 README][ocapn-repo]仍说明 pre-specification。论文的受管 turn 事务不能被本文扩张为对任意宿主文件、支付或跨 vat 全局动作的原子回滚。本轮未安装运行，未验证与当前 JS 客户端互操作、灾难恢复、协议稳定性或总体成本；不能把某些论文中仍属 planned 的调试／CRDT 功能当已交付保证。

因此“多种历史联邦”与“受约束的共同对象运行时”都应保留为实质竞争者。前者减少迁移，后者可能减少同类语义责任的重复实现；历史证据不足以宣布唯一赢家。

## 6. 真实消费形状：全部为来源示例，未本机运行

以下不是本工作区实验命令；命令所在目录、软件安装、认证及依赖必须按各官方项目准备。示例返回值若有说明，均是来源预期，不是运行日志。本文不把只读文献研究计为断电恢复、云部署或协议互操作测试。

### 6.1 Nix：请求产物，允许缓存命中而不执行 builder

前提：支持的 Nix 环境，已启用 `nix-command`／`flakes`，能够读取配置的 registry／substituter。[Nix 2.28 `nix build` 手册][nix-build]与[官方重现检查说明][nix-repro]给出：

```sh
nix build nixpkgs#hello
./result/bin/hello
nix build nixpkgs#hello --rebuild --keep-failed
```

消费语义：第一步可以构建，也可以取得已有产物；`result` 链接到 store output。第二步真正消费该程序；第三步请求重建并比较。官方 Hello 示例预期打印 `Hello, world!`，不是本文本机输出。

反例边界：`nixpkgs` 是 registry 引用，不是本文锁定的历史输入。重复运行时解析版本可能变化；严肃比较应保存项目的 `flake.lock`／解析到的 revision 并核对同一派生。[flake 手册][nix-flake]解释了这些不同引用。即使同一派生两次相同，也只增加局部重现证据，不证明未来所有构建相同。**把“重启服务”隐藏在 builder 里会与“合法地跳过 builder”冲突。**

### 6.2 Pulumi：普通 TypeScript 消费 provider，执行责任不在对象构造器

以下资源声明来自[官方架构示例][pulumi-how]，不是自制 provider：

```ts
import * as aws from '@pulumi/aws';

const mediaBucket = new aws.s3.Bucket('media-bucket');
const contentBucket = new aws.s3.Bucket('content-bucket');
```

在按官方模板初始化的 TypeScript／AWS stack、有效凭据及 provider 环境内，真实操作流程可以是：

```sh
pulumi preview --save-plan=plan.json
pulumi up --plan=plan.json
pulumi refresh --preview-only
```

前两步来源于[update plan 文档][pulumi-plan]，最后一步使用[refresh CLI][pulumi-refresh]的只预览选项；`up` 可能产生真实云资源及费用，本文没有执行。这里的消费者不继承 Locus 基类，也不先建立统一 Entity 图；但资源、依赖、state 与 provider 都是 Pulumi 的受管契约。保存 plan 不是把两步提升成原子事务，preview 也不是云现场快照的永久认证。

### 6.3 Temporal：函数调用形状，实际经过服务／队列／Worker

[官方 hello-world 样例][temporal-sample]的两个真实文件如下，省略了无关的注释，没有替换 SDK：

```ts
// src/activities.ts
export async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
```

```ts
// src/workflows.ts
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function example(name: string): Promise<string> {
  return await greet(name);
}
```

必须同时使用该样例的[Worker](https://github.com/temporalio/samples-typescript/blob/main/hello-world/src/worker.ts)和[Client](https://github.com/temporalio/samples-typescript/blob/main/hello-world/src/client.ts)：Worker 用 `NativeConnection`、`Worker.create` 注册 workflows／activities 并监听 `hello-world` 队列；Client 用 `Connection`、`Client.workflow.start` 启动，再取 `handle.result()`。只有上面两个文件而没有服务／Worker，不是完整执行系统。

在已准备好官方样例依赖及 Temporal CLI 的目录，按原样例流程、仅将包脚本调用换为 pnpm：

```sh
# 终端一
temporal server start-dev
# 终端二：hello-world 样例目录
pnpm run start.watch
# 终端三：同一样例目录
pnpm run workflow
```

官方预期客户端返回 `Hello, Temporal!`；本文未运行，也未通过此 Hello 函数声称验证支付副作用／崩溃恢复。该案例重要之处是：真实消费 API 已足够直接，无需再把它包装成 Locus task；但活动注册、队列与持久服务不可从责任比较里删除。

### 6.4 MCP：不构造共同对象世界也可发现并消费

下面是从 [Lifecycle][mcp-lifecycle]／[Tools][mcp-tools]缩减的合法客户端消息序列；不是一批 JSON-RPC 数组，也不是实际服务器回包。前提是已经建立该服务器支持的 transport，必要认证已完成。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"study-client","version":"1.0.0"}}}
```

等服务器接受可支持的版本并声明 `tools` 后，发送：

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

消费者要跟随返回的 `nextCursor` 读取后续页，检查 schema，而不是假定第一屏就是全局目录。若服务器确实按规范示例暴露 `get_weather` 且输入字段为 `location`，可调用：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_weather","arguments":{"location":"New York"}}}
```

这是规范的天气工具消费，不是本项目已有天气服务器。HTTP 后续请求还须携带协商后的 `MCP-Protocol-Version` 等 transport 所需信息。解析 JSON-RPC 成功不等于 `isError` 为 false；工具执行成功又不等于业务结论正确。长任务只有在 server／tool 宣告支持后才按 Tasks 协议创建并轮询，`taskId` 用服务器实际返回值，不能自行用 JSON-RPC request ID 替代。

这些流程让 Agent 通过公开协议组合已有能力，减少自建发现面的必要性；却没有提供替调用者检查目标身份、坐标系、期望版本或知识适用性的领域语义。

## 7. 跨体系组合：保证不能简单相加

### 7.1 本轮实测与历史机制相撞的位置

主线程报告的[实验16](paradigm-study.md)观察是：第二 SQLite 连接提交反证后，直接查询不再返回 eligible；仅包成 `computed(SQL查询)` 的结果仍缓存旧值，显式 `revision` 摄取桥更新后才失效。`BEGIN IMMEDIATE` 可以阻止另一 writer 并串行化本地“判断＋intent 插入”；但 intent 提交后再进入的反证，只阻止新 intent，旧 intent 仍实际 `writeFile`。源码刻意保留此失败方案，没有加重查把边界遮住。

这一证据**并未运行 Temporal 或 Nix**。可以成立的机制对照是：

| 组合 | 不能简单相加的语义 | 需要保留的责任／反证边界 |
| --- | --- | --- |
| SQL 查询＋reactivity | 数据库提交不自动成为 Vue 图内变更 | 摄取、失效信号及其完整性；不能由包一层 computed 推导 |
| SQL intent＋Temporal Activity | 数据库中的过去接纳与未来外部执行不是一个事务；replay 还会忠实复用过去结果 | 是否要求当前权威重批、actuator 是否接受版本前提；本轮只有 SQL／文件侧实测 |
| Nix＋修复操作 | 构建可由缓存满足；修复必须考虑现场状态和副作用 | 把 immutable artifact 与执行命令分开；store 成功不等于现场采用 |
| Pulumi＋独立修复 Agent | 两者可能同时写同一资源，期望状态协调可覆盖临时修复 | 谁拥有该字段／资源、何时吸收漂移；“两个自动化都成功”不是组合收敛证明 |
| CRDT 知识＋Workflow 历史 | 并发修订应可合并争议；已完成步骤不可因合并后 winner 改写过去 | 传递明确 revision／scope 或新消息，区分历史事实与当前政策；不从 merge 推导重试安全 |
| MCP Tasks＋actuator | `cancelled` 是协议终态，却允许底层继续完成 | 效果需独立观察／回执；不可把取消状态当“零副作用” |
| 对象能力＋发现清单 | 可枚举名字／schema 不是已授予 reference；泄露宽代理会放大权力 | 授予、attenuation、撤销及代理可信边界；不是加一个 permissions 字段 |
| OTel＋任意执行 | trace 可采样、丢弃和延迟输出 | 故障诊断可关联；恢复、审计完整性和当前授权不能只读 trace |

表中除第一行和实验16的 SQL／文件窗口外，均为依据规范的**组合推论，未端到端运行**。它们不证明这些体系不能组合，而是确定比较时必须同时承担的职责。

### 7.2 必须主动保留的反方：不是所有许可都需要全球协调

“本地没有反证，不足证明世界上没有反证”是正确的认识边界，但不能偷换为“一切动作都必须等全世界同意”。Miller 第9.3节直接指出：给出原始能力引用，本来就是授予持续访问；要撤销才额外引入 caretaker。这提供了不同政策的具体例子：

- **有界、预授予权利**：只对固定目标／限额／有效期授予操作权；约定授予后某些事实不追溯撤销。这时行动依赖持有的权利，而非持续证明全球不存在反证。是否适合本领域仍是设计假设。
- **可撤销的当前许可**：约定任何新反证必须阻止尚未发生的动作。这才要求定义反证的权威、可见范围、撤销生效点及 actuator 如何执行；仅合并记录／提交 intent 不够。

前者不是解决了后者的更强不变量，而是**选择了不同承诺**。比较时必须把它公开，不能让某方案接受预授予许可、另一方案却承担全球最新许可，再以协调成本判胜负。即使使用不可撤销权利，权限限额、目标认证、重复消费和权利失窃仍然是实际责任。

## 8. 对根本假设的本轮挑战

| 假设 | 足以成立的反方 | 本轮仍不能宣布的结论 |
| --- | --- | --- |
| 描述与执行应统一 | Nix 将求值／builder 分开；Pulumi 构造器不等于 provision；Temporal 控制流与 Activity 分开，限制反而生成恢复保证 | 不能据此说描述代码与执行代码绝不可同语言；共同语言不等于同语义 |
| 简单核心、复杂边界必然整体更省 | Temporal／数据库把恢复和并发集中；Goblins 将受管 turn／权力放入运行时，可避免边界反复造轮子 | 未测总体成本，既不能排除复杂 Core，也不能因成熟引擎大就证明 Locus 需要自己的 Core |
| 独立 Locus 运行时／API 必要 | 第6节均可直接消费已有系统；ESM／协议前端可让语言只做胶水 | 本机长任务恢复确可能需要持久运行时，但可复用 Temporal 等，不等于必需新 Locus 运行时 |
| 统一 event／ID／success 能连接历史 | build key、Workflow ID／Run、task ID、capability、trace ID 对应不同不变量 | 可追溯交叉引用有价值，但投影为共同字段会丢含义，不能靠字段相似证明统一模型 |
| Agent 改变了封装，故稳定契约不再重要 | Agent 可读源码／协议临时生成窄适配，某些薄包装可能不值得稳定 | 模型不能凭推理制造幂等、认证、replay 兼容；生成适配改变调用顺序也可能破坏长期历史 |
| 原生对象不适合跨机器，必须完全外置协议 | Spritely／OCapN 有意保留异步引用编程，能力与受管事务可带来组合收益 | “不透明失败”不等于“不能抽象”；本轮没有证明该运行时适合现有 JS 工作区 |

Agent 的 nondeterministic 规划／LLM 调用若进入 Temporal，按其文档应放入 Activity 一类有明确结果记录的边界；重放过去结果可避免重放时重新问模型，却不证明那个答案真实或仍适用。反方向也成立：短生命的只读任务可能完全不值得付出长历史／版本化成本，普通函数＋现有客户端是强基线，而不是故意降配的对照组。

## 9. 等价责任：比较一个任务，不比较入口行数

以“发现一个设施、根据知识决定动作、承受变化／故障、保留部分失败”为共同责任，竞争边界如下。空缺意味着须由消费者或外部系统补足，不代表候选方案无价值。

| 候选 | 它集中承担的责任 | 做等价任务仍需补足 | 何时可能实质胜出 |
| --- | --- | --- | --- |
| 原生 JS／ESM＋领域客户端 | 直接调用、闭包封装、语言调试；每次重算可避开缓存失效债务 | 持久化、变化摄取、跨调用恢复、效果身份与权限 | 短期、可重算、依赖已知且外部工具已有保证；无需第二套世界模型 |
| 关系查询／本地事务 | 从事实推导关系、限定事务内一致性与接纳顺序 | 摄取完整性、DB外动作、作者／证据语义、分布式复制 | 多消费者不断重组事实，手工维护派生边容易漂移 |
| CRDT／因果历史 | 离线修订、并发合并及相关历史，具体以[因果专题](causal-history-study.md)和真实库实验为准 | 领域冲突、授权生效、外部效果和历史保留 | 作者持续离线共在、争议不应被快照覆盖，而非每项工作都由中心串行决定 |
| Nix／Pulumi | 产物依赖闭包与构建复用；或资源期望／状态／provider 操作 | 当前现场观测、可变数据恢复、跨管理器所有权、知识许可 | 构建／资源状态管理本身就是主要痛点，已有包／provider 覆盖真实对象 |
| Temporal | 受约束的长期控制流恢复、持久 timer、调度与活动结果历史 | 活动幂等／外部提交、知识更新输入、代码版本、服务运维 | 故障恢复和长期等待已超出临时脚本，而不是只有几十毫秒只读组合 |
| 能力运行时／MCP 联邦 | 前者把可用权力与引用连接；后者统一消息／发现协商，二者不是同一种保证 | 领域效果、端点信任、权限衰减／撤销；运行时与协议版本责任 | 多主体／不可信扩展需要真正限权，或异构 Agent 已可直接使用协议，无需总注册表 |

实施成本、消费成本、长期迁移成本和运维成本要同时计入。不能把 Nix 的 store／Temporal 的服务从成本账上删掉；也不能把原生方案所调用数据库和领域包的保证都当成免费语言能力。当前没有等价负载、同样故障注入和维护周期的数据，因此不作总成本排名。

## 10. 已成立的研究收获与尚未封闭的证据

**本轮可据来源成立的结论**：

1. 至少存在三种不同的执行／组合承诺，且每种都已形成具体机制，不能用“统一 call 图”无损替代。它们足以使复用外部系统成为真实竞争路线，而非给原生设计补几个说明字段。
2. 跨体系不变量最容易断在**状态责任交接**：可见事实→过去决定→intent→调度→实际效果→回报。实验16观察了其中一处真实断裂；Temporal 的 Activity／历史边界、MCP 的取消条款和 Nix 的缓存语义提供了独立的一手机制对应。
3. 统一不是天然错误；无条件透明与遗漏责任才是。Spritely 是不能被 CORBA 故事抹去的反方；原生／查询同样不能被复杂引擎的成熟度排除。
4. 最值得主线程保留的矛盾是：**可更新知识要求重新判断，持久执行要求忠实延续过去；两者不能只靠共享一个 success 或 revision 字段协调。** 另一项同样重要的反方是：预授予且有界的权利可以不依赖全球“无反证”，不能把某项非单调门禁的限制泛化成全部执行必须全球协调。

**仍待实验证伪的命题，而非已完成保证**：

| 命题 | 能裁决它的观察 | 当前缺口 |
| --- | --- | --- |
| Temporal 可显著减少本案例的恢复接洽 | 使用真实服务／Worker，在活动外部效果已发生但完成回报前中断；对照普通客户端承担同等恢复责任 | 本轮未运行引擎、未注入这个窗口；Hello 来源示例不构成证据 |
| 版本前提能把知识许可延伸到 actuator | 反证分别在接纳前、提交后、效果前到达；执行器实际拒绝过期请求，且能解释已经发生的效果 | 实验16只有本地 intent＋真实文件，不具备该 actuator 契约；单纯重查不能证明窗口消失 |
| 联邦协议比新统一目录更流畅 | 独立 Agent 通过分页、schema、权限及长任务协商完成同等任务，保留实际错误与接洽成本 | 历史实验14只有一次源码／原生协议发现；本轮无新增 MCP Agent 成功率数据 |
| 更强对象运行时能减少总状态责任 | 受管 turn／能力限制真实承接现有任务，包含失败恢复与宿主 I/O 边界，而非只比较消息语法 | Goblins／OCapN 未运行，协议稳定／JS互操作与迁移成本未测 |
| Nix／Pulumi 更适合这类设施演化 | 真实产物／provider、现场采用验证、漂移和非预期修改都纳入同一任务边界 | 本轮仅读机制；不能用本地替身 provider 或自制 DAG 宣称已比较真实引擎 |

这些缺口不要求本轮临时搭建大型平台，也不以“以后再看”替代已可完成的研究。本文已经明确了来源、消费入口、反例、让步与可竞争职责；缺少的是外部引擎及执行器窗口的真实运行证据，不是再添加一层公共 API。

## 一手来源索引

以下链接同时用于正文引用；论文按章节、规范按版本／章节追溯，不把搜索摘要当已读全文。

- [Build Systems à la Carte，Mokhov／Mitchell／Peyton Jones，2018][build-paper]：第2–5节的任务模型、调度／重建正交分解和反例；其中产品能力比较有2018年的时间边界。
- [The Purely Functional Software Deployment Model，Dolstra，2006][nix-thesis]：第3.3–3.4、5.2.3、5.7、9章；并用现版手册限定历史实现与当前性质。
- Nix 2.28 手册：[输入寻址][nix-input]、[输出类型][nix-output]、[`nix build`][nix-build]、[flake 引用与锁][nix-flake]；[NixOS Reproducible Builds][nix-repro]提供未重现反例及检查边界。
- Pulumi：[language host／engine／provider][pulumi-how]、[Output／apply][pulumi-apply]、[refresh][pulumi-refresh]、[update plan][pulumi-plan]；属于实现方机制说明，不是本文的独立效益测量。
- Temporal：[创始人历史回顾，2020][temporal-history]、[事件历史 walkthrough][temporal-replay]、[TypeScript SDK 调度源码][temporal-source]、[活动执行][temporal-activity]、[重试][temporal-retry]、[版本化][temporal-version]、[历史限制][temporal-limits]、[Continue-As-New][temporal-continue]、[官方消费样例][temporal-sample]。
- [Sagas，Garcia-Molina／Salem，Princeton TR-070-87，1987][sagas]：此次仅采用学校存档的作者摘要，PDF 抽取不完整。
- [Robust Composition，Miller，2006][cap-thesis]：第8–11章，重点为 permission／authority、引用获得、caretaker 及其旁路反例；学校镜像403后使用作者站点 PDF。
- [The UNIX Time-Sharing System，Ritchie／Thompson，1978修订重印][unix-paper]：第3.1、3.6、5.2、6节；[RFC 9110，2022][http-semantics]：§9.2.1–9.2.2。
- MCP `2025-11-25`：[Tools][mcp-tools]、[Lifecycle][mcp-lifecycle]、[Authorization][mcp-auth]、[Tasks][mcp-tasks]，特别是 Tasks 的 Task Cancellation、TTL 和 capability negotiation。
- [OpenTelemetry Tracing SDK][otel-sdk]：Sampling／Batching processor 与应用逻辑边界，滚动规范中部分内容另标 Development。
- [A Note on Distributed Computing，Waldo 等，1994][waldo]、[JEP 320，JDK 11][jdk-corba]、[CORBA 3.4正式规范，2021][corba-spec]及[旧 Java CompletionStatus 契约][corba-completion]，分别支撑机制批判、具体撤回与反对过度泛化。
- [The Heart of Spritely][spritely-paper]：第3.4–3.6、4节，文首自标 early draft；[Goblins 0.18.0 OCapN 手册][goblins-ocapn]及[OCapN README][ocapn-repo]提供版本／成熟度边界。

[build-paper]: https://www.microsoft.com/en-us/research/wp-content/uploads/2018/03/build-systems-a-la-carte.pdf
[nix-thesis]: https://edolstra.github.io/pubs/phd-thesis.pdf
[nix-input]: https://nix.dev/manual/nix/2.28/store/derivation/outputs/input-address
[nix-output]: https://nix.dev/manual/nix/2.28/store/derivation/outputs
[nix-repro]: https://reproducible.nixos.org/
[nix-build]: https://nix.dev/manual/nix/2.28/command-ref/new-cli/nix3-build
[nix-flake]: https://nix.dev/manual/nix/2.28/command-ref/new-cli/nix3-flake
[pulumi-how]: https://www.pulumi.com/docs/iac/guides/basics/how-pulumi-works/
[pulumi-apply]: https://www.pulumi.com/docs/iac/concepts/inputs-outputs/apply/
[pulumi-refresh]: https://www.pulumi.com/docs/iac/cli/commands/pulumi_refresh/
[pulumi-plan]: https://www.pulumi.com/docs/iac/operations/stack-management/update-plans/
[temporal-history]: https://temporal.io/blog/samars-journey
[temporal-replay]: https://docs.temporal.io/encyclopedia/event-history/event-history-typescript
[temporal-source]: https://github.com/temporalio/sdk-typescript/blob/main/packages/workflow/src/workflow.ts
[temporal-activity]: https://docs.temporal.io/develop/typescript/activities/execution.md
[temporal-retry]: https://docs.temporal.io/encyclopedia/retry-policies.md
[temporal-version]: https://docs.temporal.io/develop/typescript/workflows/versioning.md
[temporal-limits]: https://docs.temporal.io/workflow-execution/limits.md
[temporal-continue]: https://docs.temporal.io/design-patterns/continue-as-new.md
[temporal-sample]: https://github.com/temporalio/samples-typescript/tree/main/hello-world
[sagas]: https://www.cs.princeton.edu/research/techreps/598
[cap-thesis]: http://www.erights.org/talks/thesis/markm-thesis.pdf
[unix-paper]: https://pdos.csail.mit.edu/archive/6.824-2006/papers/ritchie74unix.pdf
[http-semantics]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2
[mcp-tools]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
[mcp-lifecycle]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
[mcp-auth]: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
[mcp-tasks]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
[otel-sdk]: https://opentelemetry.io/docs/specs/otel/trace/sdk/
[waldo]: https://web.cs.wpi.edu/~cs4513/d10/Papers/Waldo%2C%20A%20Note%20on%20Distributed%20Computing.pdf
[jdk-corba]: https://openjdk.org/jeps/320
[corba-spec]: https://www.omg.org/spec/CORBA/3.4
[corba-completion]: https://docs.oracle.com/javase/8/docs/api/org/omg/CORBA/CompletionStatus.html
[spritely-paper]: https://files.spritely.institute/papers/spritely-core.html
[goblins-ocapn]: https://files.spritely.institute/docs/guile-goblins/0.18.0/OCapN.html
[ocapn-repo]: https://github.com/ocapn/ocapn
