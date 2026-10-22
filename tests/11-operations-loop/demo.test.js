import test from 'node:test';
import assert from 'node:assert/strict';
import { runOperationsScenario } from './scenario.js';

// Case 1: infrastructure/configuration/CI-CD/debug/evidence-bound document revision.
// Conclusion: documents/conclusions/6-operations-truth-loop.md.
test('a full delivery incident repairs effective configuration and revises reusable operational truth', { timeout: 120000 }, async () => {
  const result = await runOperationsScenario();
  const { incident, fixed, recurring, reusedRepair, summary, knowledge } = result;

  assert.equal(incident.health.status, 200);
  assert.equal(result.lineage.verdict, 'consistent');
  assert.equal(incident.request.status, 502);
  assert.equal(incident.configuration.source, 'environment');
  assert.notEqual(incident.configuration.effectiveUpstreamUrl, incident.configuration.fileUpstreamUrl);
  assert.equal(result.diagnosis.cause, 'environment-shadowing');

  assert.equal(fixed.beforeRestart.request.status, 502);
  assert.equal(fixed.afterRestart.request.status, 200);
  assert.equal(fixed.afterRestart.configuration.source, 'file');
  assert.equal(fixed.afterRestart.configuration.effectiveUpstreamUrl, fixed.afterRestart.configuration.fileUpstreamUrl);
  assert.equal(fixed.afterRestart.runtime.payloadSha256, result.artifact.payloadSha256);
  assert.notEqual(incident.instanceId, fixed.afterRestart.instanceId);
  assert.equal(incident.role, fixed.afterRestart.role);

  assert.ok(knowledge.afterMarkdown.includes('初始判断（待验证）'));
  assert.ok(knowledge.afterMarkdown.includes(knowledge.finding.originalClaim));
  assert.ok(knowledge.afterMarkdown.includes(knowledge.finding.correction));
  assert.notEqual(knowledge.beforeMarkdown, knowledge.afterMarkdown);
  assert.equal(knowledge.applicable[0].id, knowledge.finding.id);
  assert.deepEqual(knowledge.changedContext, []);
  assert.equal(knowledge.publication.byteIdentical, true);
  assert.equal(summary.knowledgeSurvivedGitCheckout, true);

  assert.equal(recurring.request.status, 502);
  assert.notEqual(recurring.role, incident.role);
  assert.equal(reusedRepair.afterRestart.request.status, 200);
  assert.equal(reusedRepair.afterRestart.runtime.payloadSha256, result.artifact.payloadSha256);
  assert.equal(summary.buildExecutions, 1);
  assert.equal(summary.activeBackendDebugProbes, 1);
  assert.equal(summary.knowledgeReused, true);
  assert.equal(summary.artifactsRetained, false);
  assert.ok(result.liveResources.every(resource => resource.state === 'running'));
  assert.ok(result.stoppedResources.every(resource => resource.state === 'stopped'));
  assert.equal(summary.resourcesStopped, true);
});
