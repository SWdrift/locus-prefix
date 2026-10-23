# 阶段0–5持续演化成本审查

状态：只读审查，成本结论范围仍是阶段0–5。阶段0–5的运行证据已验收；父级报告六阶段均完成分段实际验收，阶段6的独立Agent新组合成功、错误期望下GIS部分保留也已由父级独立验证，本文不将阶段6纳入成本结论。原本地session-c读取时`status`为`running`，随后经stdin-exit关闭；当前receipt为`status: closed`，`resources.closed/gisClosed/workspaceClosed`均为`true`，不再作为在线资源。实现已冻结；本次只更新文档事实，未改代码、未运行测试/build。

本文回答的是“接洽成本如何增长”，不是给最终行数、复用率或耗时排名。运行数字来自单机回环的一次实际运行，只能说明该次行为，不能外推为性能或生产结论。

**引用约定**：Git内的设计与代码使用相对链接。`temp/...` 是本地未入Git的运行材料，fresh clone无法打开，本文以inline path标注，不作公开可复现证据链接；脱敏summary由主线程另存。

## 一、审查口径与证据分级

成本分四层记录，避免把fixture成本算成消费成本：

| 层 | 本轮的体现 | 判断用途 |
| --- | --- | --- |
| 消费成本 | 冻结的消费者工厂、handoff读取、source读取、GIS/WMS调用、知识决策入口 | 新增/修改了多少消费侧代码、需要人工关联什么 |
| fixture/替身成本 | 工作空间创建、真实Git、制品复制、本机子进程、访问转发器、GIS/WMS服务与PNG替身 | 让行为真实发生所需的实验设施，不等于产品API |
| 验收/证据成本 | 阶段脚本、acceptance checks、evidence写入、refusal/mutation计数 | 证明行为发生；也不等于消费侧接口 |
| 状态/同步责任 | handoff、artifact/target、GIS config、Git HEAD、知识JSON及证据文件 | 演化后谁必须重新读取、谁保留过期引用 |

证据分级：

- **运行观察**：阶段0–5的checks、evidence、mutation计数来自本地`temp/evolution-agent-session-c/evidence/acceptance.json`（local-only）；阶段1另有本地`temp/evolution-agent-session-c/evidence/access/access-evolution.json`（local-only）。
- **静态阅读**：代码结构、重复函数、包API形状来自[消费者](../../../tests/14-workspace-evolution/consumers.js)、[访问实现](../../../tests/14-workspace-evolution/access.js)、[交付验证](../../../tests/14-workspace-evolution/delivery.js)、[GIS](../../../tests/14-workspace-evolution/gis.js)、[知识门](../../../tests/14-workspace-evolution/knowledge.js)、[场景](../../../tests/14-workspace-evolution/scenario.js)和[lab](../../../tests/11-operations-loop/lab.js)。
- **文档记录**：历史`buildSource`误用的语义问题见[设计边界](../../workspace-evolution.md)。旧代码未保留在Git历史中，未重跑，因此该历史只作文档证据，当前行为以现行代码和本轮运行证据为准。
- **范围外状态**：阶段6已由父级独立验收；其发现、证据和成本不在本文范围，不能作为本审查的候选收益证据。

旧访问运行`temp/evolution-access-nRQfcb/evidence/access/access-evolution.json`与旧阶段2–4运行`temp/evolution-stages24-ePKnGz/acceptance-stages24.json`（均为local-only）仅作历史对照，不作为当前现场事实。当前证据以本地session-c的`temp/evolution-agent-session-c/session-receipt.json`及其evidence（local-only）为准；该session已关闭，不再是在线资源。

## 二、逐阶段记录

| 阶段 | 消费侧改动 | 人工关联 | 旧组合结果 | 新增状态/责任 |
| --- | --- | --- | --- | --- |
| 0 初始 | 35行工厂+源码检查 | 读一个descriptor | 无 | `service.json`快照 |
| 1 访问 | +1个接线模块；冻结文件不变 | 5项，prefix+header+身份 | 旧direct失败，未自动恢复 | handoff+forwarder |
| 2 交付 | 0；新增verifier checks | 目标role/upstream、文件复制、Git/HTTP | 旧gateway保留，新target独立 | artifact/staging/target |
| 3 GIS | 新增WMS客户端；0既有消费者修改 | 配置/图层需从capabilities重读 | 旧URL失效，能力需重读 | config文件+子进程 |
| 4 既有变化 | 0 consumer code files | 3项：revision权威/新target/新图层 | direct仍失败；A/A保留；GIS旧地址/旧layer失败 | HEAD、第二target、GIS config |
| 5 知识 | 0 HTTP消费者；新增门控 | 记录/条件/证据/冲突作者责任 | 旧记录条件不匹配；refusal不改场景 | 单一JSON+证据hash |

