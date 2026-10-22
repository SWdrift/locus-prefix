# @locus/deployment-audit

回答一个有边界的 CI/CD 问题：**标签、构建源码见证、制品与运行内容是否有足够证据一致？** 不启动服务、不发布、不补偿，不把健康检查或事件 SHA 当作完整溯源。

## 可复现的完整任务

在仓库根目录执行：

```sh
pnpm demo:release
```

演示实际创建临时 Git 仓库和提交 A/B，复制制品，启动并读取本机 HTTP 目标：

1. 错误路径：事件触发 A，但固定工作树已到 B；产物及运行端仍声明 A，健康检查也成功。评估为 `mismatch`。
2. 修正路径：干净检出 A，再生成并交付制品；重新读取运行字节，评估为 `consistent`。
3. 将同一修正制品交付另一个本机目标角色，重新观测，不沿用旧结果。

所有目录位于工作区 `temp/`，结束时清理。匿名角色不是三台物理机器；这里的构建是小文件的确定性复制，不等同于真实项目的完整编译或跨平台构建。

## 最小 API

```js
import { assessRelease } from '@locus/deployment-audit';

const report = assessRelease({
  expected: { release: 'release-a', sourceRevision: 'revision-a' },
  runtime: { release: 'release-a', sourceRevision: 'revision-a' },
});
// report.verdict === 'incomplete'：标签相同，但没有制品、构建见证及内容绑定。
```

- `assessRelease({expected, artifact, runtime})`：纯函数，独立检查发布标签、声明提交、实际构建 revision/dirty、制品与运行 payload SHA-256。缺失或非法证据为 `unknown`；有一项确定冲突即 `mismatch`，否则有未知为 `incomplete`，全部通过才为 `consistent`。每项附原因和人工下一步。
- `readGitSource(root)`：真实读取 Git HEAD 与工作树状态，返回 `{revision,dirty}`；未跟踪文件也计入。不是从期望提交复制的标签。
- `observeRelease({metadataUrl,payloadUrl?,timeoutMs?,maxBytes?})`：有限时长、有限体积的只读 GET；返回独立的 metadata/payload 观测及解析后的 runtime。payload hash 来自完整响应的原始字节（HTTP传输解压后），不采用元数据中自报的 hash；中断或截断不产生完整 digest。不跟随重定向，不跳过 TLS 验证，不重试。
- `createDeploymentTasks()`：供现有任务目录使用，提供 `deployment.audit`。

制品证据形状：

```js
{
  release: 'release-a',
  sourceRevision: 'revision-a', // 声明
  payloadSha256: 'a'.repeat(64), // 必须由实际制品内容计算，示例值不是现场证据
  buildSource: { revision: 'revision-a', dirty: false }, // 构建现场采集
}
```

## 接入已有工作台

```sh
pnpm locus show deployment.audit
```

`run deployment.audit` 需要 `--grant deployment:inspect --allow network:read`。输入为 expected、metadataUrl，以及可选 artifact/payloadUrl。URI 使用调用方自己的受权目标，不把真实项目名、地址、令牌、私有提交或脱敏映射写入公开配置。

CLI 外层 `status: succeeded` 只表示审计完成。发布判断在 `value.assessment.verdict`；**不能把审计进程退出 0 当作允许发布**。本包不自动将判断接入任何真实部署门禁。

## 四项契约之外仍未知

- 调用方负责见证可信；本包没有签名、来源认证或证明 hash 确由制品生成的密码学机制。
- Git clean 不覆盖被忽略文件、环境变量、工具链、依赖、子模块完整性或构建期间的变化；它不是可重复构建保证。
- 这里只绑定一个指定 payload，不是整个制品、全部文件或实际进程所加载代码的证明。相同字节也不等于相同配置和业务行为。
- 元数据和 payload 是先后请求，不是原子快照。部署若在两次请求之间变化，需要更强的版本固定读取机制；本轮不实现。
- 网络成功不证明连到了意图中的机器；换目标必须重新观测，凭据及网络视角另行确认。

[对应实验结论](../../documents/conclusions/5-release-lineage.md)区分实际只读调查、匿名摘要和受控复现，不把后者冒充现场故障。
