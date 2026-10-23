/**
 * Stage one: native baseline, access retirement, consumer-side handoff
 * adaptation, and explicit failure evidence.
 *
 * This module contains no six-stage scheduler. It runs only the access stage
 * against a workspace created by fixture.js. The adapted consumer entry is
 * written here as an observable code change; it is not written by the fixture
 * and it is not attributed to an autonomous agent.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAccessForwarder } from './access.js';

const ACCESS_MODULE_FILE = fileURLToPath(new URL('./access.js', import.meta.url));
const ACCESS_MODULE_URL = pathToFileURL(ACCESS_MODULE_FILE).href;
const HTTP_TIMEOUT_MS = 5000;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function summarizeError(error) {
  const codes = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === 'string') codes.push(current.code);
    current = current.cause;
  }
  const summary = {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : String(error),
    codes,
  };
  for (const key of [
    'code', 'status', 'handoffFile',
    'expectedRole', 'expectedInstanceId', 'observedRole', 'observedInstanceId',
  ]) {
    if (error?.[key] !== undefined) summary[key] = error[key];
  }
  return summary;
}

async function capture(action) {
  const startedAt = Date.now();
  try {
    return { ok: true, value: await action(), durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: summarizeError(error), durationMs: Date.now() - startedAt };
  }
}

async function probe(url, headers = undefined) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
      headers,
    });
    const text = await response.text();
    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: text.slice(0, 500),
    };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}

async function witness(file) {
  const bytes = await readFile(file);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}

function resultValue(result) {
  return result.ok ? result.value : undefined;
}

export async function runAccessEvolution(workspace) {
  if (!isRecord(workspace) || typeof workspace.directory !== 'string' ||
      !isRecord(workspace.paths) || typeof workspace.evolveAccess !== 'function' ||
      typeof workspace.close !== 'function') {
    throw new TypeError('runAccessEvolution requires a workspace from createWorkspace()');
  }

  const directory = workspace.directory;
  const evidenceDirectory = join(workspace.paths.evidenceDirectory, 'access');
  const handoffDirectory = join(evidenceDirectory, 'handoffs');
  await mkdir(handoffDirectory, { recursive: true });

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const checks = [];
  function check(name, ok, detail) {
    checks.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
  }

  const baselineStartedAt = Date.now();
  const serviceBefore = await readFile(workspace.paths.serviceFile);
  const initialAccessSource = await readFile(workspace.paths.consumerAccess, 'utf8');
  const initialConsumersSource = await readFile(workspace.paths.consumerConsumers, 'utf8');

  const consumerAccessUrl = `${pathToFileURL(workspace.paths.consumerAccess).href}?run=${runId}`;
  const consumerModuleUrl = `${pathToFileURL(workspace.paths.consumerConsumers).href}?run=${runId}`;
  const initialAccess = await import(consumerAccessUrl);
  const initialConsumers = await import(consumerModuleUrl);
  const baselineConsumers = initialConsumers.gatewayConsumers(initialAccess.inspectGateway);

  const baseline = {
    gateway: workspace.gateway,
    service: await readJson(workspace.paths.serviceFile),
    consumerSource: {
      access: {
        file: workspace.paths.consumerAccess,
        bytes: Buffer.byteLength(initialAccessSource),
        sha256: sha256(Buffer.from(initialAccessSource, 'utf8')),
      },
      consumers: {
        file: workspace.paths.consumerConsumers,
        bytes: Buffer.byteLength(initialConsumersSource),
        sha256: sha256(Buffer.from(initialConsumersSource, 'utf8')),
      },
    },
    overview: await capture(() => baselineConsumers.overview(directory)),
    verify: await capture(() => baselineConsumers.verify(directory)),
    source: await capture(() => initialConsumers.inspectSource(directory)),
    durationMs: Date.now() - baselineStartedAt,
  };

  const baselineOverview = resultValue(baseline.overview);
  const baselineVerify = resultValue(baseline.verify);
  const baselineSource = resultValue(baseline.source);
  check(
    'baseline overview succeeds on the captured gateway',
    Boolean(baselineOverview) &&
      baselineOverview.role === workspace.gateway.role &&
      baselineOverview.instanceId === workspace.gateway.instanceId,
    baseline.overview.error ?? baselineOverview,
  );
  check(
    'baseline verify succeeds',
    Boolean(baselineVerify) && baselineVerify.requestStatus === 200,
    baseline.verify.error ?? baselineVerify,
  );
  check(
    'baseline source inspection is clean and syntax-checked',
    Boolean(baselineSource) && baselineSource.dirty === false && baselineSource.syntax === 'valid',
    baseline.source.error ?? baselineSource,
  );
  await writeJson(join(evidenceDirectory, 'baseline.json'), baseline);

  const evolutionStartedAt = Date.now();
  const evolution = await workspace.evolveAccess();
  const evolutionDurationMs = Date.now() - evolutionStartedAt;
  const handoffBytes = await readFile(workspace.paths.handoffFile);
  const handoff = JSON.parse(handoffBytes.toString('utf8'));
  const postEvolutionGateway = workspace.currentGateway();
  const serviceAfter = await readFile(workspace.paths.serviceFile);

  check(
    'handoff identity equals the live restarted instance',
    handoff.service?.role === postEvolutionGateway.role &&
      handoff.service?.instanceId === postEvolutionGateway.instanceId &&
      postEvolutionGateway.state === 'running',
    {
      handoff: handoff.service,
      live: {
        role: postEvolutionGateway.role,
        instanceId: postEvolutionGateway.instanceId,
        state: postEvolutionGateway.state,
      },
    },
  );
  check(
    'restart actually retired the old address and instance',
    evolution.current.url !== evolution.previous.url &&
      evolution.current.instanceId !== evolution.previous.instanceId &&
      postEvolutionGateway.url === evolution.current.url &&
      postEvolutionGateway.instanceId === evolution.current.instanceId,
    {
      previous: { url: evolution.previous.url, instanceId: evolution.previous.instanceId },
      current: { url: evolution.current.url, instanceId: evolution.current.instanceId },
    },
  );

  const oldDirectProbe = await probe(`${evolution.previous.url}/healthz`);
  const oldDiagnosticsProbe = await probe(`${evolution.previous.url}/diagnostics`);
  const brokenBeforeRecovery = {
    overview: await capture(() => baselineConsumers.overview(directory)),
    verify: await capture(() => baselineConsumers.verify(directory)),
  };
  const oldServesRetiredInstance =
    oldDiagnosticsProbe.ok === true &&
    oldDiagnosticsProbe.status === 200 &&
    oldDiagnosticsProbe.body.includes(evolution.previous.instanceId);
  check(
    'old direct address no longer serves the retired instance',
    oldServesRetiredInstance === false,
    { healthz: oldDirectProbe, diagnostics: oldDiagnosticsProbe },
  );
  check(
    'old consumers fail after the old address is retired',
    brokenBeforeRecovery.overview.ok === false && brokenBeforeRecovery.verify.ok === false,
    { overview: brokenBeforeRecovery.overview.error, verify: brokenBeforeRecovery.verify.error },
  );

  const entry = handoff.entry;
  const edgePrefixUrl = `${entry.baseUrl}${entry.pathPrefix}`;
  const routeHeaderName = Object.keys(entry.headers)[0];
  const routeBarriers = {
    outsidePrefix: await probe(`${entry.baseUrl}/diagnostics`),
    missingHeader: await probe(`${edgePrefixUrl}/diagnostics`),
    wrongHeader: await probe(`${edgePrefixUrl}/diagnostics`, { [routeHeaderName]: 'not-the-issued-route' }),
    valid: await probe(`${edgePrefixUrl}/diagnostics`, entry.headers),
  };
  check(
    'requests outside the issued prefix or header are refused',
    routeBarriers.outsidePrefix.ok === true && routeBarriers.outsidePrefix.status === 404 &&
      routeBarriers.missingHeader.ok === true && routeBarriers.missingHeader.status === 403 &&
      routeBarriers.wrongHeader.ok === true && routeBarriers.wrongHeader.status === 403,
    routeBarriers,
  );
  check(
    'request with prefix and issued header reaches the live instance',
    routeBarriers.valid.ok === true &&
      routeBarriers.valid.status === 200 &&
      routeBarriers.valid.body.includes(evolution.current.instanceId),
    routeBarriers.valid,
  );

  // Explicit consumer-side code change: a new entry module wires the existing
  // consumer factory to a handoff reader. The frozen consumer modules are not
  // edited. Attribution stays with the experiment runner, not an agent.
  const adaptedFile = join(workspace.paths.consumerDirectory, 'adapted-entry.js');
  const adaptedSource = `// Explicit consumer-side adaptation written by stage1 for this experiment.
// Not produced or discovered by an autonomous agent. The frozen consumer
// modules remain unchanged; only this new wiring module is added.
import { gatewayConsumers, inspectSource } from './consumers.js';
import { inspectGatewayFromHandoff } from ${JSON.stringify(ACCESS_MODULE_URL)};

export function createConsumers(options = {}) {
  return gatewayConsumers(directory => inspectGatewayFromHandoff(directory, options));
}

export { inspectSource };
`;
  await writeFile(adaptedFile, adaptedSource, 'utf8');
  const adaptedModule = await import(`${pathToFileURL(adaptedFile).href}?run=${runId}`);
  const adaptedConsumers = adaptedModule.createConsumers();
  const adaptationModuleSource = await readFile(ACCESS_MODULE_FILE, 'utf8');

  const recovered = {
    overview: await capture(() => adaptedConsumers.overview(directory)),
    verify: await capture(() => adaptedConsumers.verify(directory)),
    source: await capture(() => adaptedModule.inspectSource(directory)),
    oldConsumerAfterAdaptation: await capture(() => baselineConsumers.overview(directory)),
  };
  check('adapted overview succeeds', recovered.overview.ok, recovered.overview.error);
  check('adapted verify succeeds', recovered.verify.ok, recovered.verify.error);

  const recoveredOverview = resultValue(recovered.overview);
  const recoveredVerify = resultValue(recovered.verify);
  const recoveredSource = resultValue(recovered.source);
  check(
    'adapted consumers use the current instance from the handoff, not the old one',
    Boolean(recoveredOverview && recoveredVerify) &&
      recoveredOverview.instanceId === evolution.current.instanceId &&
      recoveredVerify.instanceId === evolution.current.instanceId &&
      recoveredOverview.instanceId !== evolution.previous.instanceId,
    recoveredOverview && recoveredVerify
      ? {
        overviewInstanceId: recoveredOverview.instanceId,
        verifyInstanceId: recoveredVerify.instanceId,
        currentInstanceId: evolution.current.instanceId,
        retiredInstanceId: evolution.previous.instanceId,
      }
      : undefined,
  );
  check(
    'source inspection is unaffected by the access change',
    Boolean(recoveredSource && baselineSource) &&
      recovered.source.ok === true &&
      recoveredSource.revision === baselineSource.revision &&
      recoveredSource.dirty === false &&
      recoveredSource.syntax === 'valid',
    recovered.source.error ?? (recoveredSource && baselineSource
      ? { baselineRevision: baselineSource.revision, recoveredRevision: recoveredSource.revision }
      : undefined),
  );

  const consumerWitnessesAfter = {
    access: await witness(workspace.paths.consumerAccess),
    consumers: await witness(workspace.paths.consumerConsumers),
  };
  check(
    'the old direct consumer still fails after adaptation recovery',
    recovered.oldConsumerAfterAdaptation.ok === false,
    recovered.oldConsumerAfterAdaptation.error,
  );

  const staleHandoff = structuredClone(handoff);
  staleHandoff.service.instanceId = evolution.previous.instanceId;
  const staleFile = join(handoffDirectory, 'stale-instance.json');
  await writeJson(staleFile, staleHandoff);
  const staleConsumers = adaptedModule.createConsumers({ handoffFile: staleFile });
  const staleResult = await capture(() => staleConsumers.overview(directory));

  const wrongRoleHandoff = structuredClone(handoff);
  wrongRoleHandoff.service.role = 'not-the-gateway';
  const wrongRoleFile = join(handoffDirectory, 'wrong-role.json');
  await writeJson(wrongRoleFile, wrongRoleHandoff);
  const wrongRoleConsumers = adaptedModule.createConsumers({ handoffFile: wrongRoleFile });
  const wrongRoleResult = await capture(() => wrongRoleConsumers.overview(directory));

  let wrongTargetForwarder;
  let wrongTargetResult;
  const wrongTargetToken = randomBytes(18).toString('hex');
  const wrongTargetPrefix = `/gateway/${wrongTargetToken}`;
  try {
    wrongTargetForwarder = await startAccessForwarder({
      targetUrl: workspace.backend.url,
      pathPrefix: wrongTargetPrefix,
      route: { name: 'x-locus-route', value: randomBytes(18).toString('hex') },
    });
    const wrongTargetHandoff = structuredClone(handoff);
    wrongTargetHandoff.entry = {
      baseUrl: wrongTargetForwarder.url,
      pathPrefix: wrongTargetForwarder.pathPrefix,
      headers: wrongTargetForwarder.headers,
      allowedMethods: ['GET', 'HEAD'],
    };
    const wrongTargetFile = join(handoffDirectory, 'wrong-target.json');
    await writeJson(wrongTargetFile, wrongTargetHandoff);
    const wrongTargetConsumers = adaptedModule.createConsumers({ handoffFile: wrongTargetFile });
    wrongTargetResult = await capture(() => wrongTargetConsumers.overview(directory));
  } finally {
    if (wrongTargetForwarder) await wrongTargetForwarder.close();
  }

  const rejections = {
    staleInstance: {
      handoffFile: staleFile,
      result: staleResult,
    },
    wrongRole: {
      handoffFile: wrongRoleFile,
      result: wrongRoleResult,
    },
    wrongTarget: {
      note: 'issued prefix and header, but the target is the upstream backend and serves no diagnostics',
      result: wrongTargetResult,
    },
    retiredAddress: {
      probe: oldDirectProbe,
      oldConsumerAfterAdaptation: recovered.oldConsumerAfterAdaptation,
    },
  };
  check(
    'a stale instance in the handoff is rejected',
    staleResult.ok === false && staleResult.error.code === 'WRONG_TARGET' &&
      staleResult.error.expectedInstanceId === evolution.previous.instanceId,
    staleResult.error,
  );
  check(
    'a matching role label with a different instance is not accepted as current',
    wrongRoleResult.ok === false && wrongRoleResult.error.code === 'WRONG_TARGET',
    wrongRoleResult.error,
  );
  check(
    'an issued route pointing at the wrong service is rejected',
    wrongTargetResult?.ok === false &&
      wrongTargetResult.error.code === 'NOT_READY' &&
      wrongTargetResult.error.status === 404,
    wrongTargetResult?.error,
  );

  const consumerAdaptation = {
    adaptedFile,
    bytes: Buffer.byteLength(adaptedSource, 'utf8'),
    sha256: sha256(Buffer.from(adaptedSource, 'utf8')),
    wiringBefore: 'gatewayConsumers(inspectGateway)',
    wiringAfter: 'gatewayConsumers(directory => inspectGatewayFromHandoff(directory))',
    accessModule: {
      frozenDirect: {
        file: workspace.paths.consumerAccess,
        bytes: baseline.consumerSource.access.bytes,
        sha256: baseline.consumerSource.access.sha256,
        responsibility: 'initial direct consumer of service.json',
      },
      newAdapter: {
        file: ACCESS_MODULE_FILE,
        bytes: Buffer.byteLength(adaptationModuleSource, 'utf8'),
        sha256: sha256(Buffer.from(adaptationModuleSource, 'utf8')),
        responsibility: 'handoff reader plus restricted-forwarder control',
      },
    },
    attribution: 'written by stage1 experiment code; not an independent agent discovery or adaptation',
    manualSteps: [
      'discover operations/access-handoff.json',
      'read service.role and service.instanceId as the expected live identity',
      'build request URLs from entry.baseUrl + entry.pathPrefix + /diagnostics or /check',
      'attach every header in entry.headers',
      'compare live diagnostics role and instanceId before reading /check',
      'stop treating service.json as a current direct address',
    ],
  };

  const costs = {
    scope: {
      machine: 'one local machine',
      transport: 'loopback TCP and HTTP only',
      notClaimed: [
        'SSH, FRP, firewall, DNS, or network-level isolation',
        'multi-machine coordination',
        'HTTPS or certificate validation',
        'production access control or credential rotation',
        'hiding the restarted gateway direct address from a caller that can read the lab registry or process table',
      ],
    },
    resources: {
      workspaceOwned: [
        'operations lab backend and gateway child processes',
        'restricted access forwarder child process',
      ],
      stage1Transient: ['wrong-target forwarder process, closed in a finally block'],
      closeOwner: 'the caller closes the workspace; workspace.close() is idempotent',
      stageDidNotClose: true,
    },
    workspaceDirectory: {
      requirement: 'absent or empty, strictly inside this repository, and not the repository root',
      existingDataPolicy: 'fixture rejects non-empty directories and never cleans existing data',
      errorCodes: [
        'WORKSPACE_DIRECTORY_OUTSIDE_REPO',
        'WORKSPACE_DIRECTORY_IS_REPO_ROOT',
        'WORKSPACE_DIRECTORY_NOT_DIRECTORY',
        'WORKSPACE_DIRECTORY_NOT_EMPTY',
      ],
    },
    discoveryEntry: {
      handoffFile: workspace.paths.handoffFile,
      requiredFields: [
        'service.role', 'service.instanceId', 'entry.baseUrl', 'entry.pathPrefix', 'entry.headers',
      ],
      extraContextNeeded: [
        'the route requires both prefix and header; neither works alone',
        'the retired direct address is documented in the handoff but must not be used',
      ],
    },
    manualAssociations: [
      'the operator must know that operations/access-handoff.json supersedes service.json',
      'expected identity comes from handoff.service, while observed identity comes from /diagnostics',
      'a usable request URL is composed from baseUrl + pathPrefix; neither field is usable alone',
      'every request needs the issued routing header; the header is not part of the URL',
      'old-address retirement is only observable by probing or by an old consumer failure',
    ],
    oldAssumptions: [
      'the direct baseUrl in service.json remains a stable current address',
      'a matching role label is sufficient evidence of the current target',
      'consumer code can keep using the old descriptor after an access change',
      'the old instance remains current after the entry changes',
      'one URL field fully describes how to reach the service',
    ],
    consumerChanges: {
      filesAdded: 1,
      addedFile: adaptedFile,
      wiringChanged: true,
      operationsHandoffSchemaIntroduced: true,
    },
    consumerFileWitnesses: {
      initial: baseline.consumerSource,
      after: consumerWitnessesAfter,
      changed:
        consumerWitnessesAfter.access.sha256 !== baseline.consumerSource.access.sha256 ||
        consumerWitnessesAfter.consumers.sha256 !== baseline.consumerSource.consumers.sha256,
    },
    repeatedContracts: [
      'service location (service.json baseUrl vs handoff entry.baseUrl)',
      'expected identity (service.json role/instanceId vs handoff service role/instanceId)',
      'diagnostics schema and check status semantics duplicated across adapters',
    ],
    duplicatedInfrastructure: [
      'child process readiness and stop handling is repeated from lab.js inside access.js',
      'HTTP probe/error-summary helpers exist in both access.js and stage1.js for different purposes',
    ],
    oldCombination: {
      preserved: recovered.oldConsumerAfterAdaptation.ok === false,
      serviceFile: workspace.paths.serviceFile,
      serviceFileRetired:
        oldServesRetiredInstance === false && brokenBeforeRecovery.overview.ok === false,
      frozenConsumerCopies: [workspace.paths.consumerAccess, workspace.paths.consumerConsumers],
      behavior: 'old consumers still fail because the old direct address is dead; recovery uses a new entry module',
    },
    maintenance: {
      handoffIsNewState: true,
      ownership: 'fixture writes one handoff at evolution time; no rotation, expiry, revocation, or automatic refresh exists',
      conflictState: 'service.json remains stale on disk; only a human or consumer comparing expected instance avoids using it',
      restartCoupling: 'the proxy target is the restarted gateway URL; another restart of that role would require a new forwarding target and handoff',
    },
    attribution: consumerAdaptation.attribution,
    unautomated: [
      'fetching or validating the handoff is not built into the service process',
      'no automatic retry or fallback to the retired address',
      'no operator tooling to update the forwarder when the gateway role restarts again',
    ],
    assumptionsNotTested: [
      'process death alone models remote network partition',
      'local random tokens model real authentication or route authorization',
      'a future UUID collision or reuse of the retired instance would not be distinguished by string equality alone',
    ],
  };

  const evidence = {
    stage: 'access-evolution',
    startedAt,
    finishedAt: new Date().toISOString(),
    workspace: directory,
    baseline,
    evolution: {
      ...evolution,
      durationMs: evolutionDurationMs,
      serviceSnapshot: {
        beforeSha256: sha256(serviceBefore),
        afterSha256: sha256(serviceAfter),
      },
      liveAfter: {
        role: postEvolutionGateway.role,
        url: postEvolutionGateway.url,
        instanceId: postEvolutionGateway.instanceId,
        state: postEvolutionGateway.state,
      },
      handoff: {
        file: workspace.paths.handoffFile,
        bytes: handoffBytes.length,
        sha256: sha256(handoffBytes),
      },
    },
    broken: {
      oldDirectProbe,
      oldDiagnosticsProbe,
      oldConsumers: brokenBeforeRecovery,
      routeBarriers,
      oldConsumerAfterAdaptation: recovered.oldConsumerAfterAdaptation,
    },
    adapted: consumerAdaptation,
    recovered: {
      overview: recovered.overview,
      verify: recovered.verify,
      source: recovered.source,
    },
    rejections,
    checks,
    costs,
  };

  const evidenceFile = join(evidenceDirectory, 'access-evolution.json');
  await writeJson(join(evidenceDirectory, 'baseline.json'), baseline);
  await writeJson(join(evidenceDirectory, 'broken.json'), evidence.broken);
  await writeJson(join(evidenceDirectory, 'recovered.json'), evidence.recovered);
  await writeJson(join(evidenceDirectory, 'rejections.json'), rejections);
  await writeJson(evidenceFile, evidence);

  const failed = checks.filter(item => !item.ok);
  if (failed.length > 0) {
    const error = new Error(
      `access evolution checks failed: ${failed.map(item => item.name).join('; ')}`,
    );
    error.code = 'ACCESS_EVOLUTION_CHECKS_FAILED';
    error.evidence = evidence;
    error.evidenceFile = evidenceFile;
    throw error;
  }

  return {
    baseline,
    broken: evidence.broken,
    recovered: evidence.recovered,
    evolution: evidence.evolution,
    rejections,
    checks,
    costs,
    evidenceFile,
  };
}