表中“0”仅指既有HTTP消费者代码；阶段脚本、verifier、fixture以及协议客户端/替身的改动不计入该列。

### 阶段0：初始工作空间

- **表达**：`service.json`只声明`role`、`baseUrl`、`instanceId`；`consumers.js`提供`gatewayConsumers(inspectGateway)`和`inspectSource`；`initial/`是冻结副本。没有发现API或注册表。
- **人工接洽**：消费者读取一个服务描述符；源码检查独立读取真实Git并执行Node语法检查。基线只有直接地址，没有“当前实例”的第二种表达。
- **变化/重复**：无演化。消费者工厂是一个35行的小模块，被后续访问/变化阶段整体复用；源码检查复用[`@locus/deployment-audit`](../../../packages/deployment-audit/index.js)的`readGitSource`，没有另写Git解析。
- **正确性**：4项检查通过；overview/verify命中同一gateway实例，`/check`为200，Git为clean且syntax valid；证据见`temp/evolution-agent-session-c/evidence/initial-state.json`（local-only）。
- **演化/维护**：`service.json`是fixture写出的快照，阶段1后仍是磁盘上的过期直接描述符；这一“保留旧组合”是后续成本的起点，不是自动迁移。

### 阶段1：访问变化

- **表达**：新增`operations/access-handoff.json`（v1）：`service.role/instanceId`、`entry.baseUrl/pathPrefix/headers`、退休地址与说明；转发器返回`{url, pathPrefix, headers, close}`。一个可用请求必须同时满足路径前缀和路由头。
- **人工接洽**：证据列出5项——handoff取代`service.json`；期望身份来自handoff、观测身份来自live `/diagnostics`；URL由`baseUrl + pathPrefix`组成；每个请求带issued header；退休地址只能靠探测或旧消费者失败发现。
- **变化**：新增1个`adapted-entry.js`接线模块；冻结的`access.js`/`consumers.js`哈希不变（witness `changed: false`）；旧direct消费者保留并继续失败；没有隐式重定向、回退或自动恢复。
- **重复**：服务位置和期望身份在`service.json`（退休快照）与handoff各有一份，这是两种状态而非两份实现；diagnostics schema/检查语义由direct与handoff入口共用同一个`inspectEntry`，是共享而非重复；真正的代码重复是子进程readiness/stop逻辑，见第五节。
- **发现/封装**：发现入口是操作交接文件和live diagnostics，没有新Locus API。`inspectGatewayFromHandoff`只做“读文件—校验—请求—身份比对”，不写注册表、不刷新handoff。
- **正确性**：6项检查通过；prefix外404、缺/错header 403、完整请求200；stale instance和错role均`WRONG_TARGET`，指向错误服务的issued route为`NOT_READY`；旧direct为`ECONNREFUSED`。
- **演化/维护**：handoff是新状态，`service.json`故意留在磁盘上过期；forwarder目标与本次restart绑定，gateway角色再次restart就需要新目标和新handoff。没有轮换、过期、撤销或自动刷新。实现归因于阶段代码，不是Agent发现。

### 阶段2：交付变化

- **表达**：artifact manifest与`expected {release, sourceRevision, payloadSha256}`；artifact还带构建时的`buildSource`。验证输出以check id表达：`artifact.delivery-integrity`、`target.health`、`target.identity`、`target.upstream-config`、`target.upstream-request`、`expected.payload-binding`。
- **人工接洽**：选择目标role/upstream；复制两个制品文件；从lab registry发现live endpoint；独立读Git与HTTP。消费者代码不需要改。
- **变化**：`runDeliveryEvolution`增加endpoint发现、健康/身份/上游/请求和payload检查；产生与initial gateway不同的新target及staging目录；本阶段只新增交付目标。
- **重复**：制品复制和`assessRelease`都检查payload字节/摘要，但一个验证“文件搬运未变”，一个验证“声明与运行一致”，职责不同；`buildSource`与`liveSource`分开；delivered/current/observed三种instance身份并列，服务于不同比较。没有通用artifact scanner，也没有第二个版本注册表。
- **发现/封装**：`delivery.verify()`的checks与`liveSource`是发现/判断入口；返回`{artifact, target, expected, verify}`的闭包。endpoint优先从lab registry发现，但语义事实仍来自文件/HTTP观察。
- **正确性**：4项验收检查通过；上述6个check全pass，verdict为`consistent`；本次运行5次HTTP、1次Git读取、制品11,738字节。边界明确为单机子进程/端口，不是第二台主机。
- **演化/维护**：历史构建见证、当前checkout、交付目标三方分离；旧target保留为旧artifact的证据；没有自动刷新或跨主机声明。

