---
name: create-control-plane
description: "创建或更新项目控制平面（cp）文档。用于用户要求建立 control plane/控制平面/cp、为某个模块或任务创建 cp、项目缺少 cp-meta 时初始化 cp-meta、或需要按用户目标生成 cp-*.md；若用户表述的需求与代码事实或边界不一致，必须先和用户探讨再固化控制平面。"
---

# Create Control Plane

## 工作流

1. 先定位项目根或用户指定目录；存在“当前项目登记”时优先使用登记入口，否则未指定时默认使用当前项目根。控制平面与同 scope CPM 统一建立在 `.cp/` 下；`.agents/` 只承载 skills 等 agent 配套资产。
2. 检查 `.cp/` 是否已有 `cp-meta.md`：
   - 已有：读取并遵循它。
   - 没有：从本 skill 的 `assets/cp-meta-template.md` 复制一份到 `.cp/`，并按项目需要做最小命名调整。
3. 检查 `.cp/` 是否已有同 scope 的 `cpm-<scope>.md`；它是 `cp-<scope>.md` 的可复用记忆文件，存在时必须读取，但不得用它替代 CP 的活跃任务和高频规则。
4. 冻结新 cp 的最小边界：控制对象、入口点、直接调用方、当前任务要暴露的最小公共 API。
5. 对照代码事实验证用户描述；若需求、代码现状或边界无法笃定一致，先向用户提出具体问题，不要把猜测写入 cp。
6. 创建或更新 `cp-<scope>.md`，固定结构为：
   - `Control Plane Role`
   - `Meta Reference`
   - `Scope`
   - `Core Rules`
   - `Task Board`
7. 固定结构区的表达形式按清晰度动态选择：
   - `Task Board` 可按任务复杂度拆小章节、分层 checkbox、列表或表格，目标是清晰区分当前队列、暂缓项、验收状态和必要上下文。
   - `Core Rules` 可按规则类型拆小章节、分级列表或表格，目标是以尽可能少但合理的文字配置给规则。
   - `Meta Reference`、`Scope` 保持简洁，不拆章节，最多使用分级列表。
   - `Control Plane Role` 优先几个自然段；必要时可用短列表或小表格辅助说明，但不要展开成设计文档。
8. `Task Board` 和其后续内容属于动态任务区，可随着执行随时按需更新、新增章节或删除过时明细；动态章节不设固定模板，可比固定结构区更详细、更灵活，但仍以清晰、必要、易于 agent 和人理解为准。
9. 若产生可复用结论，写入同目录同 scope 的 `cpm-<scope>.md`；若只是一次性计划、临时 TODO 或会随代码变化的现状事实，不写入 CPM。

## 写作约束

- `Core Rules` 可包含调用顺序、边界冻结、验证、暂停询问、CPM 沉淀等操作规则。
- `Core Rules` 和 `Task Board` 不强制单一格式；可用小章节、分级列表、表格或 checkbox，只要更清晰、更少歧义且不过度扩写。
- `Task Board` 主要使用 checkbox；复杂任务允许树状 checkbox、状态分组或表格；任务项不添加日期或时间戳前缀。
- `Task Board` 及其后续动态章节可以随着执行视情况随时更新，不需要等阶段结束；动态章节可承载设计草案、阶段记录、临时决策和下一步执行输入。
- 已完成阶段若不再承载下一阶段必要上下文，不保留归档 checkbox；直接删除对应任务项和 `Task Board` 后相关动态章节。
- 不保留固定 `Current State`、`Boundary Freeze`、`Pause Conditions`、`Operating Rules` 章节。
- 不把用户愿望直接当成代码事实；控制平面应控制 agent 行动，而不是替代实现设计。
- 新 cp 文件名使用 `cp-*.md`，命名短、低噪声、能表达控制对象。
- CP 的记忆文件使用同目录 `cpm-*.md`，scope 必须与 CP 一致，例如 `cp-scene.md` 对应 `cpm-scene.md`。

## 模板

- 初始化元控制平面时使用：`assets/cp-meta-template.md`。
