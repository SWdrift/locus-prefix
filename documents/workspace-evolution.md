# 持续演化的工程工作空间

状态：初始状态及六阶段均已实施和验收。问题域沿用[案例1](cases/1-heterogeneous-engineering-workspace.md)，起点受[结论8](conclusions/8-api-review.md)限定：不把身份相等当作当前有效，不把冲突标签当作动作门禁，不用不等职责比较维护成本。最终事实、推断与假设见[结论9](conclusions/9-workspace-evolution.md)。

## 原始问题与范围调整

本轮研究的是连续变化下接洽成本的增长，而不是A/B/C的局部修补。最初实施只安排初始状态和第一项演化；用户随后明确要求本轮完成六阶段并使用subagent，因此范围扩展为下表全部阶段。此前写入的原生access/consumers初稿尚未运行，不作为成功证据。

先原生JS/ESM与已有工具，允许局部重复。仅在独立情境重复暴露同一接洽问题时才提出共享候选；普通JS能实现不是否定抽象的理由，理论通用也不是保留抽象的理由。当前不预设新Core或稳定API。

## 阶段与验收边界

| 阶段 | 需要实际观察的行为 | 不能据此声称 |
| --- | --- | --- |
| 初始状态 | 真实Git/源码、Node服务、配置；两个服务消费者与独立源码检查可运行 | 已支持真实多机器管理 |
| 一：访问变化 | 旧入口实际失效，消费侧接入新的转发入口；原消费者恢复，错目标拒绝 | HTTP转发已经验证SSH/FRP或网络隔离 |
| 二：跨设施 | 真实构建、制品文件、交付到另一目标、独立读取运行事实 | 标签相等即完整源码/运行正确 |
| 三：异构设施 | 保留GIS能力文档、请求参数、坐标/图像等原生约束；实际消费输出 | 本地有界GIS替身等于完整OGC或ArcGIS实现 |
| 四：既有变化 | 配置/实例/连接/制品改变后，多个既有消费者继续或明确失效；再次验证 | 相同身份/字段/hash即当前事实 |
| 五：知识决策 | 有效、过期、不适用或相反证据在动作前导致不同执行行为；拒绝时实际没有写入 | 查询为空或manual-review标签本身就是安全门禁 |
| 六：Agent扩展 | 独立Agent阅读现有公开消费面后完成一个未由场景脚本实现的新增接洽/组合；旧能力仍可运行 | 单次成功证明普遍Agent可靠性或新机制收益 |

## 分工与归因

m1的三个实现范围为：初始状态/访问变化，交付/GIS，既有变化/知识决策。主线程负责共享接口协调、选择实际Agent扩展任务、端到端验收与证据分级，不以子代理声称完成替代运行验收。

阶段六将从已实现并运行的工作空间中选择具体任务，再交给新的Agent上下文。分离记录Agent读到的源码/说明、执行的命令、修改文件和被告知的目标；不能把上层已给出的解法算作Agent发现。前五阶段由实现Agent写出的接入逻辑也不自动计作阶段六成功。

## 成本观察口径

每阶段记录：新增声明/适配/约定；仍需人工关联的信息；修改的消费者和实现位置；重复的接洽逻辑；发现入口与所需上下文；是否读取内部存储；错误引用/过期证据/部分失败的行为；旧组合是否保留；新增状态及同步责任。

这些是具体观察，不要求全部数值化；不以行数、测试数量或复用率单独排名。若比较共享候选与原生代码，二者必须承担相同的身份、失败、证据和副作用职责。没有候选时明确报告“尚未得到共享收益证据”，不能把六阶段成功等同于Core成立。

## 资产与真实性

复用实验11的createOperationsLab（真实本机Git、文件制品及独立Node/HTTP角色）和deployment-audit的公开取证/判定函数。实验13保留为反例与原生消费参考，不继承其WeakMap、Proxy、requireCurrent或公开event数组契约。历史实验和tests/lib不修改。

新增数据、服务、转发器及知识均留在本工作区内，使用匿名角色与回环网络；没有生产操作或私有身份。所有运行资源必须在验收结束后关闭。各阶段替身范围及尚未验证的外部协议须分别说明。

以下按实际运行结果记录，不把本表目标本身当作事实；[脱敏运行摘要](evidence/9-workspace-evolution/summary.json)可随仓库查阅，原始temp材料仅在本机保留，fresh clone需运行场景重新生成。

## 已观察：初始工作空间

主线程实际创建独立工作区并调用原生消费者：overview与verify返回同一gateway实例，requestStatus为200；源码检查读取真实Git HEAD，dirty为false，Node语法检查为valid。产物保留在本机工作区的`temp/evolution-baseline-ce6F9K/baseline-observed.json`，资源经finally关闭，运行进程退出0。随机实例、端口及该临时目录不是永久身份或可重用现场事实。

此阶段没有发现Agent收益或共享机制收益；只是建立可工作的比较起点。真实SSH/FRP、生产端点和跨物理机器仍未验证。

## 已观察：首次访问变化

