---
name: update-git
description: "更新当前项目 Git 状态并向当前分支提交本次会话或用户指定任务涉及的更改。用于用户要求提交、commit、保存当前改动、更新 git 状态，或明确调用 $update-git 时；提交信息必须使用 feat/fix/refactor/perf/docs/agents/chore 加简短中文描述。"
---

# Update Git

## 工作流

1. 先确认当前分支和工作区状态：
   - 使用 `git branch --show-current` 确认当前分支。
   - 使用 `git status --short` 查看待提交文件。
2. 检查改动内容：
   - 使用 `git diff --stat` 获取改动范围。
   - 必要时读取关键 diff，确认提交描述能准确覆盖本次改动。
   - 区分本次会话、用户指定任务涉及的更改与工作区中已有的其他更改。
3. 暂存并提交：
   - 只提交本次会话或用户指定任务中涉及的更改。
   - 不暂存、不提交与本次会话或用户指定任务无关的既有改动。
   - 提交到当前分支，不切换分支。
   - 提交信息格式固定为：`feat/fix/refactor/perf/docs/agents/chore: <简短中文描述>`。
4. 提交后再次运行 `git status --short`，确认是否仍有未提交改动。

## 提交信息规则

- 类型只能使用 `feat`、`fix`、`refactor`、`perf`、`docs`、`agents`、`chore` 之一。
- 冒号后必须有一个空格。
- 描述必须使用简短中文，直接概括本次提交内容。
- 不使用英文长句、句号、任务编号或多行 commit message。

## 类型选择

- `feat`：新增用户可见能力或功能。
- `docs`：文档、说明、ADR、memory、控制平面等文档类改动。
- `agents`：agent 规则、skill、提示词、自动化协作约束。
- `chore`：工具配置、维护性改动、非功能性整理。
- `fix`：修复缺陷或错误行为。
- `refactor`：不改变外部行为的代码结构调整。
- `perf`：性能优化。

## 禁止事项

- 不自动执行 `git push`。
- 不使用 `git reset`、`git checkout --`、`git clean` 等会丢弃改动的命令。
- 不修改用户未要求处理的文件来凑提交。
- 不把工作区中无关的历史改动、临时文件或其他任务改动混入提交。
