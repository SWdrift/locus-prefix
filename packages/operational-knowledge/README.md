# @locus/operational-knowledge

有边界的操作知识笔记本：**一条发现只有在其证据字节和适用条件都能被重新验证时才可复用。** 存储是单个 Markdown 文档，读取时重新校验；不做通用知识图、自动推理、LLM 判断或语义真值认证，也不替调用方执行文档里的步骤。

完整使用闭环可在仓库根目录执行 `pnpm demo:operations`；输出目录中可查看真实写入的 `knowledge/runbook.md`。[全流程结论](../../documents/conclusions/6-operations-truth-loop.md)与[历史快照](../../documents/evidence/6-operations-loop/knowledge/runbook.md)展示原错误判断、干预证据和第二次使用。

## API

```js
import { appendFinding, findApplicableFindings } from '@locus/operational-knowledge';

const stored = await appendFinding({
  file: 'temp/<run>/knowledge/runbook.md',
  evidenceRoot: 'temp/<run>',
  finding: {
    id: 'gateway-check-502',
    originalClaim: '原判断：/check 失败时修改 config.json 的 upstreamUrl。',
    correction: 'environment.json 的 UPSTREAM_URL 在启动时覆盖 config.json；先确认有效上游来源。',
    steps: ['inspect-effective-configuration', 'clear-environment-override', 'restart-instance'],
    conditions: {
      artifactSha256: '<64 位十六进制制品 SHA-256>',
      configModel: 'environment-over-file-at-startup-v1',
    },
    evidence: [
      { path: 'evidence/incident.json', sha256: '<64 位十六进制文件 SHA-256>' },
    ],
    // expiresAt: 1_800_000_000_000,
  },
  // now: 1_700_000_000_000,
});

const applicable = await findApplicableFindings({
  file: 'temp/<run>/knowledge/runbook.md',
  evidenceRoot: 'temp/<run>',
  context: {
    artifactSha256: '<当前制品 SHA-256>',
    configModel: 'environment-over-file-at-startup-v1',
  },
  // now: 1_700_000_000_000,
});
```

### `appendFinding({file, evidenceRoot, finding, now?})`

- `file` 是 Markdown 文档路径（父目录必须已存在；文档本身不存在时会创建）；`evidenceRoot` 是证据目录。`finding.evidence[].path` 必须相对 `evidenceRoot`。
- 先校验整条 finding 和全部证据：路径必须是相对路径、不能含 `..`、解析符号链接后仍须位于 `evidenceRoot` 内，且必须是常规文件；实际文件字节的 SHA-256 必须等于记录值。任何失败都会抛出错误，**不会创建或改写文档**。证据相关错误带 `code`：`EVIDENCE_PATH`、`EVIDENCE_MISSING`、`EVIDENCE_OUTSIDE_ROOT`、`EVIDENCE_NOT_FILE`、`EVIDENCE_HASH_MISMATCH`、`EVIDENCE_ROOT_MISSING`、`EVIDENCE_ROOT_NOT_DIRECTORY`；finding/context 形状错误是 `TypeError`。
- 通过后追加一个人类可读章节（原始断言、修正、步骤、条件、证据、时间）和一个 `operational-finding` fenced JSON 记录。已有手写内容和之前的记录按原字节保留；人读部分的证据链接按**文档所在目录**生成（例如 `../evidence/incident.json`），记录里的 `path` 仍相对 `evidenceRoot`。
- 每次追加表示记录者在条件内修正原断言；可读章节明确标记原判断不再作为有效规则。这是作者判断，不是由哈希校验自动推出的语义真值。
- 写入通过在文档同目录创建临时文件并 `rename` 完成；不会留下半截文档。返回实际写入的记录，额外带有 `recordedAt`（毫秒）。重复 `id` 不会被拒绝，也不会覆盖旧记录。

### `findApplicableFindings({file, evidenceRoot, context, now?})`

只返回同时满足以下条件的记录，按文档顺序：

1. 记录可完整解析且字段受支持；`conditions.artifactSha256` 与 `conditions.configModel` 必须都明确存在并与 `context` 完全相等。缺少条件、使用通配符或未知字段的记录不是全局规则，会被跳过。
2. `expiresAt` 未声明，或 `now < expiresAt`。`expiresAt`/`now` 都是毫秒时间戳。
3. 每个证据路径仍在 `evidenceRoot` 内、仍是常规文件，且当前字节哈希仍等于记录值。

格式损坏、证据缺失/被改、条件不匹配或已过期的记录**整条跳过**，不会被部分采用，也不会影响同一文档中的其他有效记录。返回值只包含有效记录；本包不返回跳过原因。需要诊断时直接读取 Markdown 并人工核对。`evidenceRoot` 可用而 `file` 不存在时返回空数组；`evidenceRoot` 不存在或不是目录时抛出错误，因为此时无法验证任何记录。

## Markdown 存储

每条约定的机读部分是：

````markdown
```operational-finding
{
  "id": "gateway-check-502",
  "originalClaim": "…",
  "correction": "…",
  "steps": ["inspect-effective-configuration"],
  "conditions": {
    "artifactSha256": "…",
    "configModel": "environment-over-file-at-startup-v1"
  },
  "evidence": [{ "path": "evidence/incident.json", "sha256": "…" }],
  "recordedAt": 1700000000000
}
```
````

人类可读章节由本包生成，不应被当成第二份可编辑真相；真正参与匹配的只有 fenced JSON。手写的前言、旧断言和旧记录不会被覆写或删除。若手动改动 JSON 使其无法解析，记录会停止生效，而不是被部分解释。

## 已知限制

- 哈希只证明“检查时这些字节与记录绑定”，不证明证据足以推出修正，也不证明记录语义为真；没有签名、可信时间或来源认证。
- 证据验证与返回结果之间存在竞态（TOCTOU）。调用方读取返回值后，证据仍可能变化；需要更强保证时应重新调用或增加外部快照机制。
- 证据文件应视为不可变。覆盖引用中的证据会让旧记录失效；若之后又恢复为完全相同的字节，旧记录会再次通过哈希校验（字节绑定不是历史绑定）。
- 将证据放入Git时要明确字节保留策略。自动换行转换会正确地触发哈希失效，不能通过忽略空白来绕过。本仓库对 `documents/evidence/**` 设置 `-text`；完整演示实际提交并克隆后再读取知识。
- 没有跨进程锁。两个并发 `appendFinding` 可能发生最后写入者覆盖（丢失其中一条追加），尽管任意单次写入都是原子替换，不会产生半截文件。
- `artifactSha256` 和 `configModel` 由调用方提供，本包不推导当前环境，不匹配版本区间，不做通配或模糊匹配，也不在多个记录之间推理冲突。
- 不执行 `steps` 中的任何内容；步骤只是供调用方/人工选择的允许操作标识或说明。
