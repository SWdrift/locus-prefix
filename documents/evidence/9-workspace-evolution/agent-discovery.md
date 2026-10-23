# 阶段六独立消费者：只读运维交接包

本文件记录一个独立上下文实际增加并运行的消费者，不继承此前实现者的发现记录。它说明读了什么、如何确认接口、哪些信息来自源码、哪些来自当前活服务，以及本次真实输出的边界。这里不写阶段验收结论；实际输出由主线程验收。

## 任务与边界

目标是在当前活工程工作空间中增加一个此前没有的只读消费者：把当前发布交给另一操作者时，在同一个输出目录中给出

- 新鲜的网关运行/就绪证据；
- 从活 GIS 读取的真实 advertised 图层清单，以及每层一张小地图；
- 对已有排障知识何时可用、何时不应自动修复的说明。

消费者只能接收公开 receipt 路径和调用方自己的输出目录。它不读取 lab/registry 闭包，不写目标配置，不重启，不部署，也不修改知识或证据文件。输出目录必须为空，避免把旧 summary 或上一轮 PNG 混进同一交接包。

## 新增入口

- 导出：`runAgentExtension({ receiptFile, outputDirectory })`
- CLI：`node tests/14-workspace-evolution/agent-extension.js --receipt <session-receipt.json> --output <empty-directory>`
- 成功或服务失败时都返回 `ok`、`status`、`outputDirectory`、`handoffFile`、`facilities`、`failures`、`files`；receipt 无法读取时写 `failure.json` 并返回失败证据。
- CLI 退出码：ready 为 0，not-ready 为 1，参数/输出目录前置条件错误为 2。

实现位置只有一个新文件：`tests/14-workspace-evolution/agent-extension.js`（消费者与 CLI 同文件）。没有新增注册表、插件协议或描述语言。

## 实际运行与输出

公开入口为 `temp/evolution-agent-session-c/session-receipt.json`，运行时 `status` 为 `running`。实际命令：

```text
node tests/14-workspace-evolution/agent-extension.js \
  --receipt temp/evolution-agent-session-c/session-receipt.json \
  --output temp/evolution-handoff-final
```

本次输出目录为 `temp/evolution-handoff-final/`，包含：

- `handoff.json`：总体 verdict、各设施摘要、失败列表、文件字节数与 SHA-256；
- `handoff.md`：由同一批观测生成的操作者说明；
- `gateway.json`：health、diagnostics、release、payload、upstream 请求与最终复检；
- `gis.json`：capabilities 摘要、每层 bounds/map 请求/采样、健康与计数；
- `gis/capabilities.xml`：运行时读取的原始 capabilities 文档；
- `maps/01-terrain-rev2.png`、`maps/02-population.png`、`maps/03-parcels.png`：每层一张 48×36 小地图；
- `knowledge.json`：记录适用性、每个 procedure 的决定、拒绝原因、上下文与策略；
- 无 `failure.json`（receipt 可读，设施均完成采集）。

本次实际观测（点时间快照，不是验收结论）：

- receipt 的 delivery role 为 `evolution-target`，不是固定名称 `gateway`；gateway 12/12 checks 通过，`/check` 返回 200，upstream 200。
- `/payload` 实测字节 SHA-256 与 receipt `expected.payloadSha256` 相同；release/sourceRevision 与 receipt 相同。
- GIS advertised 3 层：`terrain-rev2`、`population`、`parcels`。三层 bounds 均由本次 capabilities 给出（w116,s39.5,e116.8,n40.3），没有使用源码常量或旧现场坐标。
- 三层 GetMap 均返回可解码 PNG，尺寸 48×36；字节数分别约 3561、3561、3560，SHA-256 各不相同。`gis/capabilities.xml` 与每张 PNG 的摘要都写入 `handoff.json`，并已独立重算核对。
- 同一知识文件有 5 条记录、3 个 procedure。本次现场决定为：
  - `clear-environment-restart-verify`：`execute`，仅由 `r-clear-override-restart-artifact-2` 授权；
  - `write-correct-environment-no-restart`：`refuse`，`CONDITION_MISMATCH`；
  - `restart-gateway-only`：`refuse`，`REFUTED_PROCEDURE`。
