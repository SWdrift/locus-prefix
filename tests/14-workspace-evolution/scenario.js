/**
 * Unified acceptance for stages zero through six of the continuous-evolution
 * workspace. Stage six is the independent handoff consumer; the live session
 * entry intentionally stops after stage five so that consumer is external.
 *
 * The runner calls each stage's public function once, records the ordered
 * status/failure/cost evidence, and checks only observable consumer behavior
 * and stated boundaries. It owns no evolution logic of its own and does not
 * wrap the lab in another abstraction.
 *
 * `runWorkspaceEvolution` closes every resource it opened. The live session
 * entry keeps stages zero through five alive for an independent stage-six probe.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspace } from './fixture.js';
import { runAccessEvolution } from './stage1.js';
import { runDeliveryEvolution } from './delivery.js';
import { runGisEvolution } from './gis.js';
import { runChanges } from './changes.js';
import { runKnowledgeEvolution } from './knowledge.js';
import { runAgentExtension } from './agent-extension.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MODULE_FILE = fileURLToPath(import.meta.url);
const STAGE_NAMES = ['initial', 'access', 'delivery', 'gis', 'changes', 'knowledge', 'extension'];

function portablePath(path) {
  return path.split(sep).join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonMaybe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeError(error) {
  const summary = {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : String(error),
  };
  if (typeof error?.code === 'string') summary.code = error.code;
  if (typeof error?.stage === 'number') summary.stage = error.stage;
  return summary;
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function capture(action) {
  const startedAt = Date.now();
  try {
    return { ok: true, value: await action(), durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: summarizeError(error), durationMs: Date.now() - startedAt };
  }
}

function check(name, ok, detail) {
  return { name, ok: ok === true, ...(detail === undefined ? {} : { detail }) };
}

function checkStatus(checks, id) {
  const found = Array.isArray(checks) ? checks.find(item => item.id === id) : undefined;
  return found?.status ?? 'missing';
}

function evidencePath(root, file) {
  const relativeFile = relative(root, file);
  return relativeFile.startsWith('..') ? portablePath(file) : portablePath(relativeFile);
}

function enforce(stage, checks, evidenceFiles) {
  const failed = checks.filter(item => !item.ok);
  if (failed.length === 0) return;
  const error = new Error(`${stage} acceptance failed: ${failed.map(item => item.name).join('; ')}`);
  error.code = 'WORKSPACE_ACCEPTANCE_FAILED';
  error.stage = stage;
  error.checks = checks;
  error.failedChecks = failed;
  error.evidenceFiles = evidenceFiles;
  throw error;
}

// ------------------------------------------------------------ stage zero
async function observeInitialState(workspace) {
  const runId = randomUUID();
  const [accessModule, consumersModule] = await Promise.all([
    import(`${pathToFileURL(workspace.paths.initialAccess).href}?stage0=${runId}-access`),
    import(`${pathToFileURL(workspace.paths.initialConsumers).href}?stage0=${runId}-consumers`),
  ]);
  const consumers = consumersModule.gatewayConsumers(accessModule.inspectGateway);
  const [overview, verify, source] = await Promise.all([
    capture(() => consumers.overview(workspace.directory)),
    capture(() => consumers.verify(workspace.directory)),
    capture(() => consumersModule.inspectSource(workspace.directory)),
  ]);
  const service = JSON.parse(await readFile(workspace.paths.serviceFile, 'utf8'));
  const gateway = {
    role: workspace.gateway.role,
    url: workspace.gateway.url,
    instanceId: workspace.gateway.instanceId,
  };

  const checks = [
    check('initial consumers observe the captured gateway instance',
      overview.ok === true &&
        overview.value.role === gateway.role &&
        overview.value.instanceId === gateway.instanceId,
      overview.ok ? overview.value : overview.error),
    check('the initial gateway completes a live check request',
      verify.ok === true &&
        verify.value.requestStatus === 200 &&
        verify.value.instanceId === gateway.instanceId,
      verify.ok ? verify.value : verify.error),
    check('the source inspector reads a clean Git revision with valid syntax',
      source.ok === true &&
        source.value.dirty === false &&
        source.value.syntax === 'valid' &&
        typeof source.value.revision === 'string' &&
        source.value.revision.length > 0,
      source.ok ? source.value : source.error),
    check('the on-disk service descriptor names the live gateway',
      service.role === gateway.role &&
        service.baseUrl === gateway.url &&
        service.instanceId === gateway.instanceId,
      { service, gateway }),
  ];

  const evidenceFile = join(workspace.directory, 'evidence', 'initial-state.json');
  const evidence = {
    stage: 0,
    capturedAt: new Date().toISOString(),
    gateway,
    service,
    overview,
    verify,
    source,
    costs: {
      overviewMs: overview.durationMs,
      verifyMs: verify.durationMs,
      sourceMs: source.durationMs,
    },
    checks,
  };
  await writeJson(evidenceFile, evidence);
  const evidenceFiles = [evidencePath(workspace.directory, evidenceFile)];
  enforce('initial', checks, evidenceFiles);
  return { ...evidence, checks, costs: evidence.costs, evidenceFiles };
}

// ------------------------------------------------------------ stage one
function acceptAccess(workspace, access) {
  const previous = access.evolution.previous;
  const current = access.evolution.current;
  const barriers = access.broken.routeBarriers;
  const checks = [
    check('the access change retires the previous address and instance',
      current.url !== previous.url && current.instanceId !== previous.instanceId,
      { previous, current }),
    check('the old direct consumers fail after the address is retired',
      access.broken.oldConsumers.overview.ok === false &&
        access.broken.oldConsumers.verify.ok === false,
      {
        overview: access.broken.oldConsumers.overview.error,
        verify: access.broken.oldConsumers.verify.error,
      }),
    check('the adapted consumer reads the current instance and completes a request',
      access.recovered.overview.ok === true &&
        access.recovered.overview.value.instanceId === current.instanceId &&
        access.recovered.verify.ok === true &&
        access.recovered.verify.value.instanceId === current.instanceId &&
        access.recovered.verify.value.requestStatus === 200,
      {
        overview: access.recovered.overview.value ?? access.recovered.overview.error,
        verify: access.recovered.verify.value ?? access.recovered.verify.error,
      }),
    check('the old direct consumer still fails after adaptation',
      access.broken.oldConsumerAfterAdaptation.ok === false,
      access.broken.oldConsumerAfterAdaptation.error),
    check('the issued entry requires both its path prefix and routing header',
      barriers.outsidePrefix.status === 404 &&
        barriers.missingHeader.status === 403 &&
        barriers.wrongHeader.status === 403 &&
        barriers.valid.status === 200,
      barriers),
    check('stale identity and wrong-target handoffs are rejected',
      access.rejections.staleInstance.result.ok === false &&
        access.rejections.staleInstance.result.error.code === 'WRONG_TARGET' &&
        access.rejections.wrongRole.result.ok === false &&
        access.rejections.wrongRole.result.error.code === 'WRONG_TARGET' &&
        access.rejections.wrongTarget.result.ok === false &&
        access.rejections.wrongTarget.result.error.code === 'NOT_READY',
      {
        staleInstance: access.rejections.staleInstance.result.error,
        wrongRole: access.rejections.wrongRole.result.error,
        wrongTarget: access.rejections.wrongTarget.result.error,
      }),
  ];
  const evidenceFiles = [evidencePath(workspace.directory, access.evidenceFile)];
  enforce('access', checks, evidenceFiles);
  return { checks, costs: access.costs, evidenceFiles };
}

// ------------------------------------------------------------ stage two
async function acceptDelivery(workspace, delivery) {
  const evidence = delivery.evidence;
  const verification = evidence.verification;
  const required = [
    'artifact.delivery-integrity',
    'target.health',
    'target.identity',
    'target.upstream-config',
    'target.upstream-request',
    'expected.payload-binding',
  ];
  const missing = required.filter(id => checkStatus(verification.checks, id) !== 'pass');

  const checks = [
    check('the delivered target verifies as a consistent release',
      verification.ok === true &&
        verification.verdict === 'consistent' &&
        verification.mismatches.length === 0,
      { verdict: verification.verdict, mismatches: verification.mismatches }),
    check('artifact bytes, source, target identity, upstream configuration and request are independently observed',
      missing.length === 0,
      { missing, failed: verification.mismatches }),
    check('the delivered target is a distinct role and address from the initial gateway',
      delivery.target.role !== workspace.gateway.role &&
        delivery.target.url !== workspace.gateway.url &&
        delivery.target.instanceId !== workspace.gateway.instanceId,
      { target: delivery.target, initialGateway: workspace.gateway }),
    check('the expected release matches the built artifact and verified target',
      delivery.expected.release === delivery.artifact.release &&
        delivery.expected.sourceRevision === delivery.artifact.sourceRevision &&
        delivery.expected.payloadSha256 === delivery.artifact.payloadSha256 &&
        verification.target.instanceId === delivery.target.instanceId,
      {
        expected: delivery.expected,
        artifact: {
          release: delivery.artifact.release,
          sourceRevision: delivery.artifact.sourceRevision,
          payloadSha256: delivery.artifact.payloadSha256,
        },
        verificationTarget: verification.target,
      }),
  ];

  const evidenceFile = join(workspace.directory, 'evidence', 'delivery.json');
  await writeJson(evidenceFile, evidence);
  const evidenceFiles = [evidencePath(workspace.directory, evidenceFile)];
  enforce('delivery', checks, evidenceFiles);
  return { checks, costs: evidence.costs, evidenceFiles };
}

// ------------------------------------------------------------ stage three
async function acceptGis(workspace, gisResult) {
  const evidence = gisResult.evidence;
  const maps = evidence.maps;
  const config = evidence.configChange;
  const failedChecks = evidence.checks.filter(item => item.status !== 'pass');
  const fullOracle = maps.fullExtent.oracle;
  const subsetOracle = maps.subset.oracle;
  const repeatedOracle = maps.repeated.oracle;
  const revisedOracle = maps.revisedLayer.oracle;
  const goldenSamplesValid = samples => Array.isArray(samples) && samples.length > 0 &&
    samples.every(sample =>
      Number.isInteger(sample.x) &&
      Number.isInteger(sample.y) &&
      Array.isArray(sample.rgb) &&
      sample.rgb.length === 3 &&
      sample.rgb.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255));

  const checks = [
    check('every GIS protocol and lifecycle check passes',
      evidence.ok === true && failedChecks.length === 0,
      failedChecks),
    check('the GIS process is running while its protocol evidence is collected',
      evidence.service.runningAtCollection === true,
      evidence.service),
    check('unsupported WMS parameters are refused with ServiceException XML',
      evidence.boundaries.serviceExceptionsAreXml === true &&
        evidence.boundaries.probes.length > 0 &&
        evidence.boundaries.probes.every(probe => probe.status === 400),
      evidence.boundaries.probes.map(probe => ({
        name: probe.name,
        status: probe.status,
        code: probe.exception?.code ?? null,
      }))),
    check('map pixels satisfy the independent golden/invariant oracle and repeated requests reproduce bytes',
      maps.fullExtent.ok === true &&
        fullOracle?.pass === true &&
        fullOracle?.goldenMatch === true &&
        fullOracle?.blueChannelMatchesLayerSeed === true &&
        fullOracle?.axisOrientation === true &&
        goldenSamplesValid(fullOracle?.goldenSamples) &&
        maps.subset.ok === true &&
        subsetOracle?.pass === true &&
        subsetOracle?.blueChannelMatchesLayerSeed === true &&
        subsetOracle?.axisOrientation === true &&
        subsetOracle?.goldenMatch === null &&
        maps.fullExtent.sha256 !== maps.subset.sha256 &&
        maps.repeated.ok === true &&
        repeatedOracle?.pass === true &&
        repeatedOracle?.goldenMatch === true &&
        goldenSamplesValid(repeatedOracle?.goldenSamples) &&
        maps.repeated.sha256 === maps.fullExtent.sha256,
      {
        fullExtent: { sha256: maps.fullExtent.sha256, oracle: fullOracle },
        subset: { sha256: maps.subset.sha256, oracle: subsetOracle },
        repeated: { sha256: maps.repeated.sha256, oracle: repeatedOracle },
      }),
    check('an invalid config edit is rejected without changing the file',
      config.invalidEditRejected.errorCode === 'config-invalid' &&
        config.invalidEditRejected.fileSha256Unchanged === true,
      config.invalidEditRejected),
    check('a valid config edit is written with an explicit restart requirement',
      config.applied.requiresRestart === true &&
        typeof config.applied.configSha256 === 'string',
      { applied: config.applied }),
    check('restart retires the old address and serves the revised title and layer',
      config.restart.newUrl !== config.restart.oldUrl &&
        config.restart.newInstance !== config.restart.oldInstance &&
        config.restart.oldUrlStatus === null &&
        evidence.capabilities.revised.parsed?.serviceTitle === config.applied.title &&
        config.applied.layers.every(layer =>
          evidence.capabilities.revised.parsed?.layers.some(item => item.name === layer)) &&
        maps.revisedLayer.ok === true &&
        revisedOracle?.pass === true &&
        revisedOracle?.goldenMatch === true &&
        revisedOracle?.blueChannelMatchesLayerSeed === true &&
        goldenSamplesValid(revisedOracle?.goldenSamples),
      {
        restart: config.restart,
        revisedTitle: evidence.capabilities.revised.parsed?.serviceTitle,
        applied: config.applied,
        revisedMapOk: maps.revisedLayer.ok,
        revisedOracle,
      }),
  ];

  const evidenceFile = join(workspace.directory, 'evidence', 'gis.json');
  await writeJson(evidenceFile, evidence);
  const evidenceFiles = [evidencePath(workspace.directory, evidenceFile)];
  enforce('gis', checks, evidenceFiles);
  return { checks, costs: evidence.costs, evidenceFiles };
}

// ----------------------------------------------------------- stage four
function acceptChanges(workspace, changes) {
  const source = changes.sourceChange;
  const target = changes.targetChange;
  const gis = changes.gisChange;
  const audits = source.audits;
  const checks = [
    check('the source advance is a clean commit re-read by both the inspector and delivery pipeline',
      source.afterRevision !== source.beforeRevision &&
        source.sourceFreshness.currentWorktreeRevision === source.afterRevision &&
        source.sourceFreshness.oldReferenceIsCurrent === false &&
        changes.source.dirty === false &&
        changes.consumers.sourceInspector.after.revision === source.afterRevision &&
        changes.consumers.sourceInspector.after.syntax === 'valid',
      {
        sourceFreshness: source.sourceFreshness,
        source: changes.source,
        inspector: changes.consumers.sourceInspector.after,
      }),
    check('the old artifact remains self-consistent with its own expected release and runtime',
      audits.oldWorldSelfConsistent.verdict === 'consistent' &&
        source.sameTargetIdentity.instanceIdUnchanged === true &&
        source.sameTargetIdentity.urlUnchanged === true,
      {
        oldWorld: audits.oldWorldSelfConsistent,
        sameTargetIdentity: source.sameTargetIdentity,
      }),
    check('the existing delivery verifier keeps its A/A verdict after the checkout moves',
      source.oldDelivery.ok === true &&
        source.sourceFreshness.deliveryVerifyResult.ok === true &&
        source.sourceFreshness.deliveryVerifyResult.verdict === 'consistent' &&
        source.sourceFreshness.oldReferenceIsCurrent === false,
      {
        oldDelivery: source.oldDelivery,
        freshness: source.sourceFreshness,
      }),
    check('the rebuilt artifact verifies with a distinct target address and instance',
      audits.newWorldSelfConsistent.verdict === 'consistent' &&
        changes.consumers.deliveryVerifier.afterRedelivery.ok === true &&
        changes.consumers.deliveryVerifier.afterRedelivery.verdict === 'consistent' &&
        target.current.url !== target.previous.url &&
        target.current.instanceId !== target.previous.instanceId,
      {
        newWorld: audits.newWorldSelfConsistent,
        deliveryVerifier: changes.consumers.deliveryVerifier.afterRedelivery,
        target,
      }),
    check('mixing the new expected release with the old runtime is a mismatch',
      audits.mixedNewExpectedOldRuntime.verdict === 'mismatch' &&
        audits.mixedNewExpectedOldRuntime.failed.length > 0,
      audits.mixedNewExpectedOldRuntime),
    check('the expected release is bound to the rebuilt artifact',
      changes.expected.payloadSha256 === changes.artifact.payloadSha256 &&
        changes.expected.sourceRevision === changes.artifact.sourceRevision,
      { expected: changes.expected, artifact: changes.artifact }),
    check('the handoff consumer keeps verifying while the direct consumer stays broken',
      changes.consumers.gatewayHandoff.after.ok === true &&
        changes.consumers.gatewayHandoff.after.requestStatus === 200 &&
        changes.consumers.gatewayDirect.after.ok === false,
      {
        handoff: changes.consumers.gatewayHandoff.after,
        direct: changes.consumers.gatewayDirect.after,
      }),
    check('the GIS config file change is inert until restart',
      gis.configWriteChanged === true &&
        gis.runningBeforeRestart.serviceTitle === gis.before.capabilities.serviceTitle,
      {
        configWriteChanged: gis.configWriteChanged,
        before: gis.before.capabilities.serviceTitle,
        running: gis.runningBeforeRestart.serviceTitle,
      }),
    check('the GIS restart retires the old address and layer while fresh capabilities and maps work',
      gis.after.url !== gis.before.url &&
        gis.after.instanceId !== gis.before.instanceId &&
        gis.oldReferences.address.ok === false &&
        gis.oldReferences.layer.ok === false &&
        gis.oldReferences.layer.exception?.code === 'LayerNotDefined' &&
        gis.after.capabilities.layers.includes(gis.after.layer) &&
        gis.after.map.ok === true,
      {
        before: { url: gis.before.url, instanceId: gis.before.instanceId, layer: gis.before.layer },
        after: { url: gis.after.url, instanceId: gis.after.instanceId, layer: gis.after.layer },
        oldAddress: gis.oldReferences.address,
        oldLayer: gis.oldReferences.layer,
        mapOk: gis.after.map.ok,
      }),
  ];
  const evidenceFiles = changes.evidence.files.map(entry => entry.path);
  enforce('changes', checks, evidenceFiles);
  return {
    checks,
    costs: changes.costs,
    evidenceFiles,
    failures: changes.failures,
  };
}

// ----------------------------------------------------------- stage five
function acceptKnowledge(knowledge, expectedPayloadSha256) {
  const scenarios = knowledge.scenarios;
  const expired = scenarios.expired;
  const changed = scenarios.changedConditions;
  const valid = scenarios.valid;
  const conflict = scenarios.conflict;
  const persistedEdit = scenarios.persistedEdit;
  const conflictFile = conflict.fileChangedGate;
  const evidenceCases = new Map((scenarios.evidenceGate?.cases ?? []).map(item => [item.case, item]));
  const actionTimeExpiry = scenarios.actionTimeExpiry;
  const actionFailure = scenarios.actionFailure;
  const evidenceCaseRefused = item => Boolean(item) &&
    item.decisionBefore.decision === 'execute' &&
    item.decisionAfter.decision === 'refuse' &&
    item.unchanged === true &&
    item.mutations.environmentWrites === 0 &&
    item.mutations.restarts === 0;
  const checks = [
    check('the first repair and the refuted shortcut come from real actions before knowledge exists',
      scenarios.bootstrap.knowledgeUsedForFirstAction === false &&
        scenarios.bootstrap.shortcut.requestStatusAfter === 502 &&
        scenarios.bootstrap.repair.requestStatusAfter === 200,
      scenarios.bootstrap),
    check('expired knowledge refuses and its refusal leaves the scene unchanged',
      expired.expiredDecision.decision === 'refuse' &&
        expired.expiredDecision.primaryReason === 'EXPIRED' &&
        expired.expiredDecision.unchanged === true &&
        knowledge.mutations.expired.environmentWrites === 0 &&
        knowledge.mutations.expired.restarts === 0,
      {
        decision: expired.expiredDecision,
        mutations: knowledge.mutations.expired,
      }),
    check('a refuted procedure is refused even when it is explicitly proposed',
      expired.blockedShortcut.decision === 'refuse' &&
        expired.blockedShortcut.primaryReason === 'REFUTED_PROCEDURE' &&
        expired.blockedShortcut.unchanged === true,
      expired.blockedShortcut),
    check('a separate process reproduces the persisted pre-edit execute decision',
      persistedEdit.decisionBefore.decision === 'execute' &&
        persistedEdit.decisionBeforeCold.decision === 'execute' &&
        persistedEdit.coldMatchesMain === true,
      {
        before: persistedEdit.decisionBefore,
        coldBefore: persistedEdit.decisionBeforeCold,
      }),
    check('editing only the persisted status changes both readers to refusal without an action',
      persistedEdit.changed === true &&
        persistedEdit.decisionAfter.decision === 'refuse' &&
        persistedEdit.decisionAfter.primaryReason === 'REFUTED_PROCEDURE' &&
        persistedEdit.decisionAfterCold.decision === 'refuse' &&
        persistedEdit.decisionAfterCold.primaryReason === 'REFUTED_PROCEDURE' &&
        persistedEdit.mutations.environmentWrites === 0 &&
        persistedEdit.mutations.restarts === 0 &&
        persistedEdit.unchanged === true,
      {
        after: persistedEdit.decisionAfter,
        coldAfter: persistedEdit.decisionAfterCold,
        mutations: persistedEdit.mutations,
      }),
    check('empty persisted evidence cannot authorize an action',
      evidenceCaseRefused(evidenceCases.get('empty')) &&
        evidenceCases.get('empty').primaryReason === 'INVALID_RECORD' &&
        evidenceCases.get('empty').decisionAfter.invalid.length > 0,
      evidenceCases.get('empty')),
    check('a missing evidence file cannot authorize an action',
      evidenceCaseRefused(evidenceCases.get('missing')) &&
        evidenceCases.get('missing').primaryReason === 'EVIDENCE_UNVERIFIED' &&
        evidenceCases.get('missing').decisionAfter.evidenceInvalid.length > 0,
      evidenceCases.get('missing')),
    check('modified evidence bytes cannot authorize an action',
      evidenceCaseRefused(evidenceCases.get('modified')) &&
        evidenceCases.get('modified').primaryReason === 'EVIDENCE_UNVERIFIED' &&
        evidenceCases.get('modified').decisionAfter.evidenceInvalid.length > 0,
      evidenceCases.get('modified')),
    check('removing the record from the persisted file cannot authorize an action',
      evidenceCaseRefused(evidenceCases.get('record-removed')) &&
        evidenceCases.get('record-removed').primaryReason === 'NO_APPLICABLE_KNOWLEDGE',
      evidenceCases.get('record-removed')),
    check('a stale execute decision is re-read and refused at action time',
      Boolean(actionTimeExpiry) &&
        actionTimeExpiry.decisionBeforeAction.decision === 'execute' &&
        actionTimeExpiry.actionTimeDecision.decision === 'refuse' &&
        actionTimeExpiry.actionTimeDecision.primaryReason === 'EXPIRED' &&
        actionTimeExpiry.refusedBy === 'KNOWLEDGE_NOT_ACTIONABLE' &&
        actionTimeExpiry.mutations.environmentWrites === 0 &&
        actionTimeExpiry.mutations.restarts === 0 &&
        actionTimeExpiry.unchanged === true,
      actionTimeExpiry),
    check('a post-write action failure keeps the applied change and records error evidence',
      Boolean(actionFailure) &&
        actionFailure.injected === 'restart-gateway-after-write' &&
        actionFailure.attempted.environmentWrites === 1 &&
        actionFailure.attempted.restarts === 1 &&
        actionFailure.gateCounts.environmentWrites === 1 &&
        actionFailure.gateCounts.restarts === 0 &&
        actionFailure.environmentChanged === true &&
        actionFailure.requestStatusAfter === 502 &&
        actionFailure.evidence?.path ===
          'evidence/knowledge/action-failure/restart-after-write.json',
      actionFailure),
    check('old conditions do not authorize actions on the changed artifact',
      changed.decision.decision === 'refuse' &&
        changed.decision.primaryReason === 'CONDITION_MISMATCH' &&
        changed.decision.unchanged === true &&
        knowledge.mutations.changedConditions.unauthorizedWrites === 0 &&
        changed.revalidation.requestStatusAfter === 200,
      { decision: changed.decision, revalidation: changed.revalidation }),
    check('appending a record for the new artifact changes the persisted gate to execution',
      changed.fileEffect.decisionBeforeAppend.decision === 'refuse' &&
        changed.fileEffect.decisionBeforeAppend.primaryReason === 'CONDITION_MISMATCH' &&
        changed.fileEffect.decisionAfterAppend.decision === 'execute' &&
        changed.fileEffect.decisionAfterAppend.primaryReason === null,
      changed.fileEffect),
    check('applicable verified knowledge authorizes exactly one write and restart',
      valid.decision.decision === 'execute' &&
        valid.mutations.environmentWrites === 1 &&
        valid.mutations.restarts === 1 &&
        valid.requestStatusAfter === 200,
      { decision: valid.decision, mutations: valid.mutations, after: valid.requestStatusAfter }),
    check('a separate process reads the same persisted knowledge and reaches the execute decision',
      valid.coldRead.source === 'separate-node-process' &&
        valid.coldRead.decision === valid.decision.decision &&
        valid.coldRead.primaryReason === valid.decision.primaryReason &&
        valid.coldRead.procedure === valid.decision.procedure &&
        JSON.stringify(valid.coldRead.authorizedBy) === JSON.stringify(valid.decision.authorizedBy) &&
        valid.coldRead.matchesInProcess === true,
      { cold: valid.coldRead, inProcess: valid.decision }),
    check('the authorized execution records an action-time re-read of the same file',
      Boolean(valid.revalidated) &&
        valid.revalidated.decision.decision === 'execute' &&
        valid.revalidated.context.artifactSha256 === expectedPayloadSha256 &&
        typeof valid.revalidated.actionTime === 'number',
      valid.revalidated),
    check('conflicting knowledge blocks, and observed refutation resolves it',
      conflict.conflictDecision.decision === 'refuse' &&
        conflict.conflictDecision.primaryReason === 'CONFLICT' &&
        conflict.conflictDecision.unchanged === true &&
        conflict.restartOnlyFailure.requestStatusAfter === 502 &&
        conflict.resolvedDecision.decision === 'execute' &&
        conflict.resolvedDecision.requestStatusAfter === 200 &&
        conflict.resolvedDecision.mutations.environmentWrites === 1 &&
        Boolean(conflict.resolvedDecision.revalidated) &&
        conflict.resolvedDecision.revalidated.decision.decision === 'execute' &&
        conflict.resolvedDecision.revalidated.context.artifactSha256 === expectedPayloadSha256,
      {
        conflict: conflict.conflictDecision,
        restartOnly: conflict.restartOnlyFailure,
        resolved: conflict.resolvedDecision,
      }),
    check('the real refutation changes the persisted file and releases the conflict gate',
      conflictFile.changed === true &&
        conflictFile.sha256Before !== conflictFile.sha256After &&
        conflictFile.decisionBefore.decision === 'refuse' &&
        conflictFile.decisionBefore.primaryReason === 'CONFLICT' &&
        conflictFile.decisionBefore.mutations.environmentWrites === 0 &&
        conflictFile.decisionBefore.mutations.restarts === 0 &&
        conflictFile.decisionBefore.unchanged === true &&
        conflictFile.decisionAfter.decision === 'execute' &&
        conflictFile.decisionAfter.primaryReason === null &&
        conflictFile.executionAfter.mutations.environmentWrites === 1 &&
        conflictFile.executionAfter.mutations.restarts === 1,
      conflictFile),
    check('knowledge conditions are bound to the delivered artifact',
      knowledge.artifactContext.artifactSha256 === expectedPayloadSha256,
      {
        observed: knowledge.artifactContext.artifactSha256,
        expected: expectedPayloadSha256,
      }),
  ];
  const evidenceFiles = knowledge.evidence.files.map(entry => entry.path);
  enforce('knowledge', checks, evidenceFiles);
  return {
    checks,
    costs: knowledge.costs,
    evidenceFiles,
    refusals: [
      { scenario: 'expired', primaryReason: expired.expiredDecision.primaryReason },
      { scenario: 'refuted-shortcut', primaryReason: expired.blockedShortcut.primaryReason },
      { scenario: 'persisted-edit', primaryReason: persistedEdit.decisionAfter.primaryReason },
      ...[...evidenceCases.entries()].map(([name, item]) => ({
        scenario: `evidence-${name}`,
        primaryReason: item.primaryReason,
      })),
      { scenario: 'action-time-expiry', primaryReason: actionTimeExpiry.actionTimeDecision.primaryReason },
      { scenario: 'changed-conditions', primaryReason: changed.decision.primaryReason },
      { scenario: 'conflict', primaryReason: conflict.conflictDecision.primaryReason },
    ],
  };
}

// ----------------------------------------------------------- stage six
async function inspectMapFiles(outputDirectory, maps, files) {
  const records = [];
  for (const map of maps) {
    let bytes = null;
    if (typeof map.file === 'string' && files.has(map.file)) {
      try {
        bytes = await readFile(join(outputDirectory, map.file));
      } catch {
        bytes = null;
      }
    }
    records.push({
      layer: map.layer ?? null,
      ok: map.ok === true &&
        bytes !== null &&
        Number.isInteger(map.byteLength) &&
        bytes.length === map.byteLength &&
        typeof map.sha256 === 'string' &&
        sha256(bytes) === map.sha256 &&
        bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    });
  }
  return records;
}

async function acceptExtension(workspace, extension, context) {
  const {
    changes, gisService, gis, knowledge, receiptFile, outputDirectory, runningReceiptFile,
  } = context;
  const files = new Set(Array.isArray(extension.files) ? extension.files : []);
  const requiredFiles = ['handoff.json', 'gateway.json', 'gis.json', 'knowledge.json', 'handoff.md'];
  const handoffDoc = await readJsonMaybe(join(outputDirectory, 'handoff.json'));
  const gatewayDoc = await readJsonMaybe(join(outputDirectory, 'gateway.json'));
  const gisDoc = await readJsonMaybe(join(outputDirectory, 'gis.json'));
  const knowledgeDoc = await readJsonMaybe(join(outputDirectory, 'knowledge.json'));
  const maps = Array.isArray(extension.facilities?.gis?.maps)
    ? extension.facilities.gis.maps
    : [];
  const mapChecks = await inspectMapFiles(outputDirectory, maps, files);

  const receiptBytes = await readFile(receiptFile).catch(() => null);
  const receiptSha256 = receiptBytes === null ? null : sha256(receiptBytes);
  const runningReceiptBytes = await readFile(runningReceiptFile).catch(() => null);
  const runningReceiptSha256 = runningReceiptBytes === null ? null : sha256(runningReceiptBytes);
  const knowledgeBytes = await readFile(knowledge.knowledge.file).catch(() => null);
  const targetEntry = workspace.lab.registry().find(entry => entry.role === changes.target.role);
  const facilities = extension.facilities ?? {};
  const decisions = Array.isArray(facilities.knowledge?.decisions)
    ? facilities.knowledge.decisions
    : [];
  const requiredPresent = requiredFiles.every(file => files.has(file));
  const control = extension.control;
  const controlOutputDirectory = typeof control?.outputDirectory === 'string'
    ? control.outputDirectory
    : null;
  const controlFiles = new Set(Array.isArray(control?.files) ? control.files : []);
  const controlMaps = Array.isArray(control?.facilities?.gis?.maps)
    ? control.facilities.gis.maps
    : [];
  const controlMapChecks = controlOutputDirectory === null
    ? []
    : await inspectMapFiles(controlOutputDirectory, controlMaps, controlFiles);
  const controlHandoff = controlOutputDirectory === null
    ? null
    : await readJsonMaybe(join(controlOutputDirectory, 'handoff.json'));
  const controlGateway = controlOutputDirectory === null
    ? null
    : await readJsonMaybe(join(controlOutputDirectory, 'gateway.json'));
  const controlGis = controlOutputDirectory === null
    ? null
    : await readJsonMaybe(join(controlOutputDirectory, 'gis.json'));
  const controlRequiredPresent = controlOutputDirectory !== null &&
    requiredFiles.every(file => controlFiles.has(file));
  const originalReceiptSha256 = extension.control?.originalReceiptSha256 ?? null;
  const checks = [
    check('the extension reports a ready operations handoff',
      extension.ok === true &&
        extension.status === 'ready' &&
        extension.handoffFile === 'handoff.json' &&
        extension.failureFile === null &&
        Array.isArray(extension.failures) &&
        extension.failures.length === 0 &&
        extension.outputDirectory === outputDirectory,
      {
        ok: extension.ok,
        status: extension.status,
        handoffFile: extension.handoffFile,
        failureFile: extension.failureFile,
        failures: extension.failures,
        outputDirectory: extension.outputDirectory,
      }),
    check('the handoff package contains its declared evidence and map files',
      requiredPresent &&
        maps.length > 0 &&
        maps.every(map => map.ok === true && typeof map.file === 'string' && files.has(map.file)),
      { requiredFiles, files: [...files], maps: mapChecks }),
    check('the gateway facility is live at the receipt address and instance',
      facilities.gateway?.ok === true &&
        facilities.gateway.url === changes.target.url &&
        facilities.gateway.instanceId === changes.target.instanceId &&
        facilities.gateway.checks?.total > 0 &&
        facilities.gateway.checks?.failed === 0 &&
        facilities.gateway.checks?.passed === facilities.gateway.checks?.total,
      facilities.gateway),
    check('the gateway evidence file binds the expected release and served payload',
      gatewayDoc?.ok === true &&
        gatewayDoc.endpoint?.url === changes.target.url &&
        gatewayDoc.endpoint?.instanceId === changes.target.instanceId &&
        gatewayDoc.expected?.payloadSha256 === changes.expected.payloadSha256 &&
        gatewayDoc.observations?.payload?.sha256 === changes.expected.payloadSha256 &&
        gatewayDoc.checks?.every(entry => entry.status === 'pass') === true,
      gatewayDoc),
    check('the GIS facility advertises live layers and one working map per layer',
      facilities.gis?.ok === true &&
        facilities.gis.url === gisService.url &&
        facilities.gis.instanceId === gisService.instanceId &&
        facilities.gis.layerCount > 0 &&
        facilities.gis.maps?.length === facilities.gis.layerCount &&
        facilities.gis.mapCount === facilities.gis.layerCount &&
        mapChecks.length === facilities.gis.layerCount &&
        mapChecks.every(entry => entry.ok === true),
      facilities.gis),
    check('the GIS evidence file re-reads capabilities and binds the same layers and maps',
      gisDoc?.ok === true &&
        gisDoc.endpoint?.url === gisService.url &&
        gisDoc.endpoint?.instanceId === gisService.instanceId &&
        gisDoc.layers?.length === facilities.gis?.layerCount &&
        gisDoc.maps?.length === facilities.gis?.layerCount &&
        gisDoc.capabilities?.xmlFile === 'gis/capabilities.xml' &&
        files.has('gis/capabilities.xml') &&
        gisDoc.checks?.every(entry => entry.status === 'pass') === true,
      gisDoc),
    check('the knowledge note marks eligible and refused procedures without authorizing repair',
      facilities.knowledge?.ok === true &&
        facilities.knowledge.contextComplete === true &&
        facilities.knowledge.recordCount > 0 &&
        decisions.some(decision => decision.decision === 'execute') &&
        decisions.some(decision => decision.decision === 'refuse') &&
        knowledgeDoc?.ok === true &&
        knowledgeDoc.contextComplete === true &&
        knowledgeDoc.policy?.automaticRepair === 'forbidden' &&
        Object.keys(knowledgeDoc.policy?.mutationsPerformed ?? {}).length > 0 &&
        Object.values(knowledgeDoc.policy?.mutationsPerformed ?? {}).every(value => value === 0) &&
        knowledgeDoc.currentIncident?.observed === 'gateway-upstream-ready' &&
        knowledgeDoc.currentIncident?.applicationNow === 'not-needed-healthy',
      {
        facility: facilities.knowledge,
        decisions,
        policy: knowledgeDoc?.policy,
        currentIncident: knowledgeDoc?.currentIncident,
      }),
    check('the handoff is bound to the receipt bytes that were supplied',
      receiptSha256 !== null &&
        runningReceiptSha256 === receiptSha256 &&
        extension.receipt?.sha256 === receiptSha256 &&
        handoffDoc?.receipt?.sha256 === receiptSha256 &&
        handoffDoc?.receipt?.expected?.payloadSha256 === changes.expected.payloadSha256 &&
        handoffDoc?.ok === true &&
        handoffDoc.status === 'ready',
      {
        receiptSha256,
        runningReceiptSha256,
        extensionReceipt: extension.receipt,
        handoffReceipt: handoffDoc?.receipt ?? null,
      }),
    check('the extension performed no writes or restarts on the live facilities',
      targetEntry?.instanceId === changes.target.instanceId &&
        targetEntry?.url === changes.target.url &&
        gis.gis.instanceId === gisService.instanceId &&
        gis.gis.url === gisService.url &&
        knowledgeBytes !== null &&
        sha256(knowledgeBytes) === knowledge.knowledge.sha256,
      {
        targetEntry: targetEntry ?? null,
        expectedTarget: changes.target,
        gisInstanceId: gis.gis.instanceId,
        expectedGisInstanceId: gisService.instanceId,
        knowledgeSha256: knowledgeBytes === null ? null : sha256(knowledgeBytes),
        expectedKnowledgeSha256: knowledge.knowledge.sha256,
      }),
    check('a modified expected payload yields not-ready while GIS evidence stays retained',
      control?.ok === false &&
        control.status === 'not-ready' &&
        control.facilities?.gateway?.ok === false &&
        (control.facilities?.gateway?.checks?.failed ?? 0) > 0 &&
        control.facilities?.gateway?.checks?.passed <
          control.facilities?.gateway?.checks?.total &&
        control.facilities?.gis?.ok === true &&
        control.facilities?.gis?.mapCount === control.facilities?.gis?.layerCount &&
        controlMaps.length === control.facilities?.gis?.layerCount &&
        controlMapChecks.length === controlMaps.length &&
        controlMapChecks.every(entry => entry.ok === true),
      {
        control: control ?? null,
        maps: controlMapChecks,
      }),
    check('the not-ready control retains its own gateway failure and GIS package files',
      controlRequiredPresent &&
        controlHandoff?.ok === false &&
        controlHandoff.status === 'not-ready' &&
        controlHandoff.retained?.gateway === false &&
        controlHandoff.retained?.gis === true &&
        control?.facilities?.gis?.maps?.every(map => controlFiles.has(map.file)) === true &&
        controlGateway?.ok === false &&
        controlGateway.checks?.some(entry => entry.status !== 'pass') === true &&
        controlGis?.ok === true &&
        controlGis.layers?.length === control.facilities?.gis?.layerCount &&
        controlGis.maps?.length === control.facilities?.gis?.layerCount,
      {
        controlHandoff: controlHandoff ?? null,
        controlGateway: controlGateway ?? null,
        controlGis: controlGis ?? null,
      }),
    check('the control receipt is distinct and the live receipt bytes stay unchanged',
      originalReceiptSha256 !== null &&
        control.receiptSha256 === control.receipt?.sha256 &&
        control.receiptSha256 !== originalReceiptSha256 &&
        receiptSha256 === originalReceiptSha256 &&
        extension.receipt?.sha256 === originalReceiptSha256 &&
        handoffDoc?.receipt?.sha256 === originalReceiptSha256,
      {
        originalReceiptSha256,
        currentReceiptSha256: receiptSha256,
        controlReceiptSha256: control?.receiptSha256 ?? null,
        goodReceipt: extension.receipt,
      }),
  ];

  const evidenceFiles = [...new Set([
    ...requiredFiles.map(file => evidencePath(workspace.directory, join(outputDirectory, file))),
    ...[...files].map(file => evidencePath(workspace.directory, join(outputDirectory, file))),
    ...requiredFiles.map(file => evidencePath(
      workspace.directory, join(controlOutputDirectory ?? outputDirectory, file),
    )),
    ...[...controlFiles].map(file => evidencePath(
      workspace.directory, join(controlOutputDirectory ?? outputDirectory, file),
    )),
    ...(typeof control?.receiptFile === 'string'
      ? [evidencePath(workspace.directory, control.receiptFile)]
      : []),
    evidencePath(workspace.directory, runningReceiptFile),
  ])];
  try {
    enforce('extension', checks, evidenceFiles);
  } catch (error) {
    error.extension = extension;
    throw error;
  }
  return {
    checks,
    costs: {
      layers: facilities.gis?.layerCount ?? 0,
      files: files.size,
      controlLayers: control?.facilities?.gis?.layerCount ?? 0,
      controlFiles: controlFiles.size,
    },
    evidenceFiles,
    failures: Array.isArray(extension.failures) ? extension.failures : [],
  };
}

// ------------------------------------------------------------- plumbing
function buildResult({
  workspace, initial, access, delivery, gisResult, changes, knowledge,
  stages, acceptanceFile, extension, extensionContext,
}) {
  return {
    accepted: stages.every(record => record.status === 'completed'),
    directory: workspace.directory,
    stages,
    initial,
    access,
    delivery,
    gis: {
      evidence: gisResult.evidence,
      service: {
        role: gisResult.gis.role,
        url: gisResult.gis.url,
        instanceId: gisResult.gis.instanceId,
        configSha256: gisResult.gis.configSha256,
        runningAtStageEnd: gisResult.gis.running,
      },
    },
    changes,
    knowledge,
    extension,
    extensionReceiptFile: extensionContext?.receiptFile ?? null,
    extensionRunningReceiptFile: extensionContext?.runningReceiptFile ?? null,
    extensionOutputDirectory: extensionContext?.outputDirectory ?? null,
    evidence: {
      acceptance: acceptanceFile ? evidencePath(workspace.directory, acceptanceFile) : null,
      stages: Object.fromEntries(stages.map(record => [record.name, record.evidence])),
      receipt: extensionContext
        ? evidencePath(workspace.directory, extensionContext.receiptFile)
        : null,
      runningReceipt: extensionContext
        ? evidencePath(workspace.directory, extensionContext.runningReceiptFile)
        : null,
    },
    resources: null,
  };
}

/**
 * The minimal public receipt consumed by live probes and the stage-six
 * extension. It never includes the lab, registry, closures, or evidence
 * internals.
 */
