/**
 * 实验 10：发布源码绑定与触发提交。
 *
 * 运行：`node --test tests/10-source-binding/demo.test.js`
 *
 * 场景脚本在仓库 temp 下建立真实 Git 仓库：触发提交 A，实际构建工作树停在 B。
 * health 与标签仍可能成功，但构建现场见证指向 B，评估必须 mismatch；
 * 从 A 的干净克隆重建后内容一致，评估 consistent。同一修正制品部署到
 * 新目标角色时重新通过 HTTP 观测 runtime，不复用之前的观测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceBindingScenario } from './scenario.js';

function check(assessment, id) {
  const found = assessment.checks.find(item => item.id === id);
  assert.ok(found, `assessment must include the ${id} check`);
  return found;
}

test('a fixed worktree build can pass health and labels while assessment is mismatched', { timeout: 120000 }, async () => {
  const result = await runSourceBindingScenario();
  const { wrong, corrected, redeploy, source } = result;

  assert.equal(source.revisions.trigger, wrong.expected.sourceRevision);
  assert.notEqual(source.revisions.trigger, source.revisions.fixedWorktree);
  assert.deepEqual(source.probes.cleanFixedWorktree, {
    revision: source.revisions.fixedWorktree,
    dirty: false,
  });
  assert.deepEqual(source.probes.dirtyWorktree, {
    revision: source.revisions.fixedWorktree,
    dirty: true,
  });
  assert.deepEqual(source.probes.cleanCheckout, {
    revision: source.revisions.trigger,
    dirty: false,
  });

  assert.equal(wrong.observation.healthStatus, 200);
  assert.equal(wrong.runtime.release, 'release-a');
  assert.equal(wrong.runtime.sourceRevision, source.revisions.trigger);
  assert.equal(wrong.artifact.release, 'release-a');
  assert.equal(wrong.artifact.sourceRevision, source.revisions.trigger);
  assert.equal(wrong.artifact.buildSource.revision, source.revisions.fixedWorktree);
  assert.equal(wrong.artifact.buildSource.dirty, false);
  assert.equal(wrong.observation.payloadText, source.payloads.fixedWorktree);
  assert.equal(wrong.runtime.payloadSha256, wrong.artifact.payloadSha256);
  assert.equal(wrong.assessment.verdict, 'mismatch');
  assert.equal(check(wrong.assessment, 'release-label').status, 'pass');
  assert.equal(check(wrong.assessment, 'declared-source').status, 'pass');
  assert.equal(check(wrong.assessment, 'build-source').status, 'fail');
  assert.equal(check(wrong.assessment, 'payload-binding').status, 'pass');

  assert.equal(corrected.observation.healthStatus, 200);
  assert.equal(corrected.observation.declaredSourceRevision, corrected.expected.sourceRevision);
  assert.equal(corrected.artifact.sourceRevision, corrected.expected.sourceRevision);
  assert.equal(corrected.artifact.buildSource.revision, corrected.expected.sourceRevision);
  assert.equal(corrected.artifact.buildSource.dirty, false);
  assert.equal(corrected.observation.payloadText, source.payloads.trigger);
  assert.equal(corrected.runtime.payloadSha256, corrected.artifact.payloadSha256);
  assert.notEqual(wrong.artifact.payloadSha256, corrected.artifact.payloadSha256);
  assert.equal(corrected.assessment.verdict, 'consistent');
  for (const id of ['release-label', 'declared-source', 'build-source', 'payload-binding']) {
    assert.equal(check(corrected.assessment, id).status, 'pass', `${id} must pass after correction`);
  }

  assert.equal(redeploy.target, 'target-c');
  assert.equal(redeploy.artifact, corrected.artifact);
  assert.notEqual(redeploy.runtime, corrected.runtime);
  assert.equal(redeploy.observation.target, 'target-c');
  assert.equal(redeploy.observation.declaredSourceRevision, corrected.expected.sourceRevision);
  assert.equal(redeploy.observation.payloadText, source.payloads.trigger);
  assert.equal(redeploy.runtime.payloadSha256, corrected.artifact.payloadSha256);
  assert.equal(redeploy.assessment.verdict, 'consistent');
});