- 本次 gateway upstream 正常（`/check` 200），因此知识评估同时记录 `applicationNow: not-needed-healthy`：execute 只表示该流程在当前条件下可作为人工参考，不表示现在应做修复。
- 最早记录到期时间约为本次运行（01:08:52Z）后 20 分钟；`knowledge.json` 记录该时刻，要求动作时重新评估。

本次消费者运行结束后，live session 的所有者通过 stdin-exit 正常关闭了这些本机进程。关闭后的 receipt 记录：`status: closed`、`reason: stdin-exit`、`closedAt: 2026-10-23T01:09:20.909Z`，且 `resources.closed`、`resources.gisClosed`、`resources.workspaceClosed` 均为 `true`、`resources.errors` 为空。本文件描述的是关闭前（输出包生成于 01:08:52Z）的点时间快照；本消费者没有重启、重新部署或改写任何目标配置。服务关闭后的复探只能作为失败证据，不能当作同一活现场，也不能当在线资源继续使用。

### 实际读取的文件与命令

代码/接口发现（只读；部分文件只读相关范围）：

- `tests/14-workspace-evolution/session.js`：receipt 的公开字段与状态。
- `tests/14-workspace-evolution/delivery.js`：既有网关健康、诊断、release、payload 和 upstream 请求的消费语义。
- `tests/14-workspace-evolution/gis.js`：GIS 生命周期、能力/地图证据与协议边界。
- `tests/14-workspace-evolution/wms-client.js`：`getCapabilities`、`getMap`、PNG 解码与 ServiceException 观察。
- `tests/14-workspace-evolution/png-codec.js`：用于独立复核生成 PNG 的解码器；未改写。
- `tests/14-workspace-evolution/knowledge.js`：`evaluateKnowledgeFile` 的适用性/拒绝语义。
- `tests/14-workspace-evolution/demo.test.js`、`consumers.js`：现有消费者行为与阶段边界参考。
- `packages/deployment-audit/observation.js`、`http.js`、`assessment.js`：`observeRelease` 的字段、截断和限制。
- `temp/evolution-agent-session-c/delivery/artifacts/.../worker.mjs`：网关各 HTTP 端点的实际响应形状。
- `temp/evolution-agent-session-c/session-receipt.json`：唯一公开入口。
- `temp/evolution-agent-session-c/knowledge/operational-knowledge.json`：实际知识记录；同目录其他 `operational-knowledge.*.json` 是情景快照，消费者优先只读精确文件。
- `temp/evolution-agent-session-c/evidence/knowledge/**`：由 `evaluateKnowledgeFile` 读取并校验哈希；本文件不复制其结论。
- `temp/evolution-agent-session-c/evidence/knowledge/summary.json`：仅用于了解已有情景命名；没有当作当前现场或复用其结论。
- `temp/evolution-agent-session-c/service.json`、`operations/access-handoff.json`：仅用于确认它们是旧入口/已退役地址，没有用于当前交接。

实际命令（均为相对路径）：

- `curl -sS` 对活 delivery 的 `/healthz`、`/diagnostics`、`/_release.json`、`/check`，以及活 GIS 的 `/healthz`、`/wms?service=WMS&request=GetCapabilities` 做初次接口确认。
- `node --check tests/14-workspace-evolution/agent-extension.js`。
- `node tests/14-workspace-evolution/agent-extension.js --receipt temp/evolution-agent-session-c/session-receipt.json --output temp/evolution-handoff-final`；另用临时 receipt/知识副本运行故障、期望不符、过期、缺失和输出目录非空等场景。
- `node --input-type=module -e` 读取生成物，使用现有 `decodePng` 复核 3 张 PNG 的尺寸，并重算 `handoff.json` 所列每个文件的 SHA-256。
- 用 `grep` 和范围 `read` 查看源码；没有通过旧 summary/旧 evidence 推断当前服务状态。

## 发现的接口、来源与约束

