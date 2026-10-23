---
name: 连续演化中的局部复用与状态责任
summary: 原生工作空间实际经历六阶段变化；领域客户端和单源知识可复用，但接洽成本转移到入口、期望与证据条件，尚未证明需要通用Core。
commit: "9-workspace-evolution"
experiments:
  - 14-workspace-evolution
scope:
  - 原生基线、访问变化、交付、GIS与既有设施演化
  - 持久知识在动作前影响执行及独立Agent新增组合
  - 成本增长观察、候选局部机制与未验证边界
---

# 连续演化中的局部复用与状态责任

`commit`引用包含本轮实验、证据与结论的标签`9-workspace-evolution`，可通过该标签复现。关联[案例1](../cases/1-heterogeneous-engineering-workspace.md)、[结论8的证据限定](8-api-review.md)、[逐步研究记录](../workspace-evolution.md)。没有修改案例以适应实验，没有重构历史包或实验13。

## 研究方法与可复现入口

[实验14](../../tests/14-workspace-evolution/demo.test.js)保留初始direct消费者及源码检查，按顺序增加访问转发、发布目标、GIS、设施变化、动作前知识门与独立Agent组合。实现分工和真实读写在[场景入口](../../tests/14-workspace-evolution/scenario.js)、[成本审查](../evidence/9-workspace-evolution/cost-review.md)、[Agent发现记录](../evidence/9-workspace-evolution/agent-discovery.md)中可追溯。

主线程先运行初始和访问阶段，再运行连续0至4；随后启动统一0至5的live工作空间，才向新的m1上下文提出“当前发布的只读运维交接包”任务。Agent只有公开receipt路径、现有源码入口与输出目录，没有拿到lab对象或现成组合实现。Agent新增消费代码后，主线程独立验证成功与错误期望下的部分失败。

这里的baseline是普通JS/ESM、原生工具与既有领域函数，不使用A/B/C；不是完全删除所有Locus领域成果的对照。没有新方案与它做等价职责的成本排名，也未证明长期增长率。

## 已验证事实

| 阶段 | 实际变化与行为 | 保留/失效边界 |
| --- | --- | --- |
| 初始 | 真实Git、Node语法检查、独立后端/网关进程及配置；overview/verify成功，请求200 | 一个直接地址快照；不是永久现场身份 |
| 一：访问 | 重启使旧地址/实例退役；带路径前缀和路由头的新转发入口；旧消费者失败，新inspect接线恢复原consumer函数 | 旧direct代码不被偷偷重定向；错误role/旧instance/错服务被拒绝 |
| 二：组合 | 真实构建、两文件制品复制、另一进程交付、独立HTTP内容与运行请求验证 | 仅指定payload及本次配置/请求契约，不证明整个制品或业务正确 |
| 三：GIS | 能力XML、参数校验、实际PNG及图像参数影响；错误请求返回ServiceException XML | 有界WMS 1.3.0子集、单层、EPSG:4326、lat/lon bbox、image/png，不是完整OGC/ArcGIS |
| 四：变化 | 实际修改并提交源码、重建交付新目标；GIS改名/配置写入/重启；保留多类既有消费者 | 旧A/A和新B/B各consistent，明确B期望配A运行mismatch；旧GIS地址/层名失败，新capabilities重读后可用 |
| 五：知识 | 单一持久JSON每次重读，独立Node冷读得到同一决策；文件状态编辑、过期、失效证据和冲突在动作前阻止执行 | 拒绝路径实际0环境写/0重启并保持现场；有效记录引导1写/1重启，再验收200；不是摘要标签 |
| 六：Agent | 新上下文发现现有函数和活服务，自行组合当前网关、全部advertised GIS图层与知识说明；生成3张真实PNG并保留原能力XML | 当前健康网关不自动修复；错误payload期望使总体not-ready，GIS证据仍保留；没有把部分成功当整体成功 |

主线程对阶段六重新读取生成的PNG、核对签名并重算hash，观察了实际图像；原receipt字节未变。对阶段五的验证还包括：空/缺失/改动证据、记录移除、授权后过期、冷读取、冲突后写入真实失败支持的refuted记录再评估。计数仅覆盖本实验显式门控的动作，不是OS级副作用拦截。