主线程运行stage1成功，证据在`temp/evolution-access-nRQfcb/evidence/access/access-evolution.json`。旧gateway地址和实例实际退役；原overview/verify调用失败。转发入口要求显式路径前缀及路由头，消费侧读取运维交接文件后，原consumer函数以新的inspect入口恢复：overview成功、verify得到200，独立源码检查保持可用。旧实例、错误role及指向错误服务的入口均被拒绝。

这次适配由阶段实现代码生成新的消费入口，不归功于Agent自主发现；真正的独立Agent任务留在阶段六。旧direct消费者保留且继续失败，没有通过隐式重定向或注册表使它“自动恢复”。接洽成本从一个baseUrl变为路径前缀、请求头、当前实例与交接文件的明确关联；尚未证明这些成本跨领域重复，未提炼通用机制。该次运行资源已关闭，进程退出0。

## 已观察：交付、GIS与既有变化

主线程在同一工作区顺序运行阶段0至4，证据为`temp/evolution-stages24-ePKnGz/acceptance-stages24.json`，退出0并关闭资源。交付初验consistent；GIS的能力XML、PNG像素及参数边界检查通过。GIS为有界WMS 1.3.0替身：单图层、EPSG:4326、lat/lon bbox、image/png，不宣称完整OGC/ArcGIS支持。

实际修改并提交实验源码、构建新payload、交付新目标，以及更改GIS配置后重启。验收区分旧A/A consistent、新B/B consistent、明确B期望/A运行mismatch；checkout已移动时，旧delivery仍consistent，当前Git另报headMovedSinceBuild。gateway交接/旧direct、源码、交付、GIS能力和地图六类消费者分别保留并记录结果，而非由阶段脚本静默更新每个旧引用。

此处证明局部组合在有明确边界时可以继续；不证明旧地图参数、旧入口或旧能力文档能无限复用，也未测量人工节省时间。

## 已观察：知识在动作前参与

统一live入口在`temp/evolution-agent-session-c`运行阶段0至5，`evidence/acceptance.json`各阶段均completed且没有失败check。知识语义来自实际JSON文件，每次决策重读；独立Node进程重建相同决策，不再只查Markdown中的固定ID再回内存解释status/procedure。

现场证据显示：过期、被反驳、证据缺失/被改/记录移除、条件变化及冲突均拒绝，配置hash、实例与请求状态不变；有效知识触发一次环境写入与一次重启，随后请求200。把持久记录由verified改为refuted后，同一gate变为拒绝；冲突后追加真实失败支持的refuted记录，再读文件才允许剩余方法，执行仍需现场验收。动作时再次检查过期，没有把先前授权当永久许可。

这只支持当前配置模型的领域策略。可信作者仍能写出错误解释，hash不认证语义；检查与写入仍非事务，也不是安全沙箱。此live会话随后供独立Agent只读接入，已通过stdin-exit关闭，receipt和资源状态均closed。

## 已观察：独立Agent新增组合

前五阶段运行后，新的m1上下文仅拿到公开receipt路径、源码目录和只读交接目标，自行发现并调用现有发布取证、WMS和知识评估函数。生成了当前3个advertised图层的3张48×36 PNG、能力XML、网关证据及知识说明。主线程重新运行消费者并核对真实PNG/hash；仅改发布payload期望后，整体not-ready但GIS结果保留，原live receipt未被扩展修改。发现过程与新增成本见[Agent记录](evidence/9-workspace-evolution/agent-discovery.md)，不归因于不存在的通用发现API。

新增交接消费者包含较多采集、复核、部分失败和报告代码；简短入口并不等于低实现成本。单次Agent成功不证明可靠性或效率提升。

## 最终统一验收

`node tests/14-workspace-evolution/scenario.js`实际顺序完成阶段0至6，`accepted:true`；`pnpm test`为87项通过、0失败。最终原始材料保留在本地`temp/workspace-evolution-6TArcu/`；[摘要](evidence/9-workspace-evolution/summary.json)仅选取无私有路径/在线地址的观察。

所有GIS/网关/转发子进程已关闭，resources.errors为空。当前session-receipt为closed；阶段六曾使用的running输入单独保留为不可变证据快照，其hash与handoff绑定。此前runner“资源已关但receipt仍running”的错误保留在结论9，已修正并纳入行为断言。

## 实现中的收敛决定

验收审查发现阶段一出现源码文本/复制字段检查，阶段二倾向重新解释全制品manifest，阶段五出现自建fence语法与通用记录校验。已要求各owner移除非必要机制，保留真实行为和必要证据。不能以六阶段范围为由默许平行Schema/知识系统，也不能以“瘦身”为由删除失败或演化情境。最终实现和验收结果决定这些候选是否确有必要。

另发现交付重验曾将当前Git HEAD代入历史制品的buildSource，使开发checkout移到B后误报旧A/A契约失败。静态代码显示该语义不成立，已修正为构建见证保持构建时事实、当前源码单独观测。最终运行分别检验旧A/A、新B/B和显式新期望B/旧运行A这三个命题；修正前代码不是本轮认可的候选机制。