| 信息 | 来源 | 本次处理 |
| --- | --- | --- |
| receipt 字段与语义 | `tests/14-workspace-evolution/session.js`、实际 receipt | 只使用公开字段：`status`、`directory`、`delivery`、`gis`、`expected`、`updatedAt`；不读取 lab/registry。 |
| 网关 endpoints | `delivery.js` 与 gateway worker 源码；再用当前服务确认 | 使用 `/healthz`、`/diagnostics`、`/_release.json`、`/payload`、`/check`。 |
| 发布 metadata/payload 取证 | `packages/deployment-audit/observation.js` 的 `observeRelease`；已复用，未重写 | 由它读取 metadata 与 payload；消费者只把结果转成证据摘要并比较 receipt 期望。 |
| GIS health 与 WMS | `gis.js`、`wms-client.js`、`gis-worker.mjs`；再用当前服务确认 | 复用 `getCapabilities`/`getMap`；不重写 WMS 解析、PNG 编解码或采样。 |
| 图层名与坐标 | 本次活 capabilities（不是源码或旧现场） | 逐层从 `geographicBounds` 推导 WMS 1.3.0 `[south,west,north,east]`；没有预定名称/路径。 |
| WMS 约束 | 源码注释、client 行为、活 response | 1.3.0、EPSG:4326、lat/lon bbox、单层 GetMap、image/png；不宣称完整 OGC/ArcGIS。 |
| 排障知识位置 | 由 receipt 的 `directory` 下发现 `knowledge/operational-knowledge.json` | 只读目录枚举；没有从旧 summary 复制结论。 |
| 知识决定语义 | `knowledge.js` 的 `evaluateKnowledgeFile`；已复用，未重写 | 对每个 procedure 重新读取记录与证据哈希；评估上下文来自本次 payload 摘要和 diagnostics 的 `configuration.model`。 |
| 过期判定 | 记录自身 `expiresAt` 与运行时刻 | 输出最早到期时间；不缓存决定。 |

历史 `service.json` 与 `operations/access-handoff.json` 只用于辨认“不是当前入口”：前者指向已退役的直接 gateway 地址，后者是阶段一的访问交接。消费者没有使用它们，也没有把其中实例当作当前现场。公开 receipt 是当前地址的唯一入口。

## 假设与修正

1. **角色名不能假定为 gateway。** receipt 当前 delivery role 是 `evolution-target`；所有身份检查都以 receipt 为准。
2. **release metadata 不带 payload 摘要。** 需要单独读取 `/payload` 字节计算摘要；`observeRelease` 已提供该绑定，消费者没有自己重写发布取证。
3. **GIS 名称/坐标会移动。** `terrain-rev2`、`population`、`parcels` 和 bounds 全部来自本次 capabilities；实现中没有写死图层名、bbox 或 PNG 路径。文件名由层名派生并加序号，避免再次运行时碰撞。
4. **知识有到期时间。** 这次记录在运行后不到半小时到期；输出把到期时刻和 `applicationNow` 一并记录，不能用一次 `execute` 替代动作时重评。
5. **当前健康不等于需要修复。** 知识记录针对上游 502 类事件；本次 `/check` 为 200，因此包中明确写出 `not-needed-healthy`，并把“仅人工参考、不得自动修复”写入策略。
6. **输出目录必须干净。** 首次实现曾把地图字节写到进程工作目录的临时路径；代码审查时发现并在运行前修正，现在所有 PNG、XML、JSON 只写入调用方输出目录。`--output` 非空会被拒绝，避免旧文件混入。
7. **发布读取的字节长度。** 复用 `observeRelease` 后，payload 的 `byteLength` 需要从文本体换算；首次运行暴露了直接读取未定义字段导致 payload 检查误失败，已修正并复跑通过。

## 失败与拒绝行为（实际运行）

用临时 receipt/知识副本做只读探测，没有改活目标配置，也没有重启活服务：

