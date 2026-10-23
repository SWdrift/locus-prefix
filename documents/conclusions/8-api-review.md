---
name: API实验的证据收窄与下一轮决策边界
summary: 实验13验证了局部调用行为而非等价职责的端到端比较；身份相等不证明观测当前有效，冲突标签未阻止动作，暂不稳定新增API。
commit: "8-api-review"
experiments:
  - 13-api-expression
scope:
  - 对结论7的独立批判复盘与历史关联
  - 必要性、最小性、封装、组合、演化与负向知识的证据边界
  - 保留、简化、待验证方向及下一轮进入条件
---

# API实验的证据收窄与下一轮决策边界

`commit` 引用包含本文件及历史限定说明的标签 `8-api-review`。本轮为既有实验的事实审查，不修改实现，不新增实验目录或永久测试；补充探针直接调用实验13的现有函数，不启动生产设施。

关联[案例1](../cases/1-heterogeneous-engineering-workspace.md)、[研究记录](../api-expression-study.md)及[结论7](7-api-expression.md)。这次修正延续[结论3](3-operational-experiments.md)“正确性不等于工程价值”的限定；不静默改写过去，也不把审查建议描述成已完成的实现。

## 对结论7的明确修正

| 原判断 | 修正与依据 | 影响 |
| --- | --- | --- |
| “实验明确转人工审查，不自动选择新记录” | [scenario.js](../../tests/13-api-expression/scenario.js)先完成修复，再追加相反建议；`manual-review`仅写入summary。没有冲突后的动作选择、暂停或人工审查 | 只能声称识别了预设步骤标签冲突，不能声称冲突已经改变行动 |
| “原生基线维护负担最低”及“删除候选层，核心任务仍成立” | 当前native路径能独立消费现场，但没有承担B的全部检查；未做等价职责成本比较或独立删层实验 | 撤回成本排名；保留“尚无证据支持新增通用Core”的暂缓决策 |
| “知识复用”的方案收益 | 修复门禁用固定procedure ID，证据与现场上下文来自native观测；操作由共同脚本执行，不是四个消费者分别选择 | 知识存在性确实控制了共同脚本是否继续，但不能计为A/B/C各自的端到端能力 |
| “制品/模型变化后不复用” | 运行的是改变查询参数后返回空数组；没有实际更换制品或服务配置模型后再次进入修复选择 | 限定为查询性质，不声称演化后的操作安全已经验证 |
| B的“当前证据” | `requireCurrent`只比较status、实例ID和连接标签；同身份状态/实现变化仍接受旧结果 | 身份检查有局部价值，不能作为通用有效性契约公开 |

结论7原文及标签保留为历史。其“已验证事实”中的说明发现来自当时直接smoke，不全部有永久断言；85项通过是全仓总数，实验13新增一个综合测试，不是85个独立API比较。

## 事实、推断与假设

### 已有测试和运行观察

- [demo.test.js](../../tests/13-api-expression/demo.test.js)覆盖共同现场下的502、改文件仍502、重启200，特定身份拒绝、缓存方法行为、调用期间替换、目标停止和知识查询结果。
- 四路径读同一阶段现场，但设施适配、清除覆盖、重启和替换均由共同脚本提供。角色API与直接HTTP是同一网关模型的两种访问封装，不代表第二种独立协议或工程任务。
- 本次直接运行补充探针：同一subject的旧200可被复用，而新观测已502；修改公开event的subject后，旧观测可被重新标记归属；身份不符被拒绝时，失败event没有保留实际observation。
- 缺少实例身份的subject和响应在当前实现中可以通过，因为两个undefined相等。这是实际输入边界，不意味着下一步应增加通用Schema。
- 依赖`this`的普通方法在native裸函数调用下实际失败，B/C保留receiver；A使用同样裸函数方式的风险属于实现推断，未单独运行。这说明比较混入了调用约定差异，不证明B/C架构更优。
- 普通对象上的闭包与C都能使已保存的方法从A跟随到B；普通对象还可直接枚举inspect。因此C在本实验的核心行为不需要Proxy。

上述补充探针不是永久回归保护，不证明真实远端、跨进程历史或不可信来源行为。以下为可直接运行的代表性反例，保持实现不变：

```js
// 在工作区以 node --input-type=module 执行。
import assert from 'node:assert/strict';
import { witnessedConsumer, projectedConsumer } from './tests/13-api-expression/consumers.js';
const release = { expected: {}, artifact: {} };
const subject = { instanceId: 'a', connection: 'http' };
let status = 200;
const connection = {
  subject,
  inspect: async () => ({ instanceId: 'a', request: { status }, runtime: {} }),
};
const consumer = witnessedConsumer(connection, release);
await consumer.run();
const old = consumer.events[0];
status = 502;
assert.equal(consumer.reuse(old).request.status, 200);
assert.equal((await consumer.run()).observation.request.status, 502);
consumer.replace({ ...connection, subject: { ...subject, instanceId: 'b' } });
old.subject.instanceId = 'b';
assert.equal(consumer.reuse(old).instanceId, 'a');

const target = id => ({
  subject: { instanceId: id, connection: 'http' },
  inspect: async () => ({ instanceId: id, request: { status: 200 }, runtime: {} }),
});
let current = target('a');
const plain = { inspect: (...args) => current.inspect(...args) };
const saved = plain.inspect;
const proxy = projectedConsumer(current, release);
assert.equal((await saved()).instanceId, 'a');
current = target('b');
proxy.replace(current);
assert.equal((await saved()).instanceId, 'b');
assert.equal((await proxy.cached()).instanceId, 'b');
assert.deepEqual(Object.keys(plain), ['inspect']);
console.log('旧状态仍可复用、历史可被重标记、闭包可替代动态投影');
```