export function publicSessionInputs(result, status = 'running') {
  const changes = result.changes;
  return {
    schemaVersion: 1,
    status,
    directory: result.directory,
    delivery: {
      role: changes.target.role,
      url: changes.target.url,
      instanceId: changes.target.instanceId,
    },
    gis: {
      role: result.gis.service.role,
      url: result.gis.service.url,
      instanceId: result.gis.service.instanceId,
      configSha256: result.gis.service.configSha256,
    },
    expected: {
      release: changes.expected.release,
      sourceRevision: changes.expected.sourceRevision,
      payloadSha256: changes.expected.payloadSha256,
    },
    artifactDirectory: changes.artifact.artifactDir,
    updatedAt: new Date().toISOString(),
  };
}

export async function writeClosedReceipt(file, result, resources, reason = 'completed') {
  const document = {
    ...publicSessionInputs(result, 'closed'),
    closedAt: new Date().toISOString(),
    reason,
    resources,
  };
  await writeJson(file, document);
  return document;
}

async function writeAcceptance(workspace, stages, status, error, resources = null) {
  const file = join(workspace.directory, 'evidence', 'acceptance.json');
  const document = {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    directory: workspace.directory,
    stages,
    ...(resources ? { resources } : {}),
    ...(error
      ? {
        error: {
          ...summarizeError(error),
          failedChecks: error.failedChecks ?? null,
        },
      }
      : {}),
  };
  await writeJson(file, document);
  return file;
}