所有设施在单机本工作区内，使用真实Git/文件/HTTP/Node进程及有界GIS替身；无生产修改、真实SSH/FRP、跨物理机器、远端身份认证或真实GIS数据源的证明。转发路由头是实验路由约束，不是安全认证方案。

## 消费代码与发现归因

原有consumer函数接受明确的inspect函数，不要求统一对象模型：

```js
import { gatewayConsumers } from '../../tests/14-workspace-evolution/consumers.js';
import { inspectGatewayFromHandoff } from '../../tests/14-workspace-evolution/access.js';

const { overview, verify } = gatewayConsumers(inspectGatewayFromHandoff);
// directory是这次运行的显式工作区路径；读取交接文件，不维护全局注册表。
const summary = await overview(directory);
const requestEvidence = await verify(directory);
```

Agent新增的[交接消费者](../../tests/14-workspace-evolution/agent-extension.js)只接收文件入口和自己的输出目录：

```js
import { runAgentExtension } from '../../tests/14-workspace-evolution/agent-extension.js';

const result = await runAgentExtension({ receiptFile, outputDirectory });
// result.ok只在实际网关/地图与必要检查成立时为true；失败仍可读取保留的设施证据。
```

这些是说明API形状的代码，不是脱离运行目录即可执行的命令。上述相对import以本结论文档所在目录为基准；实际CLI与完整初始化以实验入口为准。

Agent能力主要来自读取源码、公开函数及原生协议响应，而不是Locus新增发现机制。它复用了发布取证、WMS/PNG客户端、持久知识评估；没有重写一个平行工作空间。单次成功不证明任意Agent可靠性，新增交接消费者也有显著的验证/报告实现成本，不能把入口调用简短当作整个系统便宜。

## 成本增长与机制候选

[成本审查](../evidence/9-workspace-evolution/cost-review.md)区分消费代码、fixture、验收和状态责任。阶段一新增接线；GIS新增协议客户端；阶段四无需修改既有HTTP消费者，但要重新关联期望版本、交付目标和新图层；知识增加持久记录、作者判断、证据保留与动作门控；阶段六又增加跨设施证据组装。不能把局部“0消费者修改”当作总维护成本为0。

| 候选 | 正向证据 | 反向/限定证据 | 本轮决定 |
| --- | --- | --- | --- |
| 原生领域客户端/明确函数边界 | 同一WMS客户端被GIS、变化和新Agent组合使用；同一发布判定处理旧/新/混合事实 | 仍需调用方理解坐标轴、期望版本和错误含义，不能由通用call推导 | 保留领域内复用，不升级为Core |
| 领域内单源 | GIS配置校验由supervisor/worker共用；知识可冷读、文件编辑实际改变动作 | 不是无状态：仍有配置/进程差异、作者信任及TOCTOU；未与其他设计做成本对照 | 保留明确单源，不冻结跨领域Schema |
| 本机子进程生命周期helper | lab/access/GIS存在近似ready/timeout/stop重复，本轮也发现关闭错误处理会漂移 | 属fixture而非消费者发现；未做共享前后等价对照，远程服务协议不同 | 值得局部比较或复用成熟工具，不创建平台 |
| 通用入口/身份/错误/知识模型 | 多处都有读取、比较、拒绝形状 | 当前权威来源、时间含义、失败后果不同；未实现通用方案做对照 | 保持待验证，不因相似形状提炼Core，也不宣称已证明不可能 |

没有出现必须由Locus新Core承担的实证需求；这是一项暂缓提炼决定，不是“原生永远更好”的证明。候选公共API仅在独立情境重复出现同一状态责任、并验证共享能减少具体接洽而不新增同步债务后才考虑稳定。

## 保留的错误判断与修正

