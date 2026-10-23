/**
 * Evolution 2: build from the real local Git worktree with the existing lab
 * tooling, hand off a file artifact, deliver that copy to a second HTTP
 * target, and verify the live site independently.
 *
 * Deliberately narrow: no manifest schema, registry, or artifact framework is
 * introduced. The existing lab owns build metadata; this stage adds the file
 * handoff and re-reads bytes, Git state, and HTTP observations on every
 * `verify()`. `assessRelease` remains the release-consistency judgement.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assessRelease, observeRelease, readGitSource } from '@locus/deployment-audit';

const HTTP_TIMEOUT_MS = 5000;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonHttp(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const startedAt = Date.now();
  let response;
  let text;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    text = await response.text();
  } catch (error) {
    return {
      url,
      status: null,
      body: null,
      bytes: 0,
      elapsedMs: Date.now() - startedAt,
      error: { kind: error?.name === 'TimeoutError' ? 'timeout' : 'network', message: error?.message ?? String(error) },
    };
  }
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep raw text; the caller decides whether the observation is usable.
  }
  return {
    url,
    status: response.status,
    body,
    bytes: Buffer.byteLength(text),
    elapsedMs: Date.now() - startedAt,
    error: null,
  };
}

function workspaceSourceDir(workspace) {
  // The fixture contract guarantees this path. Do not silently fall back to a
  // guessed worktree: a wrong Git observation would be worse than a missing
  // live-checkout fact, especially because it must not affect release verdicts.
  return typeof workspace.sourceDir === 'string' && workspace.sourceDir.length > 0
    ? resolve(workspace.sourceDir)
    : null;
}

function chooseRole(lab, requested) {
  const used = new Set(lab.registry().map(entry => entry.role));
  if (!used.has(requested)) return requested;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    if (!used.has(`${requested}-${suffix}`)) return `${requested}-${suffix}`;
  }
  throw new Error(`no free role name derived from "${requested}"`);
}

/**
 * @param {object} workspace Fixture with lab, backend, directory, and a real
 *   Git sourceDir.
 * @param {{role?: string, upstreamUrl?: string}} [options]
 */