### 阶段3：异构GIS

- **表达**：有界WMS 1.3.0子集（EPSG:4326、lat/lon bbox、`image/png`、单请求单图层）、`gis/config.json`、capabilities与map响应；支持边界错误用ServiceException XML表达。
- **人工接洽**：从capabilities获取图层/CRS/bbox；配置写入后必须restart；旧URL不能继续使用，新配置图层要从新capabilities获取。新增有界WMS客户端；初始gateway/source消费者不改；没有为GIS另造通用发现层。
- **变化**：新增WMS客户端；`startGis`管理真实子进程和配置；`updateConfig`返回`requiresRestart`；restart产生新URL/instance；旧地址停止服务，新配置的图层可用，未知图层按协议返回`LayerNotDefined`。
- **重复**：子进程readiness/stop再次与lab/access重复；但`gis-config.js`把默认配置和校验集中为单一领域源，`gis.js`与`gis-worker.mjs`共同导入；地图检查使用独立golden table/通道与轴向不变量，没有复制renderer公式。
- **发现/封装**：`url`/`instanceId`/`configSha256` getter加`getCapabilities`是发现入口；`startGis`返回live closure；没有通用资源/服务抽象。
- **正确性**：7项验收检查通过；8个参数边界均400 XML；非法config在写盘前拒绝且文件hash不变；合法config写入后、restart前运行服务仍报告旧能力；restart后旧URL不可达、新图层map成功。本次15次HTTP、2次进程启动、2次config写尝试（1次拒绝、1次接受）。
- **演化/维护**：config文件与运行进程是两个状态，写入不会自动生效；caller负责`close()`；范围只到本机有界WMS替身，不声称完整OGC/ArcGIS。

### 阶段4：既有变化

- **表达**：没有新增面向消费者的词汇；沿用artifact/expected/target、access handoff、GIS capabilities。变化体现在这些文档中的数据引用，而不是新API。
- **人工接洽**：证据列出3项——旧expected revision与新HEAD谁是权威；新target role/identity；重读capabilities获得重命名后的图层，旧请求无法推断。
- **变化**：`consumerCodeFilesChanged: 0`；更新3类数据引用（source revision、delivery target role/url/instance、GIS url/layer）；1次提交、1次通过既有pipeline的build、1个新target、1次config写、1次GIS restart。旧direct继续失败，handoff consumer继续成功，source inspector重读HEAD，delivery verifier继续验证A/A。
- **重复**：`assessRelease`在同一阶段被复用于四种组合（A/A、B/B、B期望/旧运行时A、A期望/新制品/旧运行时A）；消费者工厂、交付pipeline、WMS客户端均复用；没有新增change/registry/revision抽象。
- **发现/封装**：`delivery.verify()`的failed checks、evolved target/expected、GIS closure与capabilities是发现入口；`runChanges`只返回artifact/target/expected和证据。
- **正确性**：9项检查通过；旧A/A `consistent`、新B/B `consistent`、显式B期望/旧运行时A为`mismatch`；旧target identity未变而HEAD已移动；4个预期失效/过期引用分别是direct access、旧source revision的freshness、GIS旧地址、GIS旧图层。证据见`temp/evolution-agent-session-c/evidence/changes/summary.json`（local-only）。
- **演化/维护**：HEAD、第二target、GIS config三处状态都要重新读取；没有自动传播。fresh target仍登记在共享lab，GIS进程由caller closure拥有；旧组合没有被静默改写。

### 阶段5：知识决策