/**
 * Run stages zero through five and, when extensionRunner is supplied, stage
 * six, keeping resources alive. The caller must call close(). This is the
 * shared sequence behind runWorkspaceEvolution (with the extension) and
 * session.js (without it); it deliberately exposes no lab or service object
 * as a consumer contract.
 *
 * @param {{directory: string, extensionRunner?: Function|null}} options
 */
export async function openWorkspaceEvolution({ directory, extensionRunner = null } = {}) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new TypeError('directory must be a non-empty path');
  }
  if (extensionRunner !== null && typeof extensionRunner !== 'function') {
    throw new TypeError('extensionRunner must be a function when supplied');
  }
  const root = resolve(directory);

  const stages = [];
  let workspace = null;
  let gisResult = null;
  let changes = null;
  let extensionContext = null;
  let closing = null;

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      let gisClosed = gisResult ? false : null;
      let workspaceClosed = workspace ? false : null;
      if (gisResult) {
        try {
          await gisResult.close();
          gisClosed = true;
          gisResult.evidence.service.closedByRunner = true;
        } catch (error) {
          errors.push({ resource: 'gis', ...summarizeError(error) });
        }
      }
      if (workspace) {
        try {
          await workspace.close();
          workspaceClosed = true;
        } catch (error) {
          errors.push({ resource: 'workspace', ...summarizeError(error) });
        }
      }
      return {
        closed: errors.length === 0 && gisClosed !== false && workspaceClosed !== false,
        gisClosed,
        workspaceClosed,
        errors,
      };
    })();
    return closing;
  }

  async function runStage(stage, action, accept) {
    const record = {
      stage,
      name: STAGE_NAMES[stage],
      startedAt: new Date().toISOString(),
    };
    stages.push(record);
    const startedAt = Date.now();
    try {
      const value = await action();
      const outcome = await accept(value);
      record.status = 'completed';
      record.durationMs = Date.now() - startedAt;
      record.costs = outcome.costs ?? null;
      record.evidence = outcome.evidenceFiles ?? [];
      record.checks = outcome.checks ?? [];
      if (outcome.failures !== undefined) record.failures = outcome.failures;
      if (outcome.refusals !== undefined) record.refusals = outcome.refusals;
      return value;
    } catch (error) {
      record.status = 'failed';
      record.durationMs = Date.now() - startedAt;
      record.error = summarizeError(error);
      if (Array.isArray(error.checks)) {
        record.checks = error.checks;
        record.failedChecks = error.failedChecks ?? error.checks.filter(item => !item.ok);
      }
      if (Array.isArray(error.evidenceFiles)) record.evidence = error.evidenceFiles;
      throw error;
    }
  }

  try {
    workspace = await createWorkspace({ directory: root });

    const initial = await runStage(
      0,
      () => observeInitialState(workspace),
      value => value,
    );
    const access = await runStage(
      1,
      () => runAccessEvolution(workspace),
      value => acceptAccess(workspace, value),
    );
    const delivery = await runStage(
      2,
      () => runDeliveryEvolution(workspace),
      value => acceptDelivery(workspace, value),
    );
    const gis = await runStage(
      3,
      () => runGisEvolution({ directory: join(root, 'gis'), keepRunning: true }),
      value => {
        // Keep the handle even if acceptance throws after collection.
        gisResult = value;
        return acceptGis(workspace, value);
      },
    );
    changes = await runStage(
      4,
      () => runChanges({ workspace, delivery, gis: gis.gis }),
      value => acceptChanges(workspace, value),
    );
    const knowledge = await runStage(
      5,
      () => runKnowledgeEvolution({ workspace, delivery, gis: gis.gis, changes }),
      value => acceptKnowledge(value, changes.artifact.payloadSha256),
    );

    let extension = null;
    if (extensionRunner) {
      const gisService = {
        role: gis.gis.role,
        url: gis.gis.url,
        instanceId: gis.gis.instanceId,
        configSha256: gis.gis.configSha256,
      };
      const receiptFile = join(root, 'session-receipt.json');
      const outputDirectory = join(root, 'handoff');
      const runningReceiptFile = join(root, 'evidence', 'stage6-running-receipt.json');
      await writeJson(receiptFile, publicSessionInputs({
        directory: root,
        changes,
        gis: { service: gisService },
      }, 'running'));
      await copyFile(receiptFile, runningReceiptFile);
      extensionContext = { receiptFile, outputDirectory, runningReceiptFile, gisService };
      extension = await runStage(
        6,
        async () => {
          const good = await extensionRunner({ receiptFile, outputDirectory });
          const originalReceiptBytes = await readFile(receiptFile);
          const controlDocument = JSON.parse(originalReceiptBytes.toString('utf8'));
          controlDocument.expected = {
            ...(controlDocument.expected ?? {}),
            payloadSha256: '0'.repeat(64),
          };
          const controlReceiptFile = join(root, 'evidence', 'stage6-fault-receipt.json');
          await writeJson(controlReceiptFile, controlDocument);
          const controlOutputDirectory = join(root, 'handoff-fault');
          const control = await extensionRunner({
            receiptFile: controlReceiptFile,
            outputDirectory: controlOutputDirectory,
          });
          return {
            ...good,
            control: {
              ...control,
              receiptFile: controlReceiptFile,
              outputDirectory: controlOutputDirectory,
              receiptSha256: sha256(await readFile(controlReceiptFile)),
              originalReceiptSha256: sha256(originalReceiptBytes),
            },
          };
        },
        value => acceptExtension(workspace, value, {
          changes, gisService, gis, knowledge, receiptFile, outputDirectory, runningReceiptFile,
        }),
      );
    }

    const acceptanceFile = await writeAcceptance(workspace, stages, 'completed');
    const result = buildResult({
      workspace,
      initial,
      access,
      delivery,
      gisResult,
      changes,
      knowledge,
      stages,
      acceptanceFile,
      extension,
      extensionContext,
    });
    result.resources = { closed: false, gisClosed: false, workspaceClosed: false, errors: [] };
    const finalize = resources => writeAcceptance(workspace, stages, 'completed', null, resources);
    return { directory: root, result, acceptanceFile, close, finalize };
  } catch (error) {
    error.resources = await close();
    if (extensionContext?.receiptFile && changes) {
      try {
        await writeClosedReceipt(
          extensionContext.receiptFile,
          { directory: root, changes, gis: { service: extensionContext.gisService } },
          error.resources,
          'failed',
        );
      } catch (writeError) {
        error.receiptWriteError = summarizeError(writeError);
      }
    }
    if (workspace) {
      try {
        error.acceptanceFile = await writeAcceptance(workspace, stages, 'failed', error, error.resources);
      } catch (writeError) {
        error.acceptanceWriteError = summarizeError(writeError);
      }
    }
    throw error;
  }
}

