# 服务A运行手册

## 初始判断（待验证）

健康检查和发布内容一致即代表端到端就绪；上游地址只由配置文件决定，修改文件会立即生效。

## Finding: startup-environment-shadowing

Recorded at: 2026-10-22T09:22:38.003Z

**原判断状态：在下述适用条件内已被修正，不再作为有效操作规则。**

这是记录者的判断；证据哈希绑定文件字节，不自动认证结论的语义。

**Original claim**

> 健康检查和发布内容一致即代表端到端就绪；上游地址只由配置文件决定，修改文件会立即生效。

**Correction**

> 发布字节一致不证明运行配置正确。环境覆盖优先于文件，且进程启动时加载；应检查有效配置与来源，清除错误覆盖后重启并重新验证请求。

**Steps**

1. inspect-effective-configuration
2. clear-environment-override
3. restart-instance
4. verify-request

**Conditions**

- artifact SHA-256: cd86f82e5e8ef789fd24576dcc58c3c3e3044692236a209e388570532f86a00a
- config model: environment-over-file-at-startup-v1
- expires at: 2026-10-22T10:22:38.003Z

**Evidence**

- [evidence/incident.json](../evidence/incident.json) (SHA-256 c01fb3cbd912ba4cf1929d37b8310758aca8bb0ea21c5cd0c2f42c772befeffc)
- [evidence/repair.json](../evidence/repair.json) (SHA-256 39c74eee0defcb06678ec81c661390e1acf669fb699cf79bd493f04213a8a613)

```operational-finding
{
  "id": "startup-environment-shadowing",
  "originalClaim": "健康检查和发布内容一致即代表端到端就绪；上游地址只由配置文件决定，修改文件会立即生效。",
  "correction": "发布字节一致不证明运行配置正确。环境覆盖优先于文件，且进程启动时加载；应检查有效配置与来源，清除错误覆盖后重启并重新验证请求。",
  "steps": [
    "inspect-effective-configuration",
    "clear-environment-override",
    "restart-instance",
    "verify-request"
  ],
  "conditions": {
    "artifactSha256": "cd86f82e5e8ef789fd24576dcc58c3c3e3044692236a209e388570532f86a00a",
    "configModel": "environment-over-file-at-startup-v1"
  },
  "evidence": [
    {
      "path": "evidence/incident.json",
      "sha256": "c01fb3cbd912ba4cf1929d37b8310758aca8bb0ea21c5cd0c2f42c772befeffc"
    },
    {
      "path": "evidence/repair.json",
      "sha256": "39c74eee0defcb06678ec81c661390e1acf669fb699cf79bd493f04213a8a613"
    }
  ],
  "expiresAt": 1792664558003,
  "recordedAt": 1792660958003
}
```