- **表达**：单一领域JSON文档中的记录：`id`、`status`（verified/refuted）、`procedure`、`steps`、`conditions {artifactSha256, configModel}`、`evidence[]`、`expiresAt`；决策输出`decision`、`primaryReason`、`authorizedBy`等。没有面向HTTP消费者的新schema。
- **人工接洽**：作者写入记录和证据；condition绑定artifact/config；冲突时还要写相反claim；状态编辑、过期和proposal都由文件/调用方给出。不是既有HTTP消费者的适配。
- **变化**：无既有HTTP消费者代码改动；新增门控在阶段代码内。每个决策重新读取文件，不依赖进程内记录列表；另起Node进程冷读同一文件；执行前还会按动作时时钟重读。
- **重复**：记录校验、证据真实路径与hash校验与`@locus/operational-knowledge`包内部相似，但未导入；单文件单评估；`executeProcedure`是本地函数。没有通用schema框架或知识引擎。
- **发现/封装**：发现入口是knowledge文件及其证据hash、决策reason；空结果不被当作安全；没有真实性认证。
- **正确性**：18项检查通过；10个refusal，覆盖expired、refuted、empty/missing/modified证据、记录移除、动作时过期、条件变化和冲突。动作前refusal均为0写0重启；bootstrap在知识存在前花2次环境写+1次restart；valid授权恰好1写+1restart；conflict的refusal为0写0重启，但为获得真实反驳额外做了1次restart-only尝试（0写1重启），之后1写+1restart。冷读结果与主进程一致，编辑状态可把execute改为refuse。
- **演化/维护**：一个JSON文档是知识语义单源，证据文件由hash绑定；作者信任、并发编辑的TOCTOU窗口、无锁/无回滚、单一修复procedure都是明确边界。证据见`temp/evolution-agent-session-c/evidence/knowledge/summary.json`（local-only）。

## 三、成本增长在哪里

### 1. 若干阶段既有消费者无需改动，但不能据此推断长期增长率

消费侧在阶段1新增1个接线模块；阶段3新增一个WMS协议客户端；阶段4对既有HTTP消费者代码的修改为0；阶段5没有改HTTP消费者。这个`0`只覆盖“既有HTTP消费者文件”，不覆盖阶段新增的WMS客户端、verifier、fixture、知识门和证据代码。阶段3的协议客户端、各阶段fixture和知识门都是真实成本，因此不能从这些阶段的`0`推断长期增长率，也不能把“消费者代码少”解释为“接洽成本低”。成本主要落在发现当前入口、判断哪个引用仍是当前、以及在动作前重新读取状态。

### 2. 新增代码主要在fixture/验收/协议层，不能直接作为Locus收益证据

新增代码主要集中在`fixture.js`、`access-proxy.mjs`、`gis.js`、`gis-worker.mjs`、`png-codec.js`、`stage1.js`、`delivery.js`、`changes.js`、`knowledge.js`、`scenario.js`，以及阶段3的`wms-client.js`；它们分别承担真实Git、进程、协议服务、图像、证据和GIS客户端。初始消费者是35行工厂，阶段1增加1个接线模块，阶段3增加WMS客户端，阶段4对既有HTTP消费者代码修改为0。模块总行数只说明成本所在层，不作为效率或质量排名。

### 3. 旧组合保留是刻意成本

旧direct消费者在阶段1后仍失败；旧`service.json`仍在磁盘上；旧delivery target和旧artifact继续作为旧世界证据；GIS旧地址/旧图层失败；旧知识记录在条件变化后变为不适用。阶段4的4个预期失效/过期引用不是回归，而是“不静默迁移”的可见成本。维护者必须知道哪些旧引用应失败，哪些应重读；这比自动刷新更贵，但也保留了判断依据。

### 4. 表达没有统一成一个“当前对象”

阶段0–5分别使用service descriptor、access handoff、artifact/expected、WMS capabilities、knowledge record。五种表达服务于五种事实和时间点。把它们压成一个“current state”会减少字段数量，却会丢失“谁是权威、何时读取、失败意味着什么”。本轮没有出现需要统一表达的独立情境。

## 四、重复候选与静态风险

以下只讨论局部共享候选和未实现对照的静态风险，不提出完整架构。每行回答：消除了什么重复、局部函数是否足够、新增什么状态/概念、移除后损失什么、领域范围。