/**
 * Default acceptance entry point. Opens and runs stages zero through six,
 * closes every resource, and returns the ordered record. A directory supplied
 * by the caller is never deleted; a self-created temporary directory is kept
 * only when keepArtifacts is true or the run failed.
 *
 * @param {{directory?: string, keepArtifacts?: boolean}} options
 */
export async function runWorkspaceEvolution({ directory, keepArtifacts = false } = {}) {
  if (directory !== undefined &&
      (typeof directory !== 'string' || directory.trim().length === 0)) {
    throw new TypeError('directory must be a non-empty path when supplied');
  }
  const ownsDirectory = directory === undefined;
  let root = directory;
  if (ownsDirectory) {
    await mkdir(join(ROOT, 'temp'), { recursive: true });
    root = await mkdtemp(join(ROOT, 'temp', 'workspace-evolution-'));
  }

  let completed = false;
  try {
    const handle = await openWorkspaceEvolution({
      directory: root,
      extensionRunner: runAgentExtension,
    });
    const report = await handle.close();
    handle.result.resources = report;
    handle.result.retained = ownsDirectory ? keepArtifacts : true;
    if (handle.result.extensionReceiptFile) {
      await writeClosedReceipt(
        handle.result.extensionReceiptFile,
        handle.result,
        report,
        report.closed ? 'completed' : 'close-error',
      );
    }
    await handle.finalize(report);
    if (!report.closed) {
      const error = new Error(
        `workspace resources did not close cleanly: ${report.errors.map(item => item.message).join('; ')}`,
      );
      error.code = 'WORKSPACE_CLOSE_FAILED';
      error.resources = report;
      error.result = handle.result;
      throw error;
    }
    completed = true;
    return handle.result;
  } finally {
    if (ownsDirectory && !keepArtifacts && completed) {
      await rm(resolve(root), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.startsWith('--')) {
    throw new Error(`${name} requires a path value`);
  }
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(MODULE_FILE)) {
  try {
    const cliDirectory = readFlag(process.argv.slice(2), '--directory');
    const result = await runWorkspaceEvolution({
      ...(cliDirectory ? { directory: cliDirectory } : {}),
      keepArtifacts: true,
    });
    process.stdout.write(`${JSON.stringify({
      accepted: result.accepted,
      directory: result.directory,
      retained: result.retained,
      resources: result.resources,
      stages: result.stages.map(record => ({
        stage: record.stage,
        name: record.name,
        status: record.status,
        durationMs: record.durationMs,
        evidence: record.evidence,
      })),
      evidence: result.evidence,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: summarizeError(error),
      failedChecks: error.failedChecks ?? null,
      acceptanceFile: error.acceptanceFile ?? null,
      resources: error.resources ?? null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