### 实现推断，尚非端到端行为证明

- A/B/C没有各自执行设施发现、知识选择和干预；共同脚本提供这些能力。native基线还复用了已有发布审计和知识包，不能泛化成“不使用任何Locus成果”。
- `originalClaim/correction`未参与动作选择；失效查询和冲突均发生在修复之后。删除负向叙述不会改变当前硬编码动作路径。不能从保存失败记录推断策略已经改善。
- B/C的公开可变events使消费者依赖数组顺序及内部信封；B的失败记录只留错误文本，丢失实际响应和结构化错误码，不足以完整解释错目标现场。
- A说明缺失和C不可枚举是当前实现行为，不是原生模块或Proxy的必然限制。没有Agent消费证据。
- 知识包的条件白名单固定为artifactSha256/configModel，适合当前领域；扩大为通用知识核心会使领域模型泄漏到公共机制。

### 仍是设计假设

少量说明足以帮助Agent；相同观测边界会跨独立任务重复；共享函数能降低长期成本；身份与条件核对能阻止实际危险动作。这些都不能由测试数量或命名推出。

## 九项复盘与最小处理

| 检查项 | 判断与最小处理 |
| --- | --- |
| 必要性 | 内容、配置、可用性、历史依据的区别是真问题；不因此要求统一任务、对象登记或动态投影 |
| 最小性 | 普通导出说明、闭包和局部核对足以表达当前需要；不把发现、替换、记录和复用打包成默认Runtime |
| 封装性 | 不将可变events数组作为证据公共接口，不要求消费者知道内部事件排列；是否需要其他历史接口仍待需求证明 |
| 可理解性 | 固定引用与动态引用必须由消费者明确选择；撤回requireCurrent的通用有效性含义 |
| 组合性 | 保留accept与窄适配边界；不把“脚本预先完成适配后能消费”当作新能力自主接入证明 |
| 演化性 | 身份不等于状态/实现版本；同身份变化仍需新观测。不靠新增一个人工revision字段预先解决所有变化 |
| 负向知识 | 保存和条件筛选已成立，冲突阻止动作尚未成立；不要把标签当控制流程 |
| 替代方案 | ESM、普通函数/对象、Git、文档及已有工具优先；尚未完成完全无Locus基线或等价成本排名 |
| 历史教训 | 不复制Scope/Registry，不把字段名和测试覆盖意图当保证；不为将来预建版本图、知识引擎或工作流 |

历史依据：只读查阅了相邻Locus Scope的公开API参考及Locus Link的《旧项目调研》《项目方向》《最小Demo计划》。Link调研记录了自建Scope/Registry的负担、Probe不证明连接可用、ContextFingerprint未覆盖完整现场等问题；其[公开归档](https://github.com/SWdrift/locus-link-archive)用于追溯旧材料。历史材料本身是静态审查，不是本轮对旧系统的运行证明，也不证明图模型普遍错误。当前相似风险是用“current”“转人工审查”等名称暗示强于实现的保证。

## 决定：保留、删除或简化、待验证

**保留**：原生函数组合、窄适配、独立领域取证/判定、明确的局部身份核对、可复现反例及失败证据。历史实验不删除，包暂保持现状；保留实现不等于认定通用公共价值已成立。

**删除或简化的方向**：未来消费路径不依赖C的Proxy、A的独立说明登记机制、B的通用reuse/requireCurrent契约或公开可变event数组；统一任务目录不是必经入口。本轮仅撤回推广与稳定建议，不实际删除代码或修改已提交实验。

**待验证**：失效/冲突是否改变动作、Agent实际收益、第二个独立任务是否出现同一小契约、等价职责的维护成本。暂不稳定A/B/C公开API，不为填补这些空白补建Core。

## 下一轮只验证一个问题

**把失效或相反证据放到动作选择之前，普通显式代码能否确实阻止不成立的旧方法，并在获得新证据后选择有依据的动作？**

进入条件与可观察结果：

1. 选择案例1中实际可检验的任务；先明确允许的动作、现场身份、输入证据与副作用，不预设共享机制。
2. 冲突/失效必须先于动作选择。结果应体现未执行、明确拒绝或取得额外证据后执行，不能只在summary写一个标签。
3. 有效证据与失效/相反证据改变时，比较实际动作及现场结果；不能只检查查询数组或固定procedure ID是否存在。
4. 保留原判断、反例、修正与条件；真实生产与受控替身分开说明。Agent收益只有实际接入才评价。
5. 原生显式代码是起点。若第二个独立情境重复出现相同小契约，再比较共享成本；没有重复收益就保留领域代码。

这是下一轮研究问题，不是已冻结设计，也不要求下一轮立即产生包、Core或稳定API。

## 本次文档验收

本文代表性反例已直接调用现有实现运行，断言通过、进程退出0；本次四份修改/新增文档的本地链接及结论必需front matter字段检查通过。仅文档变更，未重跑全套测试，不把结论7记录的85项通过当作本次新验收。