| 候选 | 消除的重复 | 局部函数够吗 | 新状态/概念 | 移除后的具体损失 | 领域范围 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 子进程生命周期 | `processIsAlive`/`waitForExit`/`stopChild`/`waitForReady`/`validateReadyUrl`在lab、access、GIS三处近似重复，均解析JSON ready行并按SIGTERM→SIGKILL停止 | 从结构看可覆盖；共享收益未对照，且lab只读 | 子进程句柄与ready payload；无业务状态 | 三处分别修readiness/shutdown缺陷；本轮未观察到消费侧损失 | 本机子进程fixture，不是远程健康检查 | 正向重复成本；局部共享候选（未做对照） |
| P2 证据/捕获helper | `sha256`/`isRecord`/`portablePath`在多个文件重复；`saveEvidence`在changes/knowledge近似，`capture`在stage1/changes/scenario近似 | 从结构看可整理；但语义分化，共享收益未对照 | evidence descriptor（path+hash）；无新领域状态 | 只损失重复的验收代码，不影响消费行为 | 验收harness | 弱候选；局部harness整理（未做对照） |
| P3 GIS config | 默认配置与校验已在`gis-config.js`单源，被`gis.js`和`gis-worker.mjs`共用 | 当前已单源；无需新增抽象 | config文件+运行进程+`requiresRestart` | 若拆散，server与supervisor可能对非法config不一致，可能写入/运行不同配置 | WMS替身领域 | 已实现的领域内单源；不是通用schema |
| P4 知识单源 | 消除“包Markdown记录 + 本地JSON”双解释，以及“进程内列表 + 文件”双读取 | 当前已单源；无需新增抽象 | 一个JSON文档、状态/程序/条件/证据/过期、动作时重读 | 不能冷进程复现；状态编辑/过期/反驳不改变门；空结果可能被误当安全；冲突无法区分 | 单一workspace、单一修复procedure | 已实现的领域单源；不证明Core |
| C1 通用服务定位/注册表 | handoff、lab registry、GIS closure、session receipt都在回答“当前入口/身份” | 当前局部读取已覆盖；共享是否更优未对照 | provenance/trust/refresh责任 | 可能丢失stale/wrong-role拒绝、旧direct仍失败、restart后getter更新等差异 | 范围大于当前证据；无第二独立领域 | 静态风险；待验证候选（未实现对照） |
| C2 通用错误/拒绝taxonomy | access错误码、delivery check状态、WMS异常、knowledge reason都在表达失败 | 当前局部码已覆盖；共享是否更优未对照 | 跨协议错误模型 | 消费者无法区分重试、换目标、拒绝动作、协议不支持 | 范围大于当前证据 | 静态风险；待验证候选（未实现对照） |
| C3 通用artifact scanner | 交付只复制两个已知文件并比对字节；包/manifest有制品语义 | 当前局部比较覆盖交付形状；通用化未对照 | 通用manifest/文件集模型 | 当前不会少检；引入scanner反而要重新解释manifest，增加双源风险 | demo artifact形状 | 静态风险；待验证候选（未实现对照） |
| C4 通用身份比较器 | access、delivery、changes都比较role/instance/url；knowledge比较instance/url、环境摘要和config model | 当前局部比较覆盖各调用点；通用化未对照 | expected/observed集合与容忍选项 | 共享只省几行；不同调用点比较的字段和后果不同 | 范围大于当前证据 | 静态风险；待验证候选（未实现对照） |

表中的重复/接口判断来自静态阅读，不是运行测量；它们说明候选的结构边界，不能替代阶段0–5的实际行为证据。C1–C4没有实现对照，也没有运行比较；它们当前只能说明统一时需处理的语义差异和风险，不能作为候选优劣或收益结论。P1/P2也没有共享前后的对照，只有重复结构；P3/P4是已实现的领域内单源，但没有与其他设计做对照。反过来，阶段行为通过也不证明某个候选具有普遍收益。

### 正向重复的具体判断

**P1是实质重复中最明显的一处：三个文件各自重复了完整生命周期。** 它是局部共享候选，理由是停止/超时/ready解析的错误处理容易漂移；但仅凭三处重复不能证明共享收益，需要先做共享前后的对照。它的领域严格限于“本机Node子进程通过stdout JSON行宣告ready”。access转发器、GIS worker、lab worker恰好共享这个协议，不代表远程服务、SSH/FRP、HTTP健康检查也能共享。且lab.js属于历史实验，当前约束下不能为了去重修改它；因此可验证的范围只是tests/14内的局部复用，不能把它包装成平台机制。

