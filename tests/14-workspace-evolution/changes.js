/**
 * Stage 4: change existing facilities (source/artifact, delivery target,
 * GIS configuration and address) and keep existing consumers honest.
 *
 * The stage uses the existing Git worktree, delivery pipeline, operations lab
 * and WMS client. It adds no registry or revision abstraction. Details stay in
 * the evidence files; the return value is a compact summary for assertions.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { assessRelease, readGitSource } from '@locus/deployment-audit';
import { inspectGateway, inspectGatewayFromHandoff } from './access.js';
import { gatewayConsumers, inspectSource } from './consumers.js';
import { runDeliveryEvolution } from './delivery.js';
import { getCapabilities, getMap } from './gis.js';

const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function portablePath(path) {
  return path.split(sep).join('/');
}

async function saveEvidence(root, relativePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(root, ...relativePath.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: relativePath, sha256: sha256(Buffer.from(content, 'utf8')) };
}

async function capture(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        code: typeof error?.code === 'string' ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function captureStatus(result) {
  return result.ok
    ? { ok: true, instanceId: result.value?.instanceId ?? null, requestStatus: result.value?.requestStatus ?? null }
    : { ok: false, error: result.error };
}

function failedChecks(checks) {
  return checks.filter(check => check.status !== 'pass')
    .map(check => ({ id: check.id, status: check.status, reason: check.reason }));
}

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', root,
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      ...args,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`, { cause: error });
  }
}

function summarizeCapabilities(result) {
  const parsed = result.capabilities;
  return {
    ok: result.ok,
    status: result.status,
    sha256: result.sha256 ?? null,
    version: parsed?.version ?? null,
    serviceTitle: parsed?.serviceTitle ?? null,
    layers: parsed?.layers?.map(layer => layer.name) ?? [],
  };
}

function summarizeMap(result) {
  return {
    ok: result.ok,
    status: result.status,
    contentType: result.contentType,
    sha256: result.sha256 ?? null,
    image: result.image
      ? { width: result.image.width, height: result.image.height, dimensionMatches: result.image.dimensionMatches }
      : null,
    exception: result.exception ?? null,
    problem: result.problem ?? null,
  };
}

async function captureGis(gis) {
  const config = await gis.readConfig();
  const capabilities = await getCapabilities(gis.url);
  if (!capabilities.ok) {
    throw new Error(`GIS capabilities were not readable at the current address: ${JSON.stringify(capabilities.error)}`);
  }
  const layer = config.layers[0].name;
  const bbox = [config.bounds.south, config.bounds.west, config.bounds.north, config.bounds.east];
  const width = Math.min(128, config.maxWidth);
  const height = Math.min(128, config.maxHeight);
  const map = await getMap(gis.url, { layers: layer, bbox, width, height });
  return {
    url: gis.url,
    instanceId: gis.instanceId,
    configSha256: gis.configSha256,
    config,
    layer,
    bbox,
    request: { width, height, crs: 'EPSG:4326', version: '1.3.0' },
    capabilities: summarizeCapabilities(capabilities),
    map: summarizeMap(map),
    mapOk: map.ok === true,
  };
}

async function captureConsumers(workspace) {
  const directory = workspace.directory;
  // Existing consumer factory. Only the wiring differs: the direct consumer
  // reads the retired service.json; the handoff consumer reads the operations
  // handoff issued by stage one.
  const direct = gatewayConsumers(inspectGateway);
  const handoffFile = workspace.paths?.handoffFile
    ?? join(directory, 'operations', 'access-handoff.json');
  const handoff = gatewayConsumers(input =>
    inspectGatewayFromHandoff(input, { handoffFile }));
  return {
    directOverview: await capture(() => direct.overview(directory)),
    handoffOverview: await capture(() => handoff.overview(directory)),
    handoffVerify: await capture(() => handoff.verify(directory)),
    source: await capture(() => inspectSource(directory)),
  };
}

// A real commit advances HEAD. No marker text is inspected or used as a gate;
// each call appends one comment and commits it.
async function advanceSource(workspace) {
  if (typeof workspace.sourceDir !== 'string' || workspace.sourceDir.length === 0) {
    throw new TypeError('workspace.sourceDir is required');
  }
  const sourceDir = workspace.sourceDir;
  const worker = join(sourceDir, 'worker.mjs');
  const before = await readFile(worker, 'utf8');
  const marker = `// workspace-evolution: source revision at ${new Date().toISOString()}`;
  await writeFile(worker, before.endsWith('\n') ? `${before}${marker}\n` : `${before}\n${marker}\n`, 'utf8');
  await git(sourceDir, ['add', '-f', '--', 'worker.mjs']);
  await git(sourceDir, [
    'commit', '--quiet', '--no-verify', '--no-gpg-sign',
    '-m', 'test: advance source for facility evolution',
  ]);
  return readGitSource(sourceDir);
}

/**
 * @param {{workspace: object, delivery: object, gis: object}} input
 */