- **网关不可达**（delivery URL 指向关闭端口，GIS 仍活）：总体 `ok:false`、`status:not-ready`；gateway 10 个检查失败；GIS 仍输出 16/16 checks 和 3 张地图；知识因缺少活 configuration model 记为 `context-unavailable`。已取得的 GIS 证据没有被总体失败抹掉（输出在 `temp/evolution-handoff-bad-final/`）。
- **期望不符**（活服务正常，但 receipt 期望 release-b/不匹配 payload）：总体 `ok:false`；release、diagnostics-release、payload 三项失败；GIS 与知识证据仍完整保留。
- **知识过期**（在 `temp/evolution-handoff-test-workspace` 的可丢弃副本中把一条适用记录改为已过期）：`clear-environment-restart-verify` 由 `execute` 变为 `refuse/EXPIRED`；总体仍可 `ready`，因为知识评估本身完成，包中不执行任何修复。活知识文件未改。
- **知识文件缺失**（指向无 `knowledge/` 的临时目录）：`knowledge.status:absent`，输出明确说明没有可复用记录、不得据此自动修复；网关/GIS 证据仍保留。
- **receipt 缺失**：只写 `failure.json`，返回 `ok:false`，不访问任何服务。
- **输出目录非空**：CLI 在写入前以 `OUTPUT_NOT_EMPTY` 退出 2，避免不同轮次混包。
- **活会话关闭后复探**（当前 receipt 的 `status` 已为 `closed`）：总体 `ok:false`；gateway 仅 1/12 检查通过、GIS 无可用 capabilities/地图、知识为 `context-unavailable`；仍写出 `handoff.json`/`handoff.md` 与 gateway/gis/knowledge 三组证据，但没有把关闭现场判成 ready（输出在 `temp/evolution-handoff-closed-final/`）。

## 接洽成本与人工关联

- 需要人工/调用方提供的只有 receipt 路径和空输出目录；知识文件位置由 receipt 的公开 `directory` 推导，不需要额外注册表。
- 网关与 GIS 的地址、角色、实例和期望发布都来自 receipt 或活响应；没有隐式重定向，也没有把旧 summary 当成当前现场。
- 知识评估需要三项上下文：当前 artifact SHA-256、活 configuration model、记录与证据文件。前两项由本次观测得到，第三项由已有 `evaluateKnowledgeFile` 复算；缺任一项会明确降级，不静默放行。
- 交接包区分“通用刷新”和“逐设施失败”：总体不 ready 时仍保留另一设施已取得的证据，并把失败检查逐条写入 `failures`。

## 新增成本与机制归因

这是单工作区、单消费者的组合，不是新的 Core、统一发现 API、注册表或插件机制。没有把本次成功归因于共享机制，也没有提炼通用发现协议。发现来源是阅读现有源码、对活服务的 GET 验证，以及 receipt `directory` 的目录枚举；单次成功不证明 Agent 可靠性。

### 功能成本

- 新增单文件约 1,629 行（含导出、CLI、采集、知识评估、报告和注释）；只有一个新实现文件。
- 运行时请求：delivery 5 次 GET（health、diagnostics、check、release metadata、payload）+ 末尾 health 复检 1 次；GIS health、GetCapabilities、每层 GetMap、末尾 health 共 6 次请求（本次 3 层）；知识侧读取本次 8 个候选 JSON，`evaluateKnowledgeFile` 对 5 条记录/3 个 procedure 重复读取记录与证据，未缓存决定。
- 输出：本次 9 个文件、57,722 字节，其中 3 张 PNG；`handoff.json` 记录逐文件摘要。

### 验证/证据成本

- 实际运行 7 类场景：正常、网关不可达、期望不符、知识过期副本、知识缺失、receipt 缺失、输出目录非空；另在 live session 关闭后复探一次。每次都要启动 CLI、等待请求、检查保留证据，不是一次调用即结束。
- 额外用现有 `decodePng` 复核 3 张 PNG 尺寸，并重算 `handoff.json` 中全部文件摘要；这些是独立的读取/校验步骤。
- 过期场景使用可丢弃副本，活知识文件未改。主线程另用独立输出目录做了自己的验收运行；本文件只记录本消费者的实际读取/运行事实，不代替该验收，也不把单次通过当作可靠性证明。