**P2的重复大多是3–10行的trivial helper，且错误摘要语义已经分化。** 把`sha256`/`isRecord`抽出来不会显著降低维护成本；把`capture`/`summarizeError`强行统一，反而会让阶段1的目标身份字段、场景的stage字段、changes的紧凑status互相污染。它最多是验收harness的局部整理，不能作为消费接洽收益。

**P3显示当前实现中领域内单源确实在运行：** 同一份`assertValidGisConfig`同时约束supervisor和worker，非法config在写盘前被拒绝；但这只是当前实现的行为，没有与拆分校验的版本做对照。它的边界由WMS字段和像素约束决定，不是通用配置Schema，也不处理其他领域。

### 为什么“三个阶段都重新读取身份”不能推出Core

阶段1、2、4、5都出现“重新读取当前事实、与期望比较、不满足则拒绝/报告”的形状，但：

1. 事实来源不同：操作交接文件、lab registry、运行closure、知识JSON+证据hash。
2. 比较对象不同：期望/观测实例、delivered/current/observed、场景前后、条件与记录。
3. 失败后果不同：换入口、判mismatch、报告freshness、拒绝动作或要求新知识。
4. 共享抽象必须拥有“什么是当前、谁有权更新、拒绝后做什么”的语义，这正是各阶段已显示的语义差异。
5. 只有一个workspace和一个修复procedure，没有第二个独立领域来检验通用性。

因此，重复出现的是**判断形状**，不是可共享的状态责任。不能因为重复三段就宣称Core成立；同样，C1–C4没有被实现对照，也不能据此认定这些通用候选必然失败，它们仍是待验证风险。

## 五、历史误用与单源成本

### 1. `buildSource`误用：历史见证不能由当前checkout替代

[设计边界](../../workspace-evolution.md)记录了修正前的语义：交付重验曾把当前Git HEAD代入历史制品的`buildSource`，开发checkout移到B后，旧A/A契约被误报失败；静态代码显示该语义不成立，要求修正。这个历史未在本文重跑，因为旧代码没有保留在当前Git历史中；这里把它标为文档证据，当前行为以现行代码和本轮运行证据为准。

现行实现把两个时间点拆开：

- `artifact.buildSource`来自构建时的lab witness，作为历史事实传给`assessRelease`；当前checkout由独立的`readGitSource`观察，输出`liveSource`、`liveMatchesBuild`、`liveMatchesExpected`、`headMovedSinceBuild`。
- `verify()`继续回答“期望A vs 运行时A”；显式`expected B`回答“新期望是否绑定到该运行时”；source freshness只回答“当前checkout是否还是构建时的那个”。
- 阶段4运行证据显示：HEAD已移动，但旧A/A仍`consistent`；新B/B `consistent`；显式B期望配旧运行时A为`mismatch`；旧target identity未变。见本地`temp/evolution-agent-session-c/evidence/changes/summary.json`和`temp/evolution-agent-session-c/evidence/delivery.json`（local-only）。

成本原因：`buildSource`和`liveSource`看起来都是“源码版本”，但一个是构建时见证，一个是当前世界观察。合并成一个字段会同时产生两种错误——checkout移动时误报旧制品失败，或用当前HEAD为旧制品背书。修复后多出几个字段和比较，但都是局部字段/局部判断，不需要revision注册表或新的源码服务。领域范围是制品/发布验证，不是通用版本真相。

### 2. 双源知识解释：为什么最终只保留一个领域JSON

[`@locus/operational-knowledge`](../../../packages/operational-knowledge/index.js)的公开格式是Markdown中的fenced记录，字段为`id/originalClaim/correction/steps/conditions/evidence/expiresAt`；`findApplicableFindings`只返回当前适用的记录，并静默跳过格式错误、过期、条件不匹配或证据失效的记录。它适合“追加人类可读发现”，但不能持久化本阶段需要的typed `status`（verified/refuted）和`procedure`，也不能在拒绝时给出`EXPIRED`/`CONDITION_MISMATCH`/`EVIDENCE_UNVERIFIED`/`REFUTED_PROCEDURE`等区分。把status/procedure塞进`steps`会变成文本解析，而不是持久化语义。

