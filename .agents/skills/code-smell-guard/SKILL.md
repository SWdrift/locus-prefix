---
name: code-smell-guard
description: "在代码生成、既有代码修改、代码审查、重构建议、重构前后检查时，主动预防和识别 Fowler/Beck 经典 Code Smells。用于判断当前改动是否引入或加重 Long Method、Duplicate Code、Feature Envy、Shotgun Surgery 等 22 种坏味道，并输出高置信风险、判断依据与最小修复建议；不用于机械消除所有坏味道。"
---

# Code Smell Guard

## 目标

帮助 agent 在写代码、改代码、评审代码时，把 Code Smell 当作诊断信号：只阻止或指出会降低可维护性、变更局部性、职责清晰度的高置信问题。来源口径采用 Martin Fowler/Kent Beck 的 Code Smell 概念与 Refactoring.Guru 对 22 项经典目录的整理。

## 使用流程

1. 先冻结上下文：语言/框架、当前调用方、入口点、测试形态、性能约束、迁移状态、项目规则。
2. 判断任务类型：新建模块、修改既有代码、代码审查、重构前检查、重构后回归检查。
3. 只扫描本次改动边界及直接调用链；除非证据不足，不做无边界全量重构建议。
4. 按 22 项 smell 查找“新增或加重”的问题，并过滤误报。
5. 输出高置信项：风险、判断依据、最小修复建议；低置信只作为开放问题或不报告。

## 输出约束

- 只报告高置信问题；不要把所有 smell 说成错误。
- 每项报告包含：`Smell`、`风险`、`依据`、`最小建议`。
- 优先小步重构：Extract Method、Extract Class、Move Method、Introduce Parameter Object、Replace Conditional with Polymorphism、Inline Class、Remove Dead Code、Rename、Pull Up/Push Down Method。
- 避免建议大规模重写、跨层重设计、公共 API 扩张，除非 smell 已造成明确变更成本。
- 代码审查时优先指出当前 change 引入或加重的 smell；历史问题只在阻塞当前正确性时提及。

## 误报控制

以下场景允许局部 smell，但需确认边界和理由：

- 测试代码：重复 setup、显式场景、长断言可能换取可读性。
- 脚手架/生成代码：遵循工具输出，不主动手改结构。
- 框架约定：生命周期函数、路由表、schema、配置对象可能天然集中。
- 性能关键路径：避免抽象造成分配、虚调用或热路径回归。
- 临时迁移代码：可接受桥接层，但必须有清晰删除条件或隔离边界。

## 22 项检查表

### Bloaters

- **Long Method**：方法过长，承担过多步骤或抽象层级。信号：滚动阅读、混合校验/转换/副作用/渲染；风险：难测试、难复用；例外：线性配置或测试场景；优先：Extract Method、Replace Temp with Query。
- **Large Class**：类过大，聚合过多职责、字段或方法。信号：字段按主题分组、方法只使用部分字段；风险：Divergent Change；例外：框架组件壳或聚合根；优先：Extract Class、Extract Superclass/Component。
- **Primitive Obsession**：过度使用原始类型表达领域概念。信号：多个 string/number 携带业务语义、重复校验；风险：非法状态扩散；例外：边界 DTO、性能热路径；优先：Value Object、Replace Type Code with Class。
- **Long Parameter List**：参数过多，调用者需要知道太多细节。信号：同组参数反复传递、布尔开关多；风险：调用错误、扩展困难；例外：稳定底层 API 或构造配置；优先：Introduce Parameter Object、Preserve Whole Object。
- **Data Clumps**：一组数据总是一起出现，暗示应抽象为对象。信号：相同字段组出现在多个函数/类；风险：不变量分散；例外：一次性解析结果；优先：Extract Class、Introduce Parameter Object。

### Object-Orientation Abusers