### 报告/输出成本

- `handoff.md` 由本次观测生成，不是复制旧 summary；同时维护 `handoff.json`、`gateway.json`、`gis.json`、`knowledge.json` 四组不同消费者需要的证据，存在结构/字段维护成本。
- 空输出目录约束、失败时保留部分设施证据、逐文件摘要清单，都是消费者承担的实际接洽成本，不能称为零成本。

### 接洽成本

- 需要一次显式接口通知给 IntegrationAcceptance（导出签名、CLI、结果字段、`ok` 语义、输出目录前置条件）；最终 runner/demo/session 的接入与断言仍由其完成。
- IntegrationAcceptance 已确认接口，并报告已将 `runAgentExtension` 接入最终 0→6 runner 与永久测试，且未要求本消费者改代码；其完整套件没有在本消费者侧运行，最终验收由 Main 负责。
- 需要知道公开 receipt 位置，并知道知识与证据位于 receipt `directory` 下的相对位置；若最终 runner 改变目录布局，需要重新对齐。
- 没有新增统一发现 API；本次代码不能证明共享机制收益，只证明这个消费者在本工作区的一次组合可运行。

## 改动范围

- 新增 `tests/14-workspace-evolution/agent-extension.js`：只读消费者与 CLI。
- 新增本文件：`documents/evidence/9-workspace-evolution/agent-discovery.md`。
- 未修改 `scenario.js`、`demo.test.js`、`session.js`、历史实验、packages、tests/lib 或任何运行中的目标配置/进程。
- 复用了 `wms-client.js`、`png-codec.js`、`knowledge.js` 与 `@locus/deployment-audit`；没有重写 WMS/PNG/发布取证。

最终六阶段 runner 和行为断言的接入由 IntegrationAcceptance 负责；本消费者只提供上述真实接口与输出。

## 事实分级

为避免把一次组合运行写成通用结论，本文件按来源分级：

- **源码/接口事实**：`session.js` 的 receipt 字段、`delivery.js` 的网关端点与判定、`wms-client.js` 的 WMS 解析/地图、`knowledge.js` 的评估语义、`@locus/deployment-audit` 的 release 观察。它们说明“接口如何定义”，不等同于当前运行状态。
- **活服务观测事实**：01:08:52Z 的快照，包括 receipt 当时 `running`、gateway 12/12、release/payload 摘要、GIS 三层与三张 PNG、知识三 procedure 决定、记录最早到期时间。它们是点时间读数，不是持续在线证明；01:09:20.909Z 会话已通过 stdin-exit 关闭，资源标记均为已关闭。
- **失败/拒绝实测**：网关不可达、期望不符、知识过期副本、知识缺失、receipt 缺失、输出目录非空、关闭后复探。这些是实际运行观察，说明本消费者在这些输入下的行为，不说明其他环境中必然相同。
- **外部验收事实**：父级在冻结前做了独立的分段验收，并使用独立输出目录；IntegrationAcceptance 确认了接口并报告最终 runner/永久测试已接入，但未在本消费者侧运行完整套件。本文件不复制其结论，也不把这些验收当作本消费者自证。六阶段最终 runner 与行为断言由父级/IntegrationAcceptance 负责。
- **未证明/推断**：Agent 在多次或未知环境中的可靠性、生产/多机/TLS/认证能力、共享发现机制收益、统一发现 API 的必要性。均未由本次单工作区、单消费者运行证明；不能归功于新 Core 或统一发现 API。

## 限制

- 这是单次本机回环运行，不证明 Agent 在多次/未知环境中的可靠性，也不等于生产、多机、TLS、认证或完整 OGC 验证。
- 交接包是点时间快照；运行末尾会再读一次网关/GIS health，缩小但不能消除采集与交接之间的变化窗口。
- 知识的 status 是作者声明，证据哈希只绑定字节，不认证语义真伪；记录与证据仍是被信任输入。
- `execute` 只是人工动作的适用性参考，不授权自动修复；包本身始终不写配置、不重启、不部署。
- 地图是诊断用小图，不是制图产品或业务图层验收。