export async function runDeliveryEvolution(workspace, options = {}) {
  if (!isRecord(workspace) || !isRecord(workspace.lab) ||
      typeof workspace.lab.build !== 'function' || typeof workspace.lab.startGateway !== 'function' ||
      typeof workspace.lab.registry !== 'function') {
    throw new TypeError('workspace.lab must be the operations lab (build, startGateway, registry)');
  }
  if (typeof workspace.directory !== 'string' || workspace.directory.length === 0) {
    throw new TypeError('workspace.directory must be a non-empty path');
  }
  if (!isRecord(workspace.backend) || typeof workspace.backend.url !== 'string') {
    throw new TypeError('workspace.backend.url is required');
  }
  if (!isRecord(options)) throw new TypeError('options must be a plain object');
  const requestedRole = options.role ?? 'delivery-target';
  if (typeof requestedRole !== 'string' || requestedRole.length === 0) {
    throw new TypeError('options.role must be a non-empty role name');
  }
  const upstreamUrl = options.upstreamUrl ?? workspace.backend.url;
  if (typeof upstreamUrl !== 'string' || upstreamUrl.length === 0) {
    throw new TypeError('upstreamUrl must be a non-empty URL');
  }

  const artifactsRoot = join(resolve(workspace.directory), 'delivery', 'artifacts');
  await mkdir(artifactsRoot, { recursive: true });

  const buildStarted = Date.now();
  const artifact = await workspace.lab.build();
  const buildMs = Date.now() - buildStarted;
  if (!isRecord(artifact) || typeof artifact.artifactDir !== 'string' ||
      typeof artifact.release !== 'string' || typeof artifact.sourceRevision !== 'string' ||
      typeof artifact.payloadSha256 !== 'string') {
    throw new Error('lab.build() did not return the expected artifact object');
  }

  // File handoff: copy exactly the two files the existing lab artifact has.
  // This is the one extra byte check beyond assessRelease because that
  // function compares declared payload digests, not the copy between
  // directories. No generic artifact scanner is introduced.
  const stageStarted = Date.now();
  const stagingDir = await mkdtemp(join(artifactsRoot, 'artifact-'));
  const builtManifest = await readFile(join(artifact.artifactDir, 'manifest.json'));
  const builtPayload = await readFile(join(artifact.artifactDir, 'worker.mjs'));
  await copyFile(join(artifact.artifactDir, 'manifest.json'), join(stagingDir, 'manifest.json'));
  await copyFile(join(artifact.artifactDir, 'worker.mjs'), join(stagingDir, 'worker.mjs'));
  const stagedManifest = await readFile(join(stagingDir, 'manifest.json'));
  const stagedPayload = await readFile(join(stagingDir, 'worker.mjs'));
  const builtPayloadSha256 = sha256(builtPayload);
  const stagedPayloadSha256 = sha256(stagedPayload);
  if (builtPayloadSha256 !== artifact.payloadSha256 || !stagedPayload.equals(builtPayload) ||
      !stagedManifest.equals(builtManifest)) {
    throw new Error('file handoff changed artifact bytes before delivery');
  }
  const stageMs = Date.now() - stageStarted;

  const targetRole = chooseRole(workspace.lab, requestedRole);
  const deployStarted = Date.now();
  const target = await workspace.lab.startGateway({
    role: targetRole,
    artifact: { ...artifact, artifactDir: stagingDir },
    upstreamUrl,
  });
  const deployMs = Date.now() - deployStarted;
  if (!isRecord(target) || typeof target.url !== 'string' || typeof target.instanceId !== 'string') {
    throw new Error('lab.startGateway() did not return a usable target snapshot');
  }

  const expected = {
    release: artifact.release,
    sourceRevision: artifact.sourceRevision,
    payloadSha256: artifact.payloadSha256,
  };

  async function verify(verifyOptions = {}) {
    if (!isRecord(verifyOptions)) throw new TypeError('verify options must be a plain object');
    const allowIdentityChange = verifyOptions.allowIdentityChange === true;
    const verifyStarted = Date.now();
    const costs = { httpRequests: 0, bytesRead: 0, gitReads: 0 };
    const extraChecks = [];

    function addCheck(id, status, reason, details = {}) {
      // Details stay nested so an observed HTTP status cannot overwrite the
      // check's own status.
      extraChecks.push({ id, status, reason, details });
    }

    // A caller may supply an explicit new expected release (for example to ask
    // "is the old target running the newly built B?"). The default remains the
    // release that this delivery actually built; the live checkout is never
    // substituted for either contract.
    const explicitExpected = verifyOptions.expected;
    if (explicitExpected !== undefined && !isRecord(explicitExpected)) {
      throw new TypeError('verify expected must be a plain object');
    }
    const expectedForVerify = explicitExpected ?? expected;

    // Endpoint discovery only. Every semantic fact below still comes from
    // filesystem or HTTP observation. A restarted target role has a new URL,
    // so the delivery-time snapshot cannot be the sole address.
    let endpoint = {
      role: target.role,
      url: target.url,
      instanceId: target.instanceId,
      state: target.state ?? null,
    };
    const endpointDiscovery = { source: 'delivery-snapshot', error: null };
    try {
      const entry = workspace.lab.registry().find(item => item.role === target.role);
      if (entry && typeof entry.url === 'string' && entry.url.length > 0) {
        endpoint = { role: entry.role, url: entry.url, instanceId: entry.instanceId, state: entry.state };
        endpointDiscovery.source = 'lab.registry';
      } else {
        endpointDiscovery.error = `role "${target.role}" has no live URL in the lab registry`;
      }
    } catch (error) {
      endpointDiscovery.error = error.message;
    }

    let builtNow = null;
    let stagedNow = null;
    try {
      builtNow = await readFile(join(artifact.artifactDir, 'worker.mjs'));
      stagedNow = await readFile(join(stagingDir, 'worker.mjs'));
      costs.bytesRead += builtNow.length + stagedNow.length;
    } catch (error) {
      addCheck('artifact.delivery-integrity', 'unknown',
        `Artifact bytes could not be read independently: ${error.message}.`);
    }
    if (builtNow && stagedNow) {
      const builtNowSha = sha256(builtNow);
      const stagedNowSha = sha256(stagedNow);
      const pass = builtNowSha === artifact.payloadSha256 &&
        stagedNowSha === builtNowSha && stagedNow.equals(builtNow);
      addCheck('artifact.delivery-integrity', pass ? 'pass' : 'fail',
        pass
          ? 'The delivered file copy and the built artifact have identical payload bytes and the expected digest.'
          : 'The delivered file copy no longer matches the built artifact payload bytes.',
        {
          artifactDir: artifact.artifactDir,
          stagingDir,
          deliveredArtifactPayloadSha256: artifact.payloadSha256,
          builtPayloadSha256: builtNowSha,
          stagedPayloadSha256: stagedNowSha,
        });
    }

    const sourceDir = workspaceSourceDir(workspace);
    let gitWitness = null;
    let gitError = null;
    if (sourceDir) {
      try {
        gitWitness = await readGitSource(sourceDir);
        costs.gitReads += 1;
      } catch (error) {
        gitError = error.message;
      }
    } else {
      gitError = 'workspace.sourceDir is required for live checkout evidence';
    }
    // Live checkout state is a separate current-world fact, not a historical
    // build witness and not a gate on this artifact's release verdict. The
    // historical witness is artifact.buildSource passed to assessRelease below.
    const buildWitness = isRecord(artifact.buildSource) ? artifact.buildSource : null;
    const liveMatchesBuild = Boolean(gitWitness && buildWitness &&
      gitWitness.revision === buildWitness.revision);
    const liveMatchesExpected = Boolean(gitWitness &&
      gitWitness.revision === expectedForVerify.sourceRevision);

    const observation = await observeRelease({
      metadataUrl: `${endpoint.url}/_release.json`,
      payloadUrl: `${endpoint.url}/payload`,
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    costs.httpRequests += 2;
    costs.bytesRead += Buffer.byteLength(observation.metadata?.body ?? '');
    costs.bytesRead += Buffer.byteLength(observation.payload?.body ?? '');

    const health = await readJsonHttp(`${endpoint.url}/healthz`);
    const diagnostics = await readJsonHttp(`${endpoint.url}/diagnostics`);
    const request = await readJsonHttp(`${endpoint.url}/check`);
    costs.httpRequests += 3;
    costs.bytesRead += health.bytes + diagnostics.bytes + request.bytes;

    const healthInstance = isRecord(health.body) && typeof health.body.instanceId === 'string'
      ? health.body.instanceId
      : null;
    const observedInstance = healthInstance ??
      (isRecord(diagnostics.body) && typeof diagnostics.body.instanceId === 'string'
        ? diagnostics.body.instanceId
        : null);
    const healthPass = health.status === 200 && isRecord(health.body) &&
      health.body.status === 'ok' && health.body.service === endpoint.role && healthInstance !== null;
    addCheck('target.health', healthPass ? 'pass' : 'fail',
      healthPass
        ? 'Target /healthz reports ok for the expected role with an instance id.'
        : `Target /healthz did not report an ok service identity (HTTP ${health.status ?? 'none'}).`,
      { status: health.status, body: health.body, error: health.error });

    const expectedCurrentInstance = typeof endpoint.instanceId === 'string'
      ? endpoint.instanceId
      : target.instanceId;
    const identityPass = observedInstance !== null &&
      observedInstance === expectedCurrentInstance &&
      (allowIdentityChange || observedInstance === target.instanceId);
    addCheck('target.identity', identityPass ? 'pass' : 'fail',
      identityPass
        ? 'The live instance matches the current endpoint and the delivered identity contract.'
        : `Observed instance ${observedInstance ?? 'none'} does not satisfy delivered ${target.instanceId} / current ${expectedCurrentInstance}.`,
      {
        deliveredInstanceId: target.instanceId,
        currentInstanceId: expectedCurrentInstance,
        observedInstanceId: observedInstance,
        allowIdentityChange,
        discovery: endpointDiscovery,
      });

    const effectiveUpstream = isRecord(diagnostics.body)
      ? diagnostics.body.configuration?.effectiveUpstreamUrl
      : null;
    const upstreamConfigPass = diagnostics.status === 200 && effectiveUpstream === upstreamUrl;
    addCheck('target.upstream-config', upstreamConfigPass ? 'pass' : 'fail',
      upstreamConfigPass
        ? 'The running target reports the intended upstream URL.'
        : `The running target does not report the intended upstream ${upstreamUrl} (HTTP ${diagnostics.status ?? 'none'}, observed ${effectiveUpstream ?? 'missing'}).`,
      { configured: upstreamUrl, observed: effectiveUpstream, status: diagnostics.status });

    const requestPass = request.status === 200 && isRecord(request.body) &&
      request.body.status === 'ok' && Number.isInteger(request.body.upstreamStatus) &&
      request.body.upstreamStatus >= 200 && request.body.upstreamStatus <= 299;
    addCheck('target.upstream-request', requestPass ? 'pass' : 'fail',
      requestPass
        ? 'The target completed a real request to its configured upstream.'
        : `The target upstream request failed (HTTP ${request.status ?? 'none'}).`,
      { status: request.status, body: request.body });

    if (typeof expectedForVerify.payloadSha256 === 'string') {
      const runtimePayloadSha256 = observation.runtime?.payloadSha256 ?? null;
      const payloadPass = runtimePayloadSha256 === expectedForVerify.payloadSha256;
      addCheck('expected.payload-binding', payloadPass ? 'pass' : 'fail',
        payloadPass
          ? 'The runtime payload matches the explicitly supplied expected payload digest.'
          : `The runtime payload ${runtimePayloadSha256 ?? 'none'} does not match the explicit expected ${expectedForVerify.payloadSha256}.`,
        { expectedPayloadSha256: expectedForVerify.payloadSha256, runtimePayloadSha256 });
    }

    const audit = assessRelease({
      expected: expectedForVerify,
      artifact: {
        release: artifact.release,
        sourceRevision: artifact.sourceRevision,
        payloadSha256: artifact.payloadSha256,
        buildSource: artifact.buildSource,
      },
      runtime: observation.runtime,
    });

    const allChecks = [...audit.checks, ...extraChecks];
    const overall = allChecks.some(entry => entry.status === 'fail')
      ? 'mismatch'
      : allChecks.some(entry => entry.status === 'unknown')
        ? 'incomplete'
        : 'consistent';

    return {
      ok: overall === 'consistent',
      verdict: overall,
      auditVerdict: audit.verdict,
      collectedAt: new Date().toISOString(),
      target: {
        role: endpoint.role,
        url: endpoint.url,
        instanceId: endpoint.instanceId,
        state: endpoint.state,
        deliveredUrl: target.url,
        deliveredInstanceId: target.instanceId,
        discovery: endpointDiscovery,
      },
      expected: expectedForVerify,
      deliveredExpected: expected,
      explicitExpected: explicitExpected !== undefined,
      audit: {
        expected: expectedForVerify,
        artifact: {
          release: artifact.release,
          sourceRevision: artifact.sourceRevision,
          payloadSha256: artifact.payloadSha256,
          buildSource: artifact.buildSource,
        },
        runtime: observation.runtime,
        verdict: audit.verdict,
        checks: audit.checks,
      },
      liveSource: {
        directory: sourceDir,
        witness: gitWitness,
        error: gitError,
        buildWitness,
        liveMatchesBuild,
        liveMatchesExpected,
        headMovedSinceBuild: Boolean(gitWitness && buildWitness &&
          gitWitness.revision !== buildWitness.revision),
      },
      checks: allChecks,
      auditChecks: audit.checks,
      mismatches: allChecks.filter(entry => entry.status !== 'pass'),
      observations: {
        endpoint: { ...endpoint, discovery: endpointDiscovery },
        artifact: {
          artifactDir: artifact.artifactDir,
          stagingDir,
          expectedPayloadSha256: artifact.payloadSha256,
          builtPayloadSha256: builtNow ? sha256(builtNow) : null,
          stagedPayloadSha256: stagedNow ? sha256(stagedNow) : null,
          manifestSha256: sha256(builtManifest),
        },
        source: {
          directory: sourceDir,
          buildWitness,
          live: gitWitness,
          liveError: gitError,
          liveMatchesBuild,
          liveMatchesExpected,
          headMovedSinceBuild: Boolean(gitWitness && buildWitness &&
            gitWitness.revision !== buildWitness.revision),
        },
        release: {
          metadataStatus: observation.metadata?.status ?? null,
          metadataComplete: observation.metadata?.complete ?? null,
          interpretationError: observation.interpretationError ?? null,
          runtime: observation.runtime,
          payloadStatus: observation.payload?.status ?? null,
          payloadComplete: observation.payload?.complete ?? null,
          payloadBytes: observation.payload?.complete ? Buffer.byteLength(observation.payload.body ?? '') : 0,
        },
        health: { status: health.status, body: health.body, error: health.error },
        diagnostics: { status: diagnostics.status, body: diagnostics.body, error: diagnostics.error },
        request: { status: request.status, body: request.body, error: request.error },
      },
      costs: { ...costs, verifyMs: Date.now() - verifyStarted },
      allowIdentityChange,
    };
  }

  const verification = await verify();
  const evidence = {
    ok: verification.ok,
    scope: 'single local host; real Git worktree, file artifact copy, local child-process HTTP target',
    build: {
      release: artifact.release,
      sourceRevision: artifact.sourceRevision,
      payloadSha256: artifact.payloadSha256,
      buildSource: artifact.buildSource ?? null,
      artifactDir: artifact.artifactDir,
      buildMs,
    },
    delivery: {
      artifactDir: artifact.artifactDir,
      stagingDir,
      manifestSha256: sha256(builtManifest),
      upstreamUrl,
      target: { role: target.role, url: target.url, instanceId: target.instanceId },
      buildMs,
      stageMs,
      deployMs,
    },
    verification,
    costs: {
      buildMs,
      stageMs,
      deployMs,
      verifyMs: verification.costs.verifyMs,
      totalMs: buildMs + stageMs + deployMs + verification.costs.verifyMs,
      artifactBytes: builtPayload.length,
      httpRequests: verification.costs.httpRequests,
      gitReads: verification.costs.gitReads,
    },
    limitations: [
      'The "second target" is another local child process and port, not another host.',
      'The lab worker is a demo gateway; its HTTP checks are not production evidence.',
      'The live Git HEAD is reported as current-world context; historical build binding comes from artifact.buildSource.',
      'Git and HTTP observations are independent reads, but they do not make the source trustworthy.',
    ],
  };

  return {
    artifact,
    target: { role: target.role, url: target.url, instanceId: target.instanceId, state: target.state },
    expected,
    evidence,
    verify,
    delivery: evidence.delivery,
  };
}