export async function runChanges({ workspace, delivery, gis } = {}) {
  if (!isRecord(workspace) || !isRecord(workspace.lab)) {
    throw new TypeError('workspace with an operations lab is required');
  }
  if (!isRecord(delivery) || !isRecord(delivery.artifact) || !isRecord(delivery.target) ||
      typeof delivery.verify !== 'function') {
    throw new TypeError('delivery from runDeliveryEvolution is required');
  }
  if (!isRecord(gis) || typeof gis.readConfig !== 'function' || typeof gis.restart !== 'function') {
    throw new TypeError('a live gis closure from startGis is required for stage 4');
  }

  const root = workspace.directory;
  const evidenceFiles = [];
  const failures = [];
  const rechecks = [];

  async function recordEvidence(relativePath, value) {
    const entry = await saveEvidence(root, relativePath, value);
    evidenceFiles.push(entry);
    return entry;
  }

  // ------------------------------------------------------------ baseline
  const baselineSource = await inspectSource(root);
  if (baselineSource.dirty !== false) {
    throw new Error('source worktree must be clean before the source change');
  }
  const baselineDelivery = await delivery.verify();
  if (!baselineDelivery.ok) {
    throw new Error(`baseline delivery verification is not current: ${JSON.stringify(baselineDelivery.mismatches)}`);
  }
  const baselineTarget = await workspace.lab.observe(delivery.target.role);
  const baselineConsumers = await captureConsumers(workspace);
  if (!baselineConsumers.handoffVerify.ok) {
    throw new Error('the existing handoff consumer cannot verify the baseline access entry');
  }
  const baselineGis = await captureGis(gis);
  if (!baselineGis.mapOk) throw new Error('baseline GIS map request failed');
  const baselineEvidence = await recordEvidence('evidence/changes/baseline.json', {
    capturedAt: new Date().toISOString(),
    source: baselineSource,
    delivery: {
      ok: baselineDelivery.ok,
      verdict: baselineDelivery.verdict,
      target: delivery.target,
      expected: delivery.expected,
      runtime: baselineTarget.runtime,
    },
    access: {
      handoff: baselineConsumers.handoffVerify.value,
      handoffFile: workspace.paths?.handoffFile ?? null,
    },
    gis: baselineGis,
  });
  if (baselineConsumers.directOverview.ok) {
    throw new Error('the retired direct consumer unexpectedly succeeded; access evolution is not observable');
  }
  failures.push({
    reference: 'service.json direct baseUrl',
    status: 'still-failed-from-stage-one',
    observed: baselineConsumers.directOverview.error,
  });

  // ------------------------------------ change 1: source and artifact
  const sourceAfter = await advanceSource(workspace);
  if (sourceAfter.revision === baselineSource.revision) {
    throw new Error('source revision did not change');
  }
  if (sourceAfter.dirty !== false) throw new Error('source worktree is dirty after the evolution commit');
  const sourceConsumerAfter = await inspectSource(root);
  if (sourceConsumerAfter.revision !== sourceAfter.revision || sourceConsumerAfter.syntax !== 'valid') {
    throw new Error('inspectSource did not re-read the new source revision');
  }
  const staleDelivery = await delivery.verify();
  // Do not treat the moved checkout as evidence that the old target broke.
  // delivery.verify() is expected to keep validating expected A against
  // runtime A; whether A is still the current worktree is a separate fact.
  const sourceFreshness = {
    oldExpectedRevision: delivery.expected.sourceRevision,
    currentWorktreeRevision: sourceAfter.revision,
    oldReferenceIsCurrent: delivery.expected.sourceRevision === sourceAfter.revision,
    deliveryVerifyResult: {
      ok: staleDelivery.ok,
      verdict: staleDelivery.verdict,
      liveSource: staleDelivery.liveSource ?? null,
    },
  };
  failures.push({
    reference: 'source revision referenced by old delivery evidence',
    status: 'stale-against-current-worktree',
    observed: {
      expectedRevision: delivery.expected.sourceRevision,
      currentRevision: sourceAfter.revision,
      oldTargetStillConsistentWithOldArtifact: true,
    },
    note: 'the old target and its expected A remain consistent; only the checkout moved to B. '
      + 'Freshness is reported separately and is not a target-health verdict.',
  });

  // Re-run the existing pipeline with a fresh role. It builds from the current
  // worktree and verifies the new target independently.
  const evolvedDelivery = await runDeliveryEvolution(workspace, { role: 'evolution-target' });
  const evolvedVerify = await evolvedDelivery.verify();
  if (!evolvedVerify.ok) {
    throw new Error(`the redelivered target did not verify: ${JSON.stringify(evolvedVerify.mismatches)}`);
  }
  const evolvedTargetObservation = await workspace.lab.observe(evolvedDelivery.target.role);
  const oldTargetObservation = await workspace.lab.observe(delivery.target.role);
  const oldTargetRegistry = workspace.lab.registry().find(item => item.role === delivery.target.role);
  const oldArtifact = delivery.artifact;
  const newArtifact = evolvedDelivery.artifact;
  if (newArtifact.payloadSha256 === oldArtifact.payloadSha256) {
    throw new Error('the rebuild produced the same payload; artifact evolution is not observable');
  }

  const labelOnly = {
    releaseEqual: oldArtifact.release === newArtifact.release,
    sourceRevisionEqual: oldArtifact.sourceRevision === newArtifact.sourceRevision,
    payloadEqual: oldArtifact.payloadSha256 === newArtifact.payloadSha256,
    labelAloneSufficient: false,
  };
  // Same old target identity, new artifact, old runtime: release labels agree
  // while content evidence does not.
  const mixedAudit = assessRelease({
    expected: delivery.expected,
    artifact: {
      release: newArtifact.release,
      sourceRevision: newArtifact.sourceRevision,
      payloadSha256: newArtifact.payloadSha256,
      buildSource: newArtifact.buildSource,
    },
    runtime: oldTargetObservation.runtime,
  });
  // The case the verifier contract must expose: new expected B, new artifact
  // B, but the old runtime A. Identity and labels can still look plausible;
  // source revision and payload binding do not.
  const mixedNewExpectedOldRuntime = assessRelease({
    expected: evolvedDelivery.expected,
    artifact: {
      release: newArtifact.release,
      sourceRevision: newArtifact.sourceRevision,
      payloadSha256: newArtifact.payloadSha256,
      buildSource: newArtifact.buildSource,
    },
    runtime: oldTargetObservation.runtime,
  });
  const oldSelfAudit = assessRelease({
    expected: delivery.expected,
    artifact: {
      release: oldArtifact.release,
      sourceRevision: oldArtifact.sourceRevision,
      payloadSha256: oldArtifact.payloadSha256,
      buildSource: oldArtifact.buildSource,
    },
    runtime: oldTargetObservation.runtime,
  });
  const newAudit = assessRelease({
    expected: evolvedDelivery.expected,
    artifact: {
      release: newArtifact.release,
      sourceRevision: newArtifact.sourceRevision,
      payloadSha256: newArtifact.payloadSha256,
      buildSource: newArtifact.buildSource,
    },
    runtime: evolvedTargetObservation.runtime,
  });
  if (mixedAudit.verdict !== 'mismatch' ||
      mixedNewExpectedOldRuntime.verdict !== 'mismatch' ||
      oldSelfAudit.verdict !== 'consistent' ||
      newAudit.verdict !== 'consistent') {
    throw new Error('release audits did not distinguish the stale reference from internally consistent targets');
  }
  const sameTargetIdentity = {
    instanceIdUnchanged: oldTargetRegistry?.instanceId === delivery.target.instanceId,
    urlUnchanged: oldTargetRegistry?.url === delivery.target.url,
    sourceRevisionChanged: oldArtifact.sourceRevision !== newArtifact.sourceRevision,
  };
  if (!sameTargetIdentity.instanceIdUnchanged || !sameTargetIdentity.urlUnchanged) {
    throw new Error('the old delivery target changed identity without an intentional restart');
  }
  const auditResults = {
    mixedNewExpectedOldRuntime: {
      verdict: mixedNewExpectedOldRuntime.verdict,
      failed: failedChecks(mixedNewExpectedOldRuntime.checks),
    },
    mixedOldExpectedNewArtifactOldRuntime: {
      verdict: mixedAudit.verdict,
      failed: failedChecks(mixedAudit.checks),
    },
    oldWorldSelfConsistent: {
      verdict: oldSelfAudit.verdict,
      failed: failedChecks(oldSelfAudit.checks),
    },
    newWorldSelfConsistent: {
      verdict: newAudit.verdict,
      failed: failedChecks(newAudit.checks),
    },
  };
  const sourceChange = {
    sourceBefore: baselineSource,
    sourceAfter,
    sourceConsumer: sourceConsumerAfter,
    sourceFreshness,
    oldDelivery: {
      ok: staleDelivery.ok,
      verdict: staleDelivery.verdict,
      failed: failedChecks(staleDelivery.checks),
      expectedRevision: delivery.expected.sourceRevision,
      currentRevision: sourceAfter.revision,
      note: 'verify() is about expected A vs runtime A; source freshness is a separate observation',
    },
    artifact: {
      old: {
        release: oldArtifact.release,
        sourceRevision: oldArtifact.sourceRevision,
        payloadSha256: oldArtifact.payloadSha256,
      },
      new: {
        release: newArtifact.release,
        sourceRevision: newArtifact.sourceRevision,
        payloadSha256: newArtifact.payloadSha256,
      },
      labelOnly,
    },
    target: {
      old: { role: delivery.target.role, url: delivery.target.url, instanceId: delivery.target.instanceId },
      new: { role: evolvedDelivery.target.role, url: evolvedDelivery.target.url, instanceId: evolvedDelivery.target.instanceId },
      sameTargetIdentity,
    },
    audits: auditResults,
    verification: { ok: evolvedVerify.ok, verdict: evolvedVerify.verdict, failed: failedChecks(evolvedVerify.checks) },
  };
  const sourceEvidence = await recordEvidence('evidence/changes/source-artifact.json', sourceChange);
  rechecks.push(
    'source HEAD and syntax must be re-read (inspectSource)',
    'source freshness must be compared separately; delivery verify() continues to validate the expected artifact against its runtime',
    'the new target runtime payload must be observed directly, not copied from delivery evidence',
    'release label equality is not a substitute for sourceRevision/payload comparison',
  );

  // ----------------------------------------- change 2: target identity
  if (evolvedDelivery.target.instanceId === delivery.target.instanceId ||
      evolvedDelivery.target.url === delivery.target.url) {
    throw new Error('the fresh delivery target did not provide a distinct address/instance');
  }
  const targetEvidence = await recordEvidence('evidence/changes/target.json', {
    previous: {
      role: delivery.target.role,
      url: delivery.target.url,
      instanceId: delivery.target.instanceId,
      runtime: oldTargetObservation.runtime,
      stillConsistentWithOldArtifact: oldSelfAudit.verdict === 'consistent',
    },
    current: {
      role: evolvedDelivery.target.role,
      url: evolvedDelivery.target.url,
      instanceId: evolvedDelivery.target.instanceId,
      runtime: evolvedTargetObservation.runtime,
    },
    note: 'a new delivery role was required; reusing the old role would mix two artifacts and identities',
  });
  rechecks.push(
    'consumers must use the target identity returned by the new delivery, not the previous role/instance',
    'the old target runtime is evidence only for the old artifact',
  );

  // ------------------------------------ change 3: GIS config and address
  const configBefore = await gis.readConfig();
  const oldUrl = gis.url;
  const oldInstance = gis.instanceId;
  const oldLayer = configBefore.layers[0].name;
  const newLayer = `${oldLayer}-rev2`;
  const patch = {
    title: `${configBefore.title} (evolved)`,
    layers: configBefore.layers.map((layer, index) =>
      index === 0 ? { ...layer, name: newLayer } : layer),
  };
  const configWrite = await gis.updateConfig(patch);
  const beforeRestartCaps = await getCapabilities(gis.url);
  if (!beforeRestartCaps.ok ||
      beforeRestartCaps.capabilities?.serviceTitle !== baselineGis.capabilities.serviceTitle) {
    throw new Error('the GIS config write changed the running service before restart');
  }
  await gis.restart();
  const newUrl = gis.url;
  const newInstance = gis.instanceId;
  if (newUrl === oldUrl) throw new Error('GIS restart reused the retired address');
  if (newInstance === oldInstance) throw new Error('GIS restart reused the instance id');
  const oldUrlProbe = await getCapabilities(oldUrl);
  if (oldUrlProbe.ok) throw new Error('the retired GIS address still answered capabilities');
  const afterCaps = await getCapabilities(newUrl);
  if (!afterCaps.ok) throw new Error(`GIS capabilities were not readable after restart: ${JSON.stringify(afterCaps.error)}`);
  const layerNamesAfter = afterCaps.capabilities.layers.map(layer => layer.name);
  if (!layerNamesAfter.includes(newLayer) || layerNamesAfter.includes(oldLayer)) {
    throw new Error('the new capabilities do not expose the renamed layer');
  }
  if (afterCaps.capabilities.serviceTitle !== patch.title) {
    throw new Error('the new capabilities do not expose the updated title');
  }
  const mapBbox = [configBefore.bounds.south, configBefore.bounds.west,
    configBefore.bounds.north, configBefore.bounds.east];
  const mapWidth = baselineGis.request.width;
  const mapHeight = baselineGis.request.height;
  const oldLayerMap = await getMap(newUrl, {
    layers: oldLayer, bbox: mapBbox, width: mapWidth, height: mapHeight,
  });
  if (oldLayerMap.ok || !oldLayerMap.exception) {
    throw new Error('the old GIS layer reference was not rejected as a protocol error');
  }
  const newLayerMap = await getMap(newUrl, {
    layers: newLayer, bbox: mapBbox, width: mapWidth, height: mapHeight,
  });
  if (!newLayerMap.ok) throw new Error(`the new GIS layer reference did not produce a map: ${newLayerMap.problem ?? 'unknown'}`);
  const gisChange = {
    before: {
      url: oldUrl,
      instanceId: oldInstance,
      configSha256: baselineGis.configSha256,
      capabilities: baselineGis.capabilities,
      layer: oldLayer,
      map: baselineGis.map,
    },
    configWrite: {
      configSha256: configWrite.configSha256,
      requiresRestart: configWrite.requiresRestart,
      changed: configWrite.configSha256 !== baselineGis.configSha256,
    },
    runningBeforeRestart: summarizeCapabilities(beforeRestartCaps),
    after: {
      url: newUrl,
      instanceId: newInstance,
      configSha256: gis.configSha256,
      capabilities: summarizeCapabilities(afterCaps),
      layer: newLayer,
      map: summarizeMap(newLayerMap),
    },
    oldReferences: {
      address: { ok: oldUrlProbe.ok, status: oldUrlProbe.status, error: oldUrlProbe.error },
      layer: {
        ok: oldLayerMap.ok,
        status: oldLayerMap.status,
        exception: oldLayerMap.exception,
      },
    },
  };
  const gisEvidence = await recordEvidence('evidence/changes/gis.json', gisChange);
  failures.push(
    { reference: 'GIS old address', status: 'failed-after-restart', observed: gisChange.oldReferences.address },
    { reference: `GIS layer ${oldLayer}`, status: 'rejected-by-new-service', observed: gisChange.oldReferences.layer },
  );
  rechecks.push(
    'GIS capabilities/layers, not the previous response, must be used after a config change',
    'the old GIS URL must not be retried as if the service were still there',
  );

  // -------------------------------------------- post-change consumers
  const afterConsumers = await captureConsumers(workspace);
  if (!afterConsumers.handoffVerify.ok) {
    throw new Error('the existing handoff consumer stopped verifying after the changes');
  }
  if (afterConsumers.directOverview.ok) {
    throw new Error('the retired direct consumer unexpectedly recovered');
  }
  const consumers = {
    gatewayHandoff: {
      before: captureStatus(baselineConsumers.handoffVerify),
      after: captureStatus(afterConsumers.handoffVerify),
      verdict: 'continues; it re-reads the handoff and the live instance',
    },
    gatewayDirect: {
      before: captureStatus(baselineConsumers.directOverview),
      after: captureStatus(afterConsumers.directOverview),
      verdict: 'still fails; the retired direct address is not rewritten',
    },
    sourceInspector: {
      before: { revision: baselineSource.revision, dirty: baselineSource.dirty, syntax: baselineSource.syntax },
      after: afterConsumers.source.ok
        ? {
          revision: afterConsumers.source.value.revision,
          dirty: afterConsumers.source.value.dirty,
          syntax: afterConsumers.source.value.syntax,
        }
        : { ok: false, error: afterConsumers.source.error },
      verdict: 'continues only by re-reading Git HEAD; the old revision is stale',
    },
    deliveryVerifier: {
      before: { ok: baselineDelivery.ok, verdict: baselineDelivery.verdict },
      afterSourceChange: {
        ok: staleDelivery.ok,
        verdict: staleDelivery.verdict,
        failed: failedChecks(staleDelivery.checks),
        expectedRevision: delivery.expected.sourceRevision,
        currentRevision: sourceAfter.revision,
      },
      afterRedelivery: { ok: evolvedVerify.ok, verdict: evolvedVerify.verdict },
      verdict: 'verify keeps validating expected A against runtime A; source freshness is reported separately, '
        + 'and a fresh target supplies evidence for B',
    },
    gisCapabilities: {
      before: baselineGis.capabilities,
      after: gisChange.after.capabilities,
      verdict: 'must re-read capabilities after the config/address change',
    },
    gisMap: {
      before: { ok: baselineGis.mapOk, sha256: baselineGis.map.sha256, image: baselineGis.map.image },
      oldLayerReference: gisChange.oldReferences.layer,
      after: { ok: gisChange.after.map.ok, sha256: gisChange.after.map.sha256, image: gisChange.after.map.image },
      verdict: 'the old layer name fails; the new layer name comes from fresh capabilities',
    },
  };

  const costs = {
    sourceCommits: 1,
    buildsThroughExistingPipeline: 1,
    deliveryTargetsStarted: 1,
    gisConfigWrites: 1,
    gisRestarts: 1,
    consumerCodeFilesChanged: 0,
    consumerDataReferencesUpdated: ['source revision', 'delivery target role/url/instance', 'GIS url/layer'],
    manualAssociations: [
      'map the old delivery expected revision to the new source HEAD and decide which is authoritative',
      'name the new delivery target role and pass its identity to later consumers',
      're-read GIS capabilities to obtain the renamed layer; no code can infer it from the old request',
    ],
    discoveryEntryPoints: [
      'workspace.paths.handoffFile and inspectGatewayFromHandoff',
      'delivery.verify() failed checks and the evolved target/expected',
      'gis closure url/instanceId/configSha256 and getCapabilities',
    ],
    newStateAndOwnership: [
      'Git HEAD moved; every consumer that caches a revision must re-read it',
      'a second target role exists and must be used for current delivery checks',
      'the GIS process changed address and instance; old observations cannot be reused',
    ],
    observedDurationsMs: {
      baselineDeliveryVerify: baselineDelivery.costs?.verifyMs ?? null,
      staleDeliveryVerify: staleDelivery.costs?.verifyMs ?? null,
      evolvedDeliveryVerify: evolvedVerify.costs?.verifyMs ?? null,
    },
  };
  const sharing = {
    reused: [
      '@locus/deployment-audit assessRelease/readGitSource for independent content evidence',
      'the existing lab build/startGateway primitives',
      'the stage-two delivery pipeline for rebuild and fresh-target verification',
      'the stage-one access handoff and existing consumer factory (no consumer code edited)',
      'the existing WMS client for capabilities and map protocol observations',
    ],
    notShared: [
      'No new change/registry/revision abstraction was introduced. This stage has one workspace and '
      + 'one set of facilities; a shared evolution API would only wrap the existing public functions.',
      'The release label was not rewritten and no parallel version state was added.',
    ],
    candidate: null,
  };

  const summary = await recordEvidence('evidence/changes/summary.json', {
    generatedAt: new Date().toISOString(),
    baseline: baselineEvidence,
    sourceChange: sourceEvidence,
    targetChange: targetEvidence,
    gisChange: gisEvidence,
    failures,
    rechecks,
    consumers,
    costs,
    sharing,
  });

  return {
    // Stage five consumes these.
    artifact: newArtifact,
    target: evolvedDelivery.target,
    expected: evolvedDelivery.expected,
    source: sourceAfter,
    // Compact assertions; full details are in evidence.files.
    baseline: {
      source: baselineSource,
      delivery: { target: delivery.target, expected: delivery.expected, ok: baselineDelivery.ok },
      access: {
        handoffInstanceId: baselineConsumers.handoffVerify.value?.instanceId ?? null,
        directErrorCode: baselineConsumers.directOverview.error?.code ?? null,
      },
      gis: {
        url: baselineGis.url,
        instanceId: baselineGis.instanceId,
        capabilities: baselineGis.capabilities,
        mapOk: baselineGis.mapOk,
      },
    },
    sourceChange: {
      beforeRevision: baselineSource.revision,
      afterRevision: sourceAfter.revision,
      labelOnly,
      audits: auditResults,
      sourceFreshness,
      oldDelivery: {
        ok: staleDelivery.ok,
        failed: sourceChange.oldDelivery.failed,
        expectedRevision: delivery.expected.sourceRevision,
        currentRevision: sourceAfter.revision,
      },
      sameTargetIdentity,
    },
    targetChange: {
      previous: { role: delivery.target.role, url: delivery.target.url, instanceId: delivery.target.instanceId },
      current: { role: evolvedDelivery.target.role, url: evolvedDelivery.target.url, instanceId: evolvedDelivery.target.instanceId },
    },
    gisChange: {
      before: { url: oldUrl, instanceId: oldInstance, capabilities: baselineGis.capabilities, layer: oldLayer },
      runningBeforeRestart: summarizeCapabilities(beforeRestartCaps),
      after: {
        url: newUrl,
        instanceId: newInstance,
        capabilities: gisChange.after.capabilities,
        layer: newLayer,
        map: gisChange.after.map,
      },
      oldReferences: gisChange.oldReferences,
      configWriteChanged: gisChange.configWrite.changed,
    },
    consumers,
    failures,
    rechecks,
    evidence: { root, summary, files: evidenceFiles },
    costs,
    sharing,
    boundaries: [
      'Single local host: the "second target" is another child process/port, not another machine.',
      'The release label is intentionally unchanged; no manual revision bump was used as evidence.',
      'The GIS component is a bounded WMS 1.3.0 stand-in, not a complete OGC or ArcGIS implementation.',
      'The access handoff consumer is stage-one work; stage four only keeps using it.',
      'No Agent discovered or performed these changes; the scenario script calls the public functions.',
      'No general resource registry, dependency graph, or workflow engine was added.',
      'The fresh delivery target stays registered in the shared lab (workspace.close owns it); '
        + 'the GIS process stays owned by the caller\'s gis closure.',
    ],
  };
}