1. **当前checkout可重验历史构建见证——错误。** 审查发现曾把`buildSource: gitWitness`用于旧artifact；这里gitWitness是当前HEAD。已修为artifact的构建时见证，当前HEAD另报liveSource。连续运行验证checkout移动不破坏旧A/A，而显式新期望仍能拒绝旧运行。错误代码未作为独立Git快照保存，原判断和修正依据保留在研究记录，不伪称运行过旧代码。
2. **包记录可只查ID，status/procedure留在内存——不足。** 这会使持久知识不能冷读重建语义，重复实验13的固定ID门禁。先前复用方案被否定；现有knowledge包的公开格式没有支持/反驳及procedure语义，最终改用一个领域JSON单源。不是把额外语义塞进steps，也不为迁就包维护两份状态。
3. **知识单源就自动安全——不足。** 曾缺少非空证据、路径边界、动作时重新评估。现实现对门禁必要字段fail-closed，执行前重读当前context和时间；仍不认证作者、语义或提供事务。受控写后失败另保留已发生副作用，不能当作未执行。
4. **两段相似字段路径就是同一返回契约——错误。** 统一runner因读取不存在的返回字段启动失败；GIS检查改为独立golden/invariants后，旧samplesMatch读取也使完整验收失败。失败目录保留且资源清理成功；已按实际返回迁移调用，没有加兼容别名。
5. **消费语法短就表示接洽成本低——未证。** 路由信息、当前期望、WMS约束、知识作者责任、部分失败报告均仍需代码和说明。新增Agent组合不提供统一发现API的收益证据。
6. **资源关闭就等于交接入口状态正确——错误。** 完整runner一度关闭全部资源却留下status=running的receipt。live模式本身会写closed，但默认runner漏做；生命周期验收发现此差异，已分别保留阶段六使用的running快照和关闭后的当前receipt。最终运行与永久断言验证二者的时间语义及hash差异，不让历史地址继续被表述成在线。

## 实现推断与设计假设

- **实现推断**：明确的领域函数边界使本轮多个消费者不必知道进程控制内部；共享生命周期helper可能减少同类关闭缺陷的重复修复。前者有本轮消费实例支持，后者没有共享前后对照，不能宣称维护收益已经测量。
- **设计假设**：第二个独立操作领域可能复用证据适用性的一部分；原生模块加少量说明可能足以支持更多Agent任务。尚无跨领域、长期成本或Agent可靠性数据。
- **不成立的外推**：未出现通用Core必要性证据，不等于通用机制已被证明无价值；多阶段通过也不等于现有实验函数应立即稳定为公开API。

## 保留、简化与待验证

- **保留**：原生组合、领域客户端、历史见证/当前观察的区分、单源知识与动作前再评估、部分失败证据、旧组合与失效引用的明确结果。
- **简化/不推进**：A/B/C、通用artifact scanner、通用fence/Schema、按名称推断有效性、公开可变event作为历史契约、为了旧验收添加别名。当前实验函数不作稳定公共包承诺。
- **待验证**：生命周期helper的等价维护收益；第二个独立领域是否需要相同证据适用性机制；并发编辑/外部变化的失败窗口；Agent所需上下文及人工接洽在长期演化中的变化。

## 下一步最值得验证的问题

在GIS配置/数据更新这类不同于网关重启修复的实际动作中，是否也需要“持久支持/反驳＋适用条件＋动作前拒绝”，并能共享其中一小部分而不复制网关的artifact/configModel词汇？先做原生实现与明确边界；若共享只省几行却增加状态同步，就保留领域扩展。

## 复现与最终验收

```sh
node tests/14-workspace-evolution/scenario.js
pnpm test
```

本轮最终实际运行：场景阶段0至6全部completed，accepted为true；全仓87项测试通过、0失败。所有资源关闭，GIS/workspace均closed、errors为空；当前receipt为closed，历史running快照与handoff中的原hash一致。[脱敏摘要](../evidence/9-workspace-evolution/summary.json)保留这些选取的观察；完整现场材料位于本机工作区`temp/workspace-evolution-6TArcu/`，不入Git，fresh clone需重新运行。

两个新增永久测试覆盖六阶段消费者/拒绝/部分失败/关闭行为，以及非空输出工作区不得破坏既有文件；它们不是架构合理性的充分证据。文档链接与结论字段已检查；未发布包、未创建稳定Core。