- **Switch Statements**：大量 switch/if 基于类型或状态分发行为。信号：新增类型需改多处分支；风险：Shotgun Surgery；例外：简单枚举映射、边界解析；优先：Replace Conditional with Polymorphism、Strategy、Map Dispatch。
- **Temporary Field**：字段只在少数场景临时有效。信号：字段可空且依赖调用顺序；风险：对象状态不稳定；例外：缓存且生命周期明确；优先：Extract Class、Move Field to local/result object。
- **Refused Bequest**：子类继承父类但拒绝或不适用其行为。信号：override 抛错、空实现、违反父类契约；风险：LSP 破坏；例外：框架受限适配；优先：Replace Inheritance with Delegation、Extract Interface。
- **Alternative Classes with Different Interfaces**：功能相似的类接口不同。信号：调用方写适配分支；风险：替换成本高；例外：外部库 API；优先：Rename Method、Extract Interface、Adapter。

### Change Preventers

- **Divergent Change**：一个类因多种不同原因被频繁修改。信号：业务、持久化、展示、协议逻辑混在一起；风险：改 A 影响 B；例外：小型协调器；优先：Extract Class、Move Method。
- **Shotgun Surgery**：一次变更需要修改许多分散位置。信号：新增字段/状态要改多层重复代码；风险：漏改；例外：显式注册表；优先：Move Method/Field、centralize policy、Introduce Facade。
- **Parallel Inheritance Hierarchies**：新增一个子类时必须在另一个继承树同步新增。信号：AThing/BThing 成对增长；风险：扩展僵硬；例外：生成代码；优先：Move Method、Collapse Hierarchy、composition。

### Dispensables

- **Comments**：注释弥补代码表达力不足。信号：解释“代码在做什么”而非背景约束；风险：注释漂移；例外：复杂约束、协议、性能原因；优先：Rename、Extract Method、Replace Magic Number with Symbolic Constant。
- **Duplicate Code**：相同或近似逻辑重复。信号：复制分支、重复校验/映射；风险：行为分叉；例外：测试场景独立性、短期迁移；优先：Extract Method、Pull Up Method、Form Template Method。
- **Lazy Class**：类价值过低。信号：只包一层、没有稳定职责；风险：导航成本；例外：边界类型、框架要求；优先：Inline Class、Collapse Hierarchy。
- **Data Class**：类只保存数据，缺少合理行为。信号：外部大量操作其字段；风险：Feature Envy；例外：DTO、schema、序列化结构；优先：Move Method、Encapsulate Record。
- **Dead Code**：无用、不可达、废弃代码仍保留。信号：无调用、feature flag 永久关闭、注释掉的实现；风险：误用和维护噪音；例外：公开 API 兼容期；优先：Remove Dead Code。
- **Speculative Generality**：为假想未来过度抽象。信号：未使用 hook、泛型、配置、接口；风险：复杂度前置；例外：已明确 roadmap 或插件边界；优先：Collapse Hierarchy、Inline Class/Method、Remove Parameter。

### Couplers

- **Feature Envy**：方法过度访问其他对象数据。信号：多次 `other.get...` 或读取外部结构后计算；风险：行为放错位置；例外：格式化器、报表、mapper；优先：Move Method、Extract Method。
- **Inappropriate Intimacy**：类之间知道彼此过多内部细节。信号：访问内部状态、双向依赖、友元式调用；风险：耦合扩散；例外：紧密协作的内部模块；优先：Move Method/Field、Hide Delegate、Extract Interface。
- **Message Chains**：调用链过长，调用者依赖深层对象结构。信号：`a.b().c().d()`；风险：结构变化外泄；例外：流式 API、查询构建器；优先：Hide Delegate、Extract Method。
- **Middle Man**：中间类只转发调用。信号：多数方法一行委托；风险：无价值层级；例外：稳定边界、防腐层、权限/日志代理；优先：Remove Middle Man、Inline Class。

## 最终检查清单

- 职责：当前模块是否只有一个主要变化原因？
- 重复：重复逻辑是否会导致未来漏改？
- 抽象层级：同一函数/类内是否混合策略、流程、细节和副作用？
- 依赖方向：是否让高层知道低层内部结构？
- 变更局部性：新增一种状态/类型/字段是否只需改少数稳定入口？
- 领域概念表达：是否用明确类型表达不变量，而不是散落 primitive 和 fallback？
- 设计克制：新增抽象是否服务当前真实变化，而不是假想未来？
