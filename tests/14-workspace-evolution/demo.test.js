import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkspaceEvolution } from './scenario.js';
import { createWorkspace } from './fixture.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Case: continuous evolution of a heterogeneous engineering workspace.
// The permanent test asserts the consumer-visible behavior and boundaries of
// stages zero through six, not source text or incidental field names.
test('the workspace evolves through six stages with explicit consumer behavior', { timeout: 360000 }, async () => {
  await mkdir(join(ROOT, 'temp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, 'temp', 'evolution-acceptance-'));

  try {
    const result = await runWorkspaceEvolution({ directory });

    assert.equal(result.accepted, true);
    assert.deepEqual(
      result.stages.map(record => ({ stage: record.stage, status: record.status })),
      [0, 1, 2, 3, 4, 5, 6].map(stage => ({ stage, status: 'completed' })),
    );
    assert.equal(result.resources.closed, true);
    assert.equal(result.resources.gisClosed, true);
    assert.equal(result.resources.workspaceClosed, true);

    // Stage zero: the native consumers work against the captured workspace.
    assert.equal(result.initial.overview.ok, true);
    assert.equal(result.initial.overview.value.role, result.initial.gateway.role);
    assert.equal(result.initial.overview.value.instanceId, result.initial.gateway.instanceId);
    assert.equal(result.initial.verify.value.requestStatus, 200);
    assert.equal(result.initial.source.value.dirty, false);
    assert.equal(result.initial.source.value.syntax, 'valid');

    // Stage one: the old access path is dead; the handoff consumer observes
    // the restarted instance and still completes an HTTP request.
    assert.equal(result.access.broken.oldConsumers.overview.ok, false);
    assert.equal(result.access.broken.oldConsumers.verify.ok, false);
    assert.equal(result.access.recovered.overview.ok, true);
    assert.equal(result.access.recovered.overview.value.instanceId,
      result.access.evolution.current.instanceId);
    assert.equal(result.access.recovered.verify.value.requestStatus, 200);
    assert.notEqual(result.access.evolution.current.url, result.access.evolution.previous.url);
    assert.equal(result.access.broken.oldConsumerAfterAdaptation.ok, false);
    assert.equal(result.access.broken.routeBarriers.missingHeader.status, 403);
    assert.equal(result.access.broken.routeBarriers.valid.status, 200);
    assert.equal(result.access.rejections.staleInstance.result.error.code, 'WRONG_TARGET');
    assert.equal(result.access.rejections.wrongTarget.result.error.code, 'NOT_READY');

    // Stage two: the delivered target is independently observed and consistent.
    const deliveryVerification = result.delivery.evidence.verification;
    assert.equal(deliveryVerification.ok, true);
    assert.equal(deliveryVerification.verdict, 'consistent');
    assert.deepEqual(deliveryVerification.mismatches, []);
    assert.equal(deliveryVerification.target.instanceId, result.delivery.target.instanceId);
    assert.equal(result.delivery.expected.payloadSha256, result.delivery.artifact.payloadSha256);
    assert.notEqual(result.delivery.target.url, result.initial.gateway.url);

    // Stage three: protocol boundaries and image bytes are re-read from the
    // live GIS process, not copied from a prior response.
    const gisEvidence = result.gis.evidence;
    assert.equal(gisEvidence.ok, true);
    assert.deepEqual(gisEvidence.checks.filter(entry => entry.status !== 'pass'), []);
    assert.equal(gisEvidence.boundaries.serviceExceptionsAreXml, true);
    assert.ok(gisEvidence.boundaries.probes.every(probe => probe.status === 400));
    const fullOracle = gisEvidence.maps.fullExtent.oracle;
    const subsetOracle = gisEvidence.maps.subset.oracle;
    const repeatedOracle = gisEvidence.maps.repeated.oracle;
    assert.equal(fullOracle.pass, true);
    assert.equal(fullOracle.goldenMatch, true);
    assert.equal(fullOracle.blueChannelMatchesLayerSeed, true);
    assert.equal(fullOracle.axisOrientation, true);
    assert.equal(fullOracle.goldenSamples.length > 0, true);
    assert.equal(subsetOracle.pass, true);
    assert.equal(subsetOracle.goldenMatch, null);
    assert.equal(subsetOracle.blueChannelMatchesLayerSeed, true);
    assert.equal(repeatedOracle.pass, true);
    assert.equal(repeatedOracle.goldenMatch, true);
    assert.equal(gisEvidence.maps.revisedLayer.oracle.pass, true);
    assert.equal(gisEvidence.maps.revisedLayer.oracle.goldenMatch, true);
    assert.equal(gisEvidence.maps.fullExtent.sha256, gisEvidence.maps.repeated.sha256);
    assert.notEqual(gisEvidence.maps.fullExtent.sha256, gisEvidence.maps.subset.sha256);
    assert.equal(gisEvidence.configChange.restart.oldUrlStatus, null);
    assert.equal(result.gis.service.runningAtStageEnd, true);

    // Stage four: source/target/GIS changes are distinguishable. The old
    // artifact stays consistent with its own runtime; the new artifact and
    // runtime verify together; mixing new expectations with the old runtime
    // is a mismatch.
    const sourceChange = result.changes.sourceChange;
    assert.equal(sourceChange.audits.oldWorldSelfConsistent.verdict, 'consistent');
    assert.equal(sourceChange.audits.newWorldSelfConsistent.verdict, 'consistent');
    assert.equal(sourceChange.audits.mixedNewExpectedOldRuntime.verdict, 'mismatch');
    assert.equal(sourceChange.audits.mixedOldExpectedNewArtifactOldRuntime.verdict, 'mismatch');
    assert.notEqual(sourceChange.beforeRevision, sourceChange.afterRevision);
    assert.equal(sourceChange.sourceFreshness.oldReferenceIsCurrent, false);
    assert.equal(sourceChange.oldDelivery.ok, true);
    assert.equal(sourceChange.sourceFreshness.deliveryVerifyResult.ok, true);
    assert.equal(sourceChange.sameTargetIdentity.instanceIdUnchanged, true);
    assert.equal(sourceChange.sameTargetIdentity.urlUnchanged, true);
    assert.equal(result.changes.consumers.deliveryVerifier.afterRedelivery.ok, true);
    assert.equal(result.changes.expected.payloadSha256, result.changes.artifact.payloadSha256);
    assert.notEqual(result.changes.expected.payloadSha256, result.delivery.artifact.payloadSha256);

    const targetChange = result.changes.targetChange;
    assert.notEqual(targetChange.current.url, targetChange.previous.url);
    assert.notEqual(targetChange.current.instanceId, targetChange.previous.instanceId);
    assert.equal(result.changes.consumers.gatewayHandoff.after.ok, true);
    assert.equal(result.changes.consumers.gatewayHandoff.after.requestStatus, 200);
    assert.equal(result.changes.consumers.gatewayDirect.after.ok, false);
    assert.equal(result.changes.consumers.sourceInspector.after.revision, sourceChange.afterRevision);
    assert.equal(result.changes.consumers.sourceInspector.after.dirty, false);
    assert.equal(result.changes.consumers.sourceInspector.after.syntax, 'valid');

    const gisChange = result.changes.gisChange;
    assert.equal(gisChange.oldReferences.address.ok, false);
    assert.equal(gisChange.oldReferences.layer.ok, false);
    assert.equal(gisChange.oldReferences.layer.exception.code, 'LayerNotDefined');
    assert.notEqual(gisChange.after.url, gisChange.before.url);
    assert.notEqual(gisChange.after.instanceId, gisChange.before.instanceId);
    assert.equal(result.gis.service.url, gisChange.after.url);
    assert.equal(result.gis.service.instanceId, gisChange.after.instanceId);
    assert.ok(gisChange.after.capabilities.layers.includes(gisChange.after.layer));
    assert.equal(gisChange.after.map.ok, true);
    assert.equal(gisChange.runningBeforeRestart.serviceTitle,
      gisChange.before.capabilities.serviceTitle);

    // Stage five: applicability and refusal are decided before any action;
    // the authorized repair performs exactly the recorded mutations.
    const knowledge = result.knowledge;
    assert.equal(knowledge.artifactContext.artifactSha256,
      result.changes.artifact.payloadSha256);
    assert.equal(knowledge.scenarios.bootstrap.knowledgeUsedForFirstAction, false);
    assert.equal(knowledge.scenarios.bootstrap.shortcut.requestStatusAfter, 502);
    assert.equal(knowledge.scenarios.bootstrap.repair.requestStatusAfter, 200);

    assert.equal(knowledge.scenarios.expired.expiredDecision.decision, 'refuse');
    assert.equal(knowledge.scenarios.expired.expiredDecision.primaryReason, 'EXPIRED');
    assert.equal(knowledge.scenarios.expired.expiredDecision.unchanged, true);
    assert.equal(knowledge.scenarios.expired.blockedShortcut.primaryReason, 'REFUTED_PROCEDURE');
    assert.equal(knowledge.mutations.expired.environmentWrites, 0);

    const persistedEdit = knowledge.scenarios.persistedEdit;
    assert.equal(persistedEdit.decisionBefore.decision, 'execute');
    assert.equal(persistedEdit.decisionBeforeCold.decision, 'execute');
    assert.equal(persistedEdit.coldMatchesMain, true);
    assert.equal(persistedEdit.changed, true);
    assert.equal(persistedEdit.decisionAfter.decision, 'refuse');
    assert.equal(persistedEdit.decisionAfter.primaryReason, 'REFUTED_PROCEDURE');
    assert.equal(persistedEdit.decisionAfterCold.decision, 'refuse');
    assert.equal(persistedEdit.decisionAfterCold.primaryReason, 'REFUTED_PROCEDURE');
    assert.equal(persistedEdit.mutations.environmentWrites, 0);
    assert.equal(persistedEdit.mutations.restarts, 0);
    assert.equal(persistedEdit.unchanged, true);

    const evidenceCases = new Map(
      knowledge.scenarios.evidenceGate.cases.map(item => [item.case, item]),
    );
    for (const name of ['empty', 'missing', 'modified', 'record-removed']) {
      const item = evidenceCases.get(name);
      assert.equal(item.decisionBefore.decision, 'execute');
      assert.equal(item.decisionAfter.decision, 'refuse');
      assert.equal(item.unchanged, true);
      assert.equal(item.mutations.environmentWrites, 0);
      assert.equal(item.mutations.restarts, 0);
    }
    assert.equal(evidenceCases.get('empty').primaryReason, 'INVALID_RECORD');
    assert.equal(evidenceCases.get('empty').decisionAfter.invalid.length > 0, true);
    assert.equal(evidenceCases.get('missing').primaryReason, 'EVIDENCE_UNVERIFIED');
    assert.equal(evidenceCases.get('missing').decisionAfter.evidenceInvalid.length > 0, true);
    assert.equal(evidenceCases.get('modified').primaryReason, 'EVIDENCE_UNVERIFIED');
    assert.equal(evidenceCases.get('modified').decisionAfter.evidenceInvalid.length > 0, true);
    assert.equal(evidenceCases.get('record-removed').primaryReason, 'NO_APPLICABLE_KNOWLEDGE');

    const actionTimeExpiry = knowledge.scenarios.actionTimeExpiry;
    assert.equal(actionTimeExpiry.decisionBeforeAction.decision, 'execute');
    assert.equal(actionTimeExpiry.actionTimeDecision.decision, 'refuse');
    assert.equal(actionTimeExpiry.actionTimeDecision.primaryReason, 'EXPIRED');
    assert.equal(actionTimeExpiry.refusedBy, 'KNOWLEDGE_NOT_ACTIONABLE');
    assert.equal(actionTimeExpiry.mutations.environmentWrites, 0);
    assert.equal(actionTimeExpiry.mutations.restarts, 0);
    assert.equal(actionTimeExpiry.unchanged, true);

    const actionFailure = knowledge.scenarios.actionFailure;
    assert.equal(actionFailure.environmentChanged, true);
    assert.equal(actionFailure.gateCounts.environmentWrites, 1);
    assert.equal(actionFailure.gateCounts.restarts, 0);
    assert.equal(actionFailure.requestStatusAfter, 502);

    assert.equal(knowledge.scenarios.changedConditions.decision.primaryReason, 'CONDITION_MISMATCH');
    assert.equal(knowledge.scenarios.changedConditions.decision.unchanged, true);
    assert.equal(knowledge.mutations.changedConditions.unauthorizedWrites, 0);
    assert.equal(knowledge.scenarios.changedConditions.revalidation.requestStatusAfter, 200);
    assert.equal(knowledge.scenarios.changedConditions.fileEffect.decisionBeforeAppend.primaryReason,
      'CONDITION_MISMATCH');
    assert.equal(knowledge.scenarios.changedConditions.fileEffect.decisionAfterAppend.decision, 'execute');

    assert.equal(knowledge.scenarios.valid.decision.decision, 'execute');
    assert.equal(knowledge.scenarios.valid.coldRead.source, 'separate-node-process');
    assert.equal(knowledge.scenarios.valid.coldRead.decision,
      knowledge.scenarios.valid.decision.decision);
    assert.equal(knowledge.scenarios.valid.coldRead.primaryReason, null);
    assert.equal(knowledge.scenarios.valid.coldRead.matchesInProcess, true);
    assert.equal(knowledge.scenarios.valid.revalidated.decision.decision, 'execute');
    assert.equal(knowledge.scenarios.valid.revalidated.context.artifactSha256,
      result.changes.artifact.payloadSha256);
    assert.equal(knowledge.scenarios.valid.mutations.environmentWrites, 1);
    assert.equal(knowledge.scenarios.valid.mutations.restarts, 1);
    assert.equal(knowledge.scenarios.valid.requestStatusAfter, 200);

    assert.equal(knowledge.scenarios.conflict.conflictDecision.decision, 'refuse');
    assert.equal(knowledge.scenarios.conflict.conflictDecision.primaryReason, 'CONFLICT');
    assert.equal(knowledge.scenarios.conflict.conflictDecision.unchanged, true);
    assert.equal(knowledge.mutations.conflict.blockedWrites, 0);
    assert.equal(knowledge.scenarios.conflict.restartOnlyFailure.requestStatusAfter, 502);
    assert.equal(knowledge.scenarios.conflict.resolvedDecision.decision, 'execute');
    assert.equal(knowledge.scenarios.conflict.resolvedDecision.mutations.environmentWrites, 1);
    assert.equal(knowledge.scenarios.conflict.resolvedDecision.requestStatusAfter, 200);
    assert.equal(knowledge.scenarios.conflict.resolvedDecision.revalidated.decision.decision,
      'execute');
    const conflictFile = knowledge.scenarios.conflict.fileChangedGate;
    assert.equal(conflictFile.changed, true);
    assert.notEqual(conflictFile.sha256Before, conflictFile.sha256After);
    assert.equal(conflictFile.decisionBefore.primaryReason, 'CONFLICT');
    assert.equal(conflictFile.decisionBefore.mutations.environmentWrites, 0);
    assert.equal(conflictFile.decisionBefore.mutations.restarts, 0);
    assert.equal(conflictFile.decisionAfter.decision, 'execute');
    assert.equal(conflictFile.executionAfter.mutations.environmentWrites, 1);

    // Stage six: the independent handoff consumer reads only the public
    // receipt, observes the live gateway/GIS, and leaves the workspace alone.
    const extension = result.extension;
    assert.equal(extension.ok, true);
    assert.equal(extension.status, 'ready');
    assert.deepEqual(extension.failures, []);
    assert.equal(extension.facilities.gateway.ok, true);
    assert.equal(extension.facilities.gateway.url, result.changes.target.url);
    assert.equal(extension.facilities.gateway.instanceId, result.changes.target.instanceId);
    assert.equal(extension.facilities.gis.ok, true);
    assert.equal(extension.facilities.gis.url, result.changes.gisChange.after.url);
    assert.equal(extension.facilities.gis.instanceId, result.changes.gisChange.after.instanceId);
    assert.equal(extension.facilities.gis.mapCount, extension.facilities.gis.layerCount);
    assert.equal(extension.facilities.knowledge.ok, true);
    assert.equal(extension.facilities.knowledge.contextComplete, true);
    const decisions = extension.facilities.knowledge.decisions;
    assert.equal(decisions.some(decision => decision.decision === 'execute'), true);
    assert.equal(decisions.some(decision => decision.decision === 'refuse'), true);

    const handoff = JSON.parse(
      await readFile(join(extension.outputDirectory, 'handoff.json'), 'utf8'),
    );
    assert.equal(handoff.ok, true);
    assert.equal(handoff.status, 'ready');
    assert.equal(handoff.receipt.sha256, extension.receipt.sha256);
    assert.equal(handoff.receipt.expected.payloadSha256, result.changes.expected.payloadSha256);
    assert.equal(handoff.facilities.gis.maps.length, handoff.facilities.gis.layerCount);
    assert.equal(handoff.facilities.gis.mapCount, handoff.facilities.gis.layerCount);

    const control = extension.control;
    assert.equal(control.ok, false);
    assert.equal(control.status, 'not-ready');
    assert.equal(control.facilities.gateway.ok, false);
    assert.equal(control.facilities.gis.ok, true);
    assert.equal(control.facilities.gis.mapCount, control.facilities.gis.layerCount);
    assert.notEqual(control.receipt.sha256, control.originalReceiptSha256);
    assert.equal(extension.receipt.sha256, control.originalReceiptSha256);

    const controlHandoff = JSON.parse(
      await readFile(join(control.outputDirectory, 'handoff.json'), 'utf8'),
    );
    assert.equal(controlHandoff.ok, false);
    assert.equal(controlHandoff.status, 'not-ready');
    assert.equal(controlHandoff.retained.gateway, false);
    assert.equal(controlHandoff.retained.gis, true);
    assert.equal(controlHandoff.facilities.gis.maps.length,
      controlHandoff.facilities.gis.layerCount);
    assert.equal(controlHandoff.facilities.gis.mapCount,
      controlHandoff.facilities.gis.layerCount);

    const closedReceipt = JSON.parse(
      await readFile(result.extensionReceiptFile, 'utf8'),
    );
    assert.equal(closedReceipt.status, 'closed');
    assert.equal(closedReceipt.reason, 'completed');
    assert.equal(typeof closedReceipt.closedAt, 'string');
    assert.equal(closedReceipt.resources.closed, true);
    assert.equal(closedReceipt.resources.gisClosed, true);
    assert.equal(closedReceipt.resources.workspaceClosed, true);
    assert.deepEqual(closedReceipt.resources.errors, []);

    const runningReceiptBytes = await readFile(result.extensionRunningReceiptFile);
    const runningReceipt = JSON.parse(runningReceiptBytes.toString('utf8'));
    assert.equal(runningReceipt.status, 'running');
    assert.equal(sha256(runningReceiptBytes), extension.receipt.sha256);
    assert.notEqual(sha256(await readFile(result.extensionReceiptFile)),
      extension.receipt.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('a non-empty caller directory is rejected without being modified', async () => {
  await mkdir(join(ROOT, 'temp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, 'temp', 'evolution-nonempty-'));
  const sentinel = join(directory, 'keep.txt');
  await writeFile(sentinel, 'original bytes', 'utf8');

  try {
    let error = null;
    try {
      await createWorkspace({ directory });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 'WORKSPACE_DIRECTORY_NOT_EMPTY');
    assert.equal(await readFile(sentinel, 'utf8'), 'original bytes');
    assert.deepEqual((await readdir(directory)).sort(), ['keep.txt']);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