若同时使用包记录和本地JSON，同一个事实可能有两套状态和两套读取路径：主进程、冷进程、文件编辑后的判断可能不一致；空查询结果也无法区分“没有知识”和“所有知识都失效/被反驳”。因此阶段5选择单一来源：`knowledge/operational-knowledge.json`，每次决策重新读取，不保存进程内记录列表。`evaluateKnowledgeFile`是文件入口，校验记录字段、证据真实路径与sha256、条件、过期和冲突；执行前按动作时时钟再读一次。证据见本地`temp/evolution-agent-session-c/evidence/knowledge/summary.json`（local-only）与[知识门实现](../../../tests/14-workspace-evolution/knowledge.js)。

成本与收益：

- **收益**：状态编辑、过期、证据缺失/篡改、条件变化和冲突都能在动作前改变决策；10个refusal均为0写0重启；冷进程能从同一文件复现execute/refuse；冲突通过追加真实反驳记录改变文件hash并释放门控。
- **成本**：自己维护一个小型存储/校验器，放弃包的Markdown人类可读格式和追加API；需要作者正确写证据，且没有身份认证、锁、事务或回滚；执行前重读仍存在检查与变更之间的TOCTOU窗口。
- **范围**：一个workspace、一个gateway修复procedure、少量记录；不证明通用知识引擎、冲突自动解决或真值认证。第二个独立procedure/领域尚未出现，因此不能把“单源有效”推广为Core。

“单源”在这里消除的不是代码行数，而是**同一事实的两种解释**。这是本轮最强的领域内单源实现证据，但没有与其他设计做对照；它的边界由知识记录的字段和动作语义决定，不能直接搬到访问、交付或GIS。

## 六、支持证据、未验证候选与未知

### 支持的证据

- 既有消费者工厂在阶段0/1/4被复用；阶段1增加一个接线模块，阶段3增加一个WMS客户端，阶段4对既有HTTP消费者代码修改为0并显式记录`consumerCodeFilesChanged: 0`，阶段5没有改HTTP消费者。
- 访问变化产生的新入口可被旧消费者函数恢复使用；stale instance、错role、错target均被拒绝，旧direct仍失败，没有隐式恢复。
- 交付、GIS和变化阶段分别用独立观察证明了内容、协议和状态差异；旧A/A、新B/B和混合B/旧运行时A三种命题被区分。
- 单一知识JSON加动作时重读，使refusal不产生写入，valid只产生一次写入+一次重启，冷进程与主进程一致。
- 上述行为均来自实际运行证据，而非仅静态推断；阶段0–5在本地`temp/evolution-agent-session-c/evidence/acceptance.json`（local-only）中均为completed。

### 未验证的推广与限制

- 本轮没有实现通用发现API、服务注册表、统一当前状态对象、通用知识引擎、artifact scanner或跨协议错误模型的对照，因此没有它们的收益证据。现有语义差异（见C1–C4）说明统一前必须处理来源、信任、失败和动作差异；这只构成静态风险，尚不足以判断候选优劣。
- 子进程生命周期的实质重复存在于fixture/历史lab，不是消费者接洽；它支持局部helper候选，但不能作为Locus机制收益。
- 消费代码稳定不等于接洽免费：人工关联、状态再读取、旧引用判断和知识作者责任都在增长。
- 本轮仍是单机回环、本地子进程、演示worker和有界WMS；没有SSH/FRP、跨物理机、生产认证或网络隔离证据。
- C1–C4是否可行、共享后是否降低维护成本，需要独立实现和对照；本文不预判。

### 未知

- 阶段6已由父级独立验收，但其独立发现的具体过程和成本未纳入本文；因此不能用阶段6的验收结果补充或否定阶段0–5的候选判断。
- 是否存在第二个独立领域/修复procedure，能重复知识门或身份判断的形状；当前没有。
- 并发编辑下的TOCTOU、长期轮换/撤销、人工操作成本和多机故障语义；本轮没有测量。
- 历史`buildSource`误用没有重跑；其错误行为来自文档记录和现行代码的对照，不是本轮复现实验。

## 七、边界

本文只审查阶段0–5的成本与候选机制证据，不提出完整架构，也不把阶段0–5成功等同于Core成立。阶段6已由父级独立验收，但本文不将其行为、证据或成本并入0–5结论；实现冻结后，本文仅作事实分级与范围说明。角色名按匿名角色处理；`temp/...` 仅作local-only引用；未引用本机绝对路径、真实生产身份或现场私有token。最终研究结论由主线程验收。
