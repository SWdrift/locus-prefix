/**
 * Stage 5: persisted operational knowledge gates real writes.
 *
 * There is exactly one source of knowledge semantics:
 * `knowledge/operational-knowledge.json`. Every decision re-reads that file;
 * no in-memory record list is used to decide. Each record persists its status
 * (verified/refuted), procedure, steps, conditions, evidence hashes, and
 * optional expiry, so another process can reconstruct the same decision.
 *
 * The existing @locus/operational-knowledge public format cannot carry this
 * experiment's support/refutation semantics: appendFinding accepts only
 * id/originalClaim/correction/steps/conditions/evidence/expiresAt, and
 * findApplicableFindings returns only currently applicable findings. Encoding
 * status/procedure in `steps` would require text parsing rather than a
 * persisted typed meaning. This is recorded as a domain mismatch; the stage
 * uses one small, explicit JSON model instead of forcing that package.
 *
 * Behaviors retained: unguided bootstrap, expired, refuted shortcut,
 * condition change, valid authorization, conflict, and a persisted status
 * edit that changes the gate from execute to refuse. Refusal scenes verify
 * before/after state and zero mutations; valid scenes perform exactly one
 * write + one restart.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MODULE_URL = new URL('./knowledge.js', import.meta.url).href;
const REPAIR_PROCEDURE = 'clear-environment-restart-verify';
const SHORTCUT_PROCEDURE = 'write-correct-environment-no-restart';
const RESTART_ONLY_PROCEDURE = 'restart-gateway-only';
const RETIRED_ROLE = 'knowledge-retired-upstream';
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function saveEvidence(root, relativePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(root, ...relativePath.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: relativePath, sha256: sha256(Buffer.from(content, 'utf8')) };
}

// ---------------------------------------------------------- knowledge store
async function readRecords(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const document = JSON.parse(text);
  if (!document || !Array.isArray(document.records)) {
    throw new Error(`knowledge file has no records array: ${file}`);
  }
  return document.records;
}

async function writeRecords(file, records) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

async function appendRecord({ file, record }) {
  const records = await readRecords(file);
  records.push(record);
  await writeRecords(file, records);
  return record;
}

// Validate only the fields the gate actually uses. Invalid records never
// authorize; this is a fail-closed domain check, not a generic schema.
function validateRecord(record) {
  if (!isRecord(record)) return 'record is not an object';
  if (typeof record.id !== 'string' || record.id.trim() === '') return 'id must be a non-empty string';
  if (record.status !== 'verified' && record.status !== 'refuted') {
    return 'status must be verified or refuted';
  }
  if (typeof record.procedure !== 'string' || record.procedure.trim() === '') {
    return 'procedure must be a non-empty string';
  }
  if (!isRecord(record.conditions) ||
      typeof record.conditions.artifactSha256 !== 'string' ||
      !HASH_PATTERN.test(record.conditions.artifactSha256) ||
      typeof record.conditions.configModel !== 'string' ||
      record.conditions.configModel.trim() === '') {
    return 'conditions require a SHA-256 artifactSha256 and non-empty configModel';
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    return 'evidence must be a non-empty array';
  }
  for (const entry of record.evidence) {
    if (!isRecord(entry) ||
        typeof entry.path !== 'string' || entry.path.trim() === '' ||
        typeof entry.sha256 !== 'string' || !HASH_PATTERN.test(entry.sha256)) {
      return 'each evidence entry requires a path and a SHA-256';
    }
  }
  if (record.expiresAt !== undefined && !Number.isFinite(record.expiresAt)) {
    return 'expiresAt must be a finite number';
  }
  return null;
}

// Evidence must be a real regular file inside the evidence root. Reject
// absolute paths and any parent segment before resolving, then re-check the
// real path so a symlink cannot escape.
async function verifyEvidence(root, evidence) {
  const rootPath = await realpath(root);
  for (const entry of evidence) {
    if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) {
      throw new Error(`evidence path is not relative: ${entry.path}`);
    }
    const resolved = await realpath(resolve(rootPath, entry.path));
    const relativeToRoot = relative(rootPath, resolved);
    if (relativeToRoot === '' || relativeToRoot === '..' ||
        relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
      throw new Error(`evidence path escapes the root: ${entry.path}`);
    }
    const bytes = await readFile(resolved);
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`evidence hash mismatch: ${entry.path}`);
    }
  }
}

/**
 * Read the persisted document and decide. This is the only decision entry
 * point: it never accepts an in-memory record list.
 */
export async function evaluateKnowledgeFile({ file, evidenceRoot, context, now = Date.now(), proposal }) {
  const records = await readRecords(file);
  const checked = [];
  for (const record of records) {
    const validationError = validateRecord(record);
    if (validationError !== null) {
      checked.push({ record, verdict: 'invalid', reason: validationError });
      continue;
    }
    if (record.conditions.artifactSha256 !== context.artifactSha256 ||
        record.conditions.configModel !== context.configModel) {
      checked.push({ record, verdict: 'condition-mismatch' });
      continue;
    }
    if (record.expiresAt !== undefined && now >= record.expiresAt) {
      checked.push({ record, verdict: 'expired' });
      continue;
    }
    try {
      await verifyEvidence(evidenceRoot, record.evidence);
    } catch {
      checked.push({ record, verdict: 'evidence-invalid' });
      continue;
    }
    checked.push({ record, verdict: 'applicable' });
  }

  const applicable = checked.filter(item => item.verdict === 'applicable').map(item => item.record);
  const refuted = applicable.filter(record => record.status === 'refuted');
  const verified = applicable.filter(record => record.status === 'verified');
  const contested = new Set(refuted.map(record => record.procedure));
  const activeProcedures = [...new Set(verified.map(record => record.procedure))]
    .filter(procedure => !contested.has(procedure));
  const matching = checked.filter(item => item.record.procedure === proposal);
  const refutedForProposal = applicable.filter(record =>
    record.procedure === proposal && record.status === 'refuted');
  const supported = applicable.filter(record =>
    record.procedure === proposal && record.status === 'verified');

  let primaryReason = null;
  if (refutedForProposal.length > 0) {
    primaryReason = 'REFUTED_PROCEDURE';
  } else if (activeProcedures.length > 1) {
    primaryReason = 'CONFLICT';
  } else if (supported.length === 0) {
    const expired = matching.some(item => item.verdict === 'expired');
    const mismatch = matching.some(item => item.verdict === 'condition-mismatch');
    const unverified = matching.some(item => item.verdict === 'evidence-invalid');
    const invalid = matching.some(item => item.verdict === 'invalid');
    primaryReason = expired ? 'EXPIRED'
      : mismatch ? 'CONDITION_MISMATCH'
        : unverified ? 'EVIDENCE_UNVERIFIED'
          : invalid ? 'INVALID_RECORD'
            : 'NO_APPLICABLE_KNOWLEDGE';
  }

  return {
    decision: primaryReason === null ? 'execute' : 'refuse',
    proposal,
    procedure: primaryReason === null ? proposal : null,
    primaryReason,
    authorizedBy: primaryReason === null ? supported.map(record => record.id) : [],
    activeProcedures,
    applicable: applicable.map(record => record.id),
    expired: checked.filter(item => item.verdict === 'expired').map(item => item.record.id),
    conditionMismatch: checked.filter(item => item.verdict === 'condition-mismatch')
      .map(item => item.record.id),
    evidenceInvalid: checked.filter(item => item.verdict === 'evidence-invalid')
      .map(item => item.record.id),
    invalid: checked.filter(item => item.verdict === 'invalid')
      .map(item => ({ id: item.record?.id ?? null, reason: item.reason })),
    evaluatedAt: now,
    recordCount: records.length,
  };
}

function sameDecision(left, right) {
  return left.decision === right.decision &&
    left.primaryReason === right.primaryReason &&
    JSON.stringify(left.authorizedBy) === JSON.stringify(right.authorizedBy);
}

// Run the exported decision in a separate Node process against the same
// persisted file and context. This proves no in-process cache is required.
async function coldEvaluate(input) {
  const script = `
import { evaluateKnowledgeFile } from ${JSON.stringify(MODULE_URL)};
const input = JSON.parse(Buffer.from(process.env.WORKSPACE_KNOWLEDGE_INPUT, 'base64').toString('utf8'));
const result = await evaluateKnowledgeFile(input);
process.stdout.write(JSON.stringify(result));
`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      WORKSPACE_KNOWLEDGE_INPUT: Buffer.from(JSON.stringify(input)).toString('base64'),
    },
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// ---------------------------------------------------------- facility state
async function snapshotScene(workspace, role) {
  const entry = workspace.lab.registry().find(item => item.role === role);
  if (!entry) throw new Error(`role "${role}" is not registered in the operations lab`);
  const observation = await workspace.lab.observe(role);
  const environmentFile = join(workspace.rolesDir, role, 'environment.json');
  let environment = null;
  let environmentSha256 = null;
  try {
    const bytes = await readFile(environmentFile);
    environmentSha256 = sha256(bytes);
    environment = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    role,
    state: entry.state,
    url: entry.url,
    instanceId: entry.instanceId,
    environment,
    environmentSha256,
    requestStatus: observation.request.status,
    requestBody: observation.request.body,
    configuration: observation.configuration,
    runtime: observation.runtime,
  };
}

function sceneState(snapshot) {
  return {
    instanceId: snapshot.instanceId,
    url: snapshot.url,
    environmentSha256: snapshot.environmentSha256,
    environment: snapshot.environment,
    requestStatus: snapshot.requestStatus,
    configuration: {
      source: snapshot.configuration.source,
      fileUpstreamUrl: snapshot.configuration.fileUpstreamUrl,
      effectiveUpstreamUrl: snapshot.configuration.effectiveUpstreamUrl,
    },
  };
}

function sceneUnchanged(before, after) {
  return before.state === after.state &&
    before.url === after.url &&
    before.instanceId === after.instanceId &&
    before.environmentSha256 === after.environmentSha256 &&
    before.requestStatus === after.requestStatus &&
    before.configuration?.source === after.configuration?.source &&
    before.configuration?.effectiveUpstreamUrl === after.configuration?.effectiveUpstreamUrl;
}

function runtimeBehaviorUnchanged(before, after) {
  return before.state === after.state &&
    before.url === after.url &&
    before.instanceId === after.instanceId &&
    before.requestStatus === after.requestStatus &&
    before.configuration?.source === after.configuration?.source &&
    before.configuration?.effectiveUpstreamUrl === after.configuration?.effectiveUpstreamUrl;
}

function createLabGate(lab) {
  const counts = { environmentWrites: 0, restarts: 0 };
  return {
    counts,
    reset() {
      counts.environmentWrites = 0;
      counts.restarts = 0;
    },
    lab: {
      startBackend: options => lab.startBackend(options),
      startGateway: options => lab.startGateway(options),
      observe: role => lab.observe(role),
      registry: () => lab.registry(),
      async writeGatewayEnvironment(role, value) {
        const result = await lab.writeGatewayEnvironment(role, value);
        counts.environmentWrites += 1;
        return result;
      },
      async restartGateway(role) {
        const result = await lab.restartGateway(role);
        counts.restarts += 1;
        return result;
      },
    },
  };
}

async function executeProcedure({ workspace, role, decision, knowledge, onFailure }) {
  if (!isRecord(decision) || decision.decision !== 'execute') {
    throw new Error('executeProcedure called without an authorizing decision');
  }
  if (decision.procedure !== REPAIR_PROCEDURE) {
    throw new Error(`no executable implementation for procedure ${decision.procedure}`);
  }
  if (!isRecord(knowledge) || typeof knowledge.file !== 'string' ||
      typeof knowledge.evidenceRoot !== 'string') {
    throw new TypeError('executeProcedure requires the persisted knowledge file');
  }
  const before = await snapshotScene(workspace, role);
  if (before.requestStatus === 200) {
    throw new Error('refusing to repair a scene that is already healthy; the action would not be observable');
  }
  // Re-read the persisted knowledge immediately before the mutation and
  // evaluate it with the current facility context and action-time clock.
  const actionContext = {
    artifactSha256: before.runtime.payloadSha256,
    configModel: before.configuration.model,
  };
  const current = await evaluateKnowledgeFile({
    file: knowledge.file,
    evidenceRoot: knowledge.evidenceRoot,
    context: actionContext,
    now: Date.now(),
    proposal: knowledge.proposal,
  });
  if (current.decision !== 'execute' || !sameDecision(current, decision)) {
    throw Object.assign(new Error(`knowledge is no longer actionable: ${current.primaryReason ?? 'changed'}`), {
      code: 'KNOWLEDGE_NOT_ACTIONABLE',
      decision: current,
      context: actionContext,
    });
  }
  const attempted = { environmentWrites: 0, restarts: 0 };
  let restarted = null;
  let after = null;
  let checks = null;
  try {
    attempted.environmentWrites += 1;
    await workspace.lab.writeGatewayEnvironment(role, {});
    attempted.restarts += 1;
    restarted = await workspace.lab.restartGateway(role);
    after = await snapshotScene(workspace, role);
    checks = {
      requestRecovered: after.requestStatus === 200,
      configurationSourceIsFile: after.configuration.source === 'file',
      effectiveUpstreamRestored:
        after.configuration.effectiveUpstreamUrl === after.configuration.fileUpstreamUrl,
      instanceReplaced: after.instanceId !== before.instanceId && after.instanceId === restarted.instanceId,
    };
    const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
    if (failed.length > 0) {
      throw new Error(`authorized procedure did not produce the expected state: ${failed.join(', ')}`);
    }
  } catch (error) {
    // Keep the pre-state, attempted mutations and a post-failure observation
    // before rethrowing; a written configuration must not disappear from the
    // evidence just because restart/verification failed.
    let afterSnapshot = null;
    try {
      afterSnapshot = await snapshotScene(workspace, role);
    } catch (snapshotError) {
      afterSnapshot = { error: snapshotError.message };
    }
    const failure = {
      stage: 'authorized-action',
      knowledgeFile: knowledge.file,
      error: { name: error.name, code: error.code ?? null, message: error.message },
      before: sceneState(before),
      attempted,
      restarted,
      after: afterSnapshot?.instanceId ? sceneState(afterSnapshot) : afterSnapshot,
      checks,
    };
    if (typeof onFailure === 'function') {
      try {
        await onFailure(failure);
      } catch (recordError) {
        failure.recordError = recordError.message;
      }
    }
    throw Object.assign(error, { failure });
  }
  return {
    authorizedBy: decision.authorizedBy,
    procedure: decision.procedure,
    before,
    restarted,
    after,
    checks,
    revalidated: { decision: current, context: actionContext, actionTime: Date.now() },
  };
}

function contextFromSnapshot(snapshot) {
  return {
    artifactSha256: snapshot.runtime.payloadSha256,
    configModel: snapshot.configuration.model,
  };
}

function recordSummary(record) {
  return {
    id: record.id,
    status: record.status,
    procedure: record.procedure,
    conditions: record.conditions,
    expiresAt: record.expiresAt ?? null,
  };
}

async function requireFailure(workspace, role) {
  const snapshot = await snapshotScene(workspace, role);
  if (snapshot.requestStatus !== 502) {
    throw new Error(`expected failing /check for role "${role}", observed ${snapshot.requestStatus}`);
  }
  if (snapshot.configuration.source !== 'environment') {
    throw new Error(`expected environment configuration source for role "${role}"`);
  }
  return snapshot;
}

async function startIncident(gate, workspace, { role, artifact, retiredUrl, evidenceRoot, evidencePath }) {
  if (workspace.lab.registry().some(item => item.role === role)) {
    throw new Error(`role "${role}" already exists; stage 5 needs a fresh incident role`);
  }
  await gate.lab.startGateway({
    role,
    artifact,
    upstreamUrl: workspace.backend.url,
    overrideUrl: retiredUrl,
  });
  const snapshot = await requireFailure(workspace, role);
  const evidence = await saveEvidence(evidenceRoot, evidencePath, {
    purpose: 'incident-before-action',
    role,
    recordedAt: new Date().toISOString(),
    snapshot,
  });
  return { snapshot, evidence };
}

/**
 * @param {{workspace: object, delivery: object, gis: object, changes: object}} input
 */
export async function runKnowledgeEvolution({ workspace, delivery, gis, changes } = {}) {
  if (!isRecord(workspace) || !workspace.lab || !workspace.backend || !workspace.rolesDir) {
    throw new TypeError('workspace with lab, backend and rolesDir is required');
  }
  if (!isRecord(delivery) || !isRecord(delivery.artifact)) {
    throw new TypeError('delivery.artifact is required');
  }
  if (!isRecord(changes) || !isRecord(changes.artifact)) {
    throw new TypeError('changes.artifact is required; run runChanges first');
  }
  const originalArtifact = delivery.artifact;
  const updatedArtifact = changes.artifact;
  if (updatedArtifact.payloadSha256 === originalArtifact.payloadSha256) {
    throw new Error('changes.artifact did not change payload bytes; condition evolution is not observable');
  }

  const root = workspace.directory;
  const knowledgeDirectory = join(root, 'knowledge');
  const knowledgeFile = join(knowledgeDirectory, 'operational-knowledge.json');
  await mkdir(knowledgeDirectory, { recursive: true });
  const evidenceRoot = root;
  const now = Date.now();
  const gate = createLabGate(workspace.lab);
  const evidenceFiles = [];
  const scenarios = {};
  const costs = [];

  async function recordEvidence(relativePath, value) {
    const entry = await saveEvidence(evidenceRoot, relativePath, value);
    evidenceFiles.push(entry);
    return entry;
  }

  async function decide(input) {
    return evaluateKnowledgeFile({ evidenceRoot, ...input, now: input.now ?? Date.now() });
  }

  // ---------------------------------------------------------------- setup
  let retiredUrl;
  const existingRetired = workspace.lab.registry().find(item => item.role === RETIRED_ROLE);
  if (existingRetired) {
    retiredUrl = existingRetired.url;
  } else {
    const retired = await gate.lab.startBackend({ role: RETIRED_ROLE, retired: true });
    retiredUrl = retired.url;
  }

  // -------------------------------------------- bootstrap: learn by doing
  // No knowledge exists. The first repair is unguided; its observations
  // create both a verified correction and a refuted shortcut in the JSON
  // document.
  const bootstrap = await startIncident(gate, workspace, {
    role: 'knowledge-bootstrap',
    artifact: originalArtifact,
    retiredUrl,
    evidenceRoot,
    evidencePath: 'evidence/knowledge/bootstrap/incident.json',
  });
  {
    const before = bootstrap.snapshot;
    gate.reset();
    await gate.lab.writeGatewayEnvironment('knowledge-bootstrap', {
      UPSTREAM_URL: workspace.backend.url,
    });
    const afterWriteOnly = await snapshotScene(workspace, 'knowledge-bootstrap');
    const writeOnlyEvidence = await recordEvidence('evidence/knowledge/bootstrap/write-only.json', {
      purpose: 'uninformed shortcut: rewrite the override with the correct URL, no restart',
      before,
      after: afterWriteOnly,
      mutations: { ...gate.counts },
      configurationFileChanged: before.environmentSha256 !== afterWriteOnly.environmentSha256,
      runtimeBehaviorUnchanged: runtimeBehaviorUnchanged(before, afterWriteOnly),
    });
    if (afterWriteOnly.requestStatus !== 502) {
      throw new Error('writing environment.json without a restart unexpectedly changed the running result');
    }
    const shortcutMutations = { ...gate.counts };

    gate.reset();
    await gate.lab.writeGatewayEnvironment('knowledge-bootstrap', {});
    const restarted = await gate.lab.restartGateway('knowledge-bootstrap');
    const afterRepair = await snapshotScene(workspace, 'knowledge-bootstrap');
    const repairEvidence = await recordEvidence('evidence/knowledge/bootstrap/repair.json', {
      purpose: 'uninformed repair: clear the override, restart, re-observe',
      before: afterWriteOnly,
      restarted,
      after: afterRepair,
      mutations: { ...gate.counts },
    });
    if (afterRepair.requestStatus !== 200 || afterRepair.configuration.source !== 'file') {
      throw new Error('bootstrap repair did not restore the gateway');
    }
    const bootstrapRepairMutations = { ...gate.counts };

    const conditions = contextFromSnapshot(bootstrap.snapshot);
    const verifiedRecord = {
      id: 'r-clear-override-restart',
      status: 'verified',
      claim: '把 environment.json 改成正确的上游 URL 即可修复 502，无需重启进程。',
      correction: '运行进程在启动时读取 environment.json；仅改文件不改变有效上游，仍返回 502。'
        + '清除覆盖并重启后，有效配置回到文件上游，请求恢复 200。',
      procedure: REPAIR_PROCEDURE,
      steps: ['clear-environment-override', 'restart-gateway', 'verify-request'],
      conditions,
      evidence: [bootstrap.evidence, writeOnlyEvidence, repairEvidence],
      recordedAt: now,
      expiresAt: now + 30 * 60 * 1000,
    };
    const refutedShortcut = {
      id: 'r-write-correct-override-refuted',
      status: 'refuted',
      claim: '无需重启；只要把正确上游写进 environment.json 就会生效。',
      correction: '实际写入正确 URL 后进程仍使用启动时加载的旧覆盖，/check 仍为 502。'
        + '该捷径在 environment-over-file-at-startup 模型下不成立，必须重启。',
      procedure: SHORTCUT_PROCEDURE,
      steps: ['write-correct-environment', 'verify-request'],
      conditions,
      evidence: [writeOnlyEvidence, repairEvidence],
      recordedAt: now + 1,
    };
    await appendRecord({ file: knowledgeFile, record: verifiedRecord });
    await appendRecord({ file: knowledgeFile, record: refutedShortcut });

    scenarios.bootstrap = {
      role: 'knowledge-bootstrap',
      knowledgeUsedForFirstAction: false,
      before: { requestStatus: before.requestStatus, instanceId: before.instanceId },
      shortcut: {
        mutations: shortcutMutations,
        requestStatusAfter: afterWriteOnly.requestStatus,
        configurationFileChanged: before.environmentSha256 !== afterWriteOnly.environmentSha256,
        runtimeBehaviorUnchanged: runtimeBehaviorUnchanged(before, afterWriteOnly),
      },
      repair: {
        mutations: bootstrapRepairMutations,
        requestStatusAfter: afterRepair.requestStatus,
        instanceIdBefore: before.instanceId,
        instanceIdAfter: afterRepair.instanceId,
      },
    };
    costs.push('bootstrap: 2 environment writes + 1 restart were spent before any knowledge existed; '
      + 'both the verified record and the refuted shortcut come from those real observations.');
  }

  const primaryContext = contextFromSnapshot(bootstrap.snapshot);
  const updatedContext = {
    artifactSha256: updatedArtifact.payloadSha256,
    configModel: primaryContext.configModel,
  };

  // ------------------------------------------------- expired knowledge
  {
    const expiry = now - 60 * 1000;
    const expiredFile = join(knowledgeDirectory, 'operational-knowledge.expired.json');
    const seed = (await readRecords(knowledgeFile)).find(record => record.id === 'r-clear-override-restart');
    if (!seed) throw new Error('the bootstrap record is missing from the persisted document');
    await writeRecords(expiredFile, [{
      ...seed,
      id: 'r-clear-override-restart-expired',
      recordedAt: now - 2 * 60 * 60 * 1000,
      expiresAt: expiry,
    }]);

    const incident = await startIncident(gate, workspace, {
      role: 'knowledge-expired',
      artifact: originalArtifact,
      retiredUrl,
      evidenceRoot,
      evidencePath: 'evidence/knowledge/expired/incident.json',
    });
    const beforeExpiry = await decide({
      file: expiredFile, context: primaryContext, now: expiry - 1000, proposal: REPAIR_PROCEDURE,
    });
    const atNow = await decide({ file: expiredFile, context: primaryContext, proposal: REPAIR_PROCEDURE });
    if (beforeExpiry.decision !== 'execute' || atNow.decision !== 'refuse' || atNow.primaryReason !== 'EXPIRED') {
      throw new Error('expiry behavior did not match the persisted record');
    }
    gate.reset();
    const after = await snapshotScene(workspace, 'knowledge-expired');
    const expiredEvidence = await recordEvidence('evidence/knowledge/expired/decision.json', {
      purpose: 'same persisted record: applicable before expiry, expired now',
      decisionBeforeExpiry: beforeExpiry,
      decisionAtCurrentTime: atNow,
      before: sceneState(incident.snapshot),
      after: sceneState(after),
      mutations: { ...gate.counts },
      unchanged: sceneUnchanged(incident.snapshot, after),
    });
    if (!sceneUnchanged(incident.snapshot, after) || gate.counts.environmentWrites !== 0) {
      throw new Error('expired knowledge still changed the scene');
    }

    // Negative knowledge blocks an otherwise plausible write. The decision
    // re-reads the main persisted document.
    gate.reset();
    const blocked = await decide({
      file: knowledgeFile, context: primaryContext, proposal: SHORTCUT_PROCEDURE,
    });
    const afterBlocked = await snapshotScene(workspace, 'knowledge-expired');
    const blockedEvidence = await recordEvidence('evidence/knowledge/expired/blocked-shortcut.json', {
      purpose: 'a persisted refuted procedure receives no write when proposed',
      decision: blocked,
      before: sceneState(after),
      after: sceneState(afterBlocked),
      mutations: { ...gate.counts },
      unchanged: sceneUnchanged(after, afterBlocked),
    });
    if (blocked.decision !== 'refuse' || blocked.primaryReason !== 'REFUTED_PROCEDURE') {
      throw new Error(`refuted shortcut was not blocked: ${blocked.primaryReason}`);
    }
    if (!sceneUnchanged(after, afterBlocked) || gate.counts.environmentWrites !== 0) {
      throw new Error('blocked shortcut still wrote configuration');
    }

    // Cold reload + persisted edit: one JSON file, one verified record.
    // A separate process reads execute; then the file's status is edited to
    // refuted and both processes read refuse. No action follows the refusal.
    const editFile = join(knowledgeDirectory, 'operational-knowledge.edit-case.json');
    const editSeed = (await readRecords(knowledgeFile)).find(record => record.id === 'r-clear-override-restart');
    const editRecord = { ...editSeed, id: 'r-persisted-edit-case' };
    await writeRecords(editFile, [editRecord]);
    const editInput = { file: editFile, context: primaryContext, proposal: REPAIR_PROCEDURE };
    const editBeforeMain = await decide(editInput);
    const editBeforeCold = await coldEvaluate({ evidenceRoot, now: Date.now(), ...editInput });
    if (editBeforeMain.decision !== 'execute' || !sameDecision(editBeforeMain, editBeforeCold)) {
      throw new Error('cold read did not reproduce the pre-edit decision');
    }
    const editedRecords = (await readRecords(editFile)).map(record =>
      record.id === editRecord.id ? { ...record, status: 'refuted' } : record);
    await writeRecords(editFile, editedRecords);
    const editAfterMain = await decide(editInput);
    const editAfterCold = await coldEvaluate({ evidenceRoot, now: Date.now(), ...editInput });
    if (editAfterMain.decision !== 'refuse' ||
        editAfterMain.primaryReason !== 'REFUTED_PROCEDURE' ||
        !sameDecision(editAfterMain, editAfterCold)) {
      throw new Error('cold read did not reproduce the post-edit refusal');
    }
    const afterEdit = await snapshotScene(workspace, 'knowledge-expired');
    const editEvidence = await recordEvidence('evidence/knowledge/persisted-edit/decisions.json', {
      purpose: 'cold reload before/after editing the persisted status; refusal performs no action',
      file: editFile,
      edit: {
        kind: 'status-change',
        recordId: editRecord.id,
        from: 'verified',
        to: 'refuted',
      },
      decisionBefore: editBeforeMain,
      decisionBeforeCold: editBeforeCold,
      decisionAfter: editAfterMain,
      decisionAfterCold: editAfterCold,
      coldMatchesMain: true,
      before: sceneState(afterBlocked),
      after: sceneState(afterEdit),
      mutations: { ...gate.counts },
      unchanged: sceneUnchanged(afterBlocked, afterEdit),
    });
    if (!sceneUnchanged(afterBlocked, afterEdit) || gate.counts.environmentWrites !== 0) {
      throw new Error('post-edit refusal still changed the scene');
    }

    scenarios.expired = {
      role: 'knowledge-expired',
      expiredDecision: {
        evidence: expiredEvidence,
        ...atNow,
        applicableBeforeExpiry: beforeExpiry.applicable,
        applicableAtCurrentTime: atNow.applicable,
        sceneBefore: sceneState(incident.snapshot),
        sceneAfter: sceneState(after),
        unchanged: true,
      },
      blockedShortcut: {
        evidence: blockedEvidence,
        ...blocked,
        sceneBefore: sceneState(after),
        sceneAfter: sceneState(afterBlocked),
        unchanged: true,
      },
    };
    scenarios.persistedEdit = {
      role: 'knowledge-expired',
      file: editFile,
      relativeFile: relative(root, editFile).split(sep).join('/'),
      edit: { kind: 'status-change', recordId: editRecord.id, from: 'verified', to: 'refuted' },
      decisionBefore: editBeforeMain,
      decisionBeforeCold: editBeforeCold,
      decisionAfter: editAfterMain,
      decisionAfterCold: editAfterCold,
      coldMatchesMain: true,
      changed: editBeforeMain.decision !== editAfterMain.decision,
      mutations: { ...gate.counts },
      sceneBefore: sceneState(afterBlocked),
      sceneAfter: sceneState(afterEdit),
      unchanged: true,
      evidence: editEvidence,
    };
    // Action-time expiry: the decision was valid when read, but the record
    // expires before the write. executeProcedure must re-read and refuse.
    {
      const raceFile = join(knowledgeDirectory, 'operational-knowledge.expiry-race.json');
      const raceSeed = (await readRecords(knowledgeFile))
        .find(record => record.id === 'r-clear-override-restart');
      if (!raceSeed) throw new Error('the bootstrap record is missing from the persisted document');
      const raceExpiry = Date.now() + 500;
      await writeRecords(raceFile, [{
        ...raceSeed,
        id: 'r-expiry-race',
        recordedAt: Date.now(),
        expiresAt: raceExpiry,
      }]);
      const raceKnowledge = { file: raceFile, evidenceRoot, proposal: REPAIR_PROCEDURE };
      // The first decision explicitly uses a pre-expiry clock so load cannot
      // make it fail before the scenario starts; execution still uses
      // Date.now() inside executeProcedure.
      const raceDecision = await decide({
        file: raceFile,
        context: primaryContext,
        now: raceExpiry - 100,
        proposal: REPAIR_PROCEDURE,
      });
      if (raceDecision.decision !== 'execute') {
        throw new Error('the short-lived record was not initially applicable');
      }
      const waitMs = Math.max(0, raceExpiry + 100 - Date.now());
      await new Promise(resolvePromise => setTimeout(resolvePromise, waitMs));
      const raceBefore = await snapshotScene(workspace, 'knowledge-expired');
      gate.reset();
      let raceError = null;
      try {
        await executeProcedure({
          workspace: { ...workspace, lab: gate.lab },
          role: 'knowledge-expired',
          decision: raceDecision,
          knowledge: raceKnowledge,
        });
      } catch (error) {
        raceError = error;
      }
      const raceAfter = await snapshotScene(workspace, 'knowledge-expired');
      if (raceError?.code !== 'KNOWLEDGE_NOT_ACTIONABLE' ||
          raceError.decision?.primaryReason !== 'EXPIRED') {
        throw new Error(`action-time expiry did not refuse the write: ${raceError?.message ?? 'no error'}`);
      }
      if (!sceneUnchanged(raceBefore, raceAfter) || gate.counts.environmentWrites !== 0) {
        throw new Error('action-time expiry refusal still changed the scene');
      }
      const raceEvidence = await recordEvidence('evidence/knowledge/action-time/expiry.json', {
        purpose: 'a stale execute decision is re-read and refused at action time',
        file: raceFile,
        expiresAt: raceExpiry,
        waitedMs: waitMs,
        decisionBeforeAction: raceDecision,
        actionTimeDecision: raceError.decision,
        refusedBy: raceError.code,
        before: sceneState(raceBefore),
        after: sceneState(raceAfter),
        mutations: { ...gate.counts },
        unchanged: sceneUnchanged(raceBefore, raceAfter),
      });
      scenarios.actionTimeExpiry = {
        file: raceFile,
        expiresAt: raceExpiry,
        waitedMs: waitMs,
        decisionBeforeAction: raceDecision,
        actionTimeDecision: raceError.decision,
        refusedBy: raceError.code,
        mutations: { ...gate.counts },
        sceneBefore: sceneState(raceBefore),
        sceneAfter: sceneState(raceAfter),
        unchanged: true,
        evidence: raceEvidence,
      };
    }

    // Evidence gate: empty, missing and modified evidence must refuse.
    {
      const seed = (await readRecords(knowledgeFile))
        .find(record => record.id === 'r-clear-override-restart');
      if (!seed) throw new Error('the bootstrap record is missing from the persisted document');
      const originalEvidence = seed.evidence[0];
      const caseDirectory = join(root, 'evidence', 'knowledge', 'evidence-gate');
      await mkdir(caseDirectory, { recursive: true });
      const sceneBefore = await snapshotScene(workspace, 'knowledge-expired');
      gate.reset();
      const cases = [];
      for (const name of ['empty', 'missing', 'modified', 'record-removed']) {
        const caseFile = join(knowledgeDirectory, `operational-knowledge.evidence-${name}.json`);
        let caseEvidence = { ...originalEvidence };
        let casePreparation = null;
        if (name === 'modified') {
          const relativeCopy = `evidence/knowledge/evidence-gate/${name}-evidence.json`;
          const copyPath = join(root, ...relativeCopy.split('/'));
          const sourceBytes = await readFile(join(root, originalEvidence.path));
          await writeFile(copyPath, sourceBytes);
          caseEvidence = { path: relativeCopy, sha256: sha256(sourceBytes) };
          casePreparation = { copiedFrom: originalEvidence.path, bytes: sourceBytes.length };
        }
        await writeRecords(caseFile, [{ ...seed, id: `r-evidence-${name}`, evidence: [caseEvidence] }]);
        const decisionBefore = await decide({
          file: caseFile, context: primaryContext, proposal: REPAIR_PROCEDURE,
        });
        if (decisionBefore.decision !== 'execute') {
          throw new Error(`evidence case ${name} was not initially authorized`);
        }
        let evidenceEdit;
        if (name === 'empty') {
          const recordsNow = await readRecords(caseFile);
          recordsNow[0].evidence = [];
          await writeRecords(caseFile, recordsNow);
          evidenceEdit = { kind: 'empty-evidence', recordId: recordsNow[0].id };
        } else if (name === 'record-removed') {
          const recordsNow = await readRecords(caseFile);
          await writeRecords(caseFile, []);
          evidenceEdit = { kind: 'record-removed', recordId: recordsNow[0].id };
        } else if (name === 'missing') {
          const recordsNow = await readRecords(caseFile);
          recordsNow[0].evidence = [{
            path: `evidence/knowledge/evidence-gate/missing-${name}.json`,
            sha256: originalEvidence.sha256,
          }];
          await writeRecords(caseFile, recordsNow);
          evidenceEdit = {
            kind: 'missing-evidence-file',
            path: recordsNow[0].evidence[0].path,
          };
        } else {
          const copyPath = join(root, ...caseEvidence.path.split('/'));
          const bytes = await readFile(copyPath);
          await writeFile(copyPath, `${bytes.toString('utf8')}modified`, 'utf8');
          evidenceEdit = {
            kind: 'modified-evidence-bytes',
            path: caseEvidence.path,
            preparation: casePreparation,
          };
        }
        const decisionAfter = await decide({
          file: caseFile, context: primaryContext, proposal: REPAIR_PROCEDURE,
        });
        if (decisionAfter.decision !== 'refuse') {
          throw new Error(`evidence case ${name} did not refuse: ${decisionAfter.primaryReason}`);
        }
        const after = await snapshotScene(workspace, 'knowledge-expired');
        if (!sceneUnchanged(sceneBefore, after) || gate.counts.environmentWrites !== 0) {
          throw new Error(`evidence case ${name} still changed the scene`);
        }
        cases.push({
          case: name,
          file: caseFile,
          condition: primaryContext,
          evidenceEdit,
          decisionBefore: {
            decision: decisionBefore.decision,
            primaryReason: decisionBefore.primaryReason,
            authorizedBy: decisionBefore.authorizedBy,
          },
          decisionAfter: {
            decision: decisionAfter.decision,
            primaryReason: decisionAfter.primaryReason,
            invalid: decisionAfter.invalid,
            evidenceInvalid: decisionAfter.evidenceInvalid,
            authorizedBy: decisionAfter.authorizedBy,
          },
          primaryReason: decisionAfter.primaryReason,
          mutations: { ...gate.counts },
          unchanged: true,
        });
      }
      const evidenceGateEvidence = await recordEvidence('evidence/knowledge/evidence-gate/decisions.json', {
        purpose: 'empty, missing and modified evidence each turn execute into a refusal',
        cases,
        sceneBefore: sceneState(sceneBefore),
        after: sceneState(await snapshotScene(workspace, 'knowledge-expired')),
      });
      scenarios.evidenceGate = {
        cases,
        evidence: evidenceGateEvidence,
      };
      scenarios.expired.mutations = { ...gate.counts };

      // Authorized action failure after the write: keep the applied side
      // effect, attempted/actual mutations and error evidence before rethrow.
      {
        const failureDecision = await decide({
          file: knowledgeFile, context: primaryContext, proposal: REPAIR_PROCEDURE,
        });
        if (failureDecision.decision !== 'execute') {
          throw new Error('action-failure case did not have an authorizing decision');
        }
        const before = await snapshotScene(workspace, 'knowledge-expired');
        gate.reset();
        const failingLab = {
          ...gate.lab,
          async restartGateway() {
            throw new Error('injected restart failure after environment write');
          },
        };
        let failureEvidence = null;
        let actionError = null;
        try {
          await executeProcedure({
            workspace: { ...workspace, lab: failingLab },
            role: 'knowledge-expired',
            decision: failureDecision,
            knowledge: { file: knowledgeFile, evidenceRoot, proposal: REPAIR_PROCEDURE },
            onFailure: async failure => {
              failureEvidence = await recordEvidence(
                'evidence/knowledge/action-failure/restart-after-write.json',
                { ...failure, gateCounts: { ...gate.counts } },
              );
            },
          });
        } catch (error) {
          actionError = error;
        }
        const after = await snapshotScene(workspace, 'knowledge-expired');
        if (!actionError?.failure) {
          throw new Error('post-write failure was not attached to the rethrown error');
        }
        if (actionError.failure.attempted.environmentWrites !== 1 ||
            actionError.failure.attempted.restarts !== 1 ||
            !failureEvidence) {
          throw new Error('post-write failure evidence is incomplete');
        }
        if (before.environmentSha256 === after.environmentSha256) {
          throw new Error('the applied environment write was lost from the failure evidence');
        }
        scenarios.actionFailure = {
          role: 'knowledge-expired',
          injected: 'restart-gateway-after-write',
          decision: failureDecision,
          error: {
            name: actionError.name,
            code: actionError.code ?? null,
            message: actionError.message,
          },
          before: sceneState(before),
          attempted: actionError.failure.attempted,
          gateCounts: { ...gate.counts },
          after: sceneState(after),
          environmentChanged: before.environmentSha256 !== after.environmentSha256,
          requestStatusAfter: after.requestStatus,
          evidence: failureEvidence,
        };
        costs.push('authorized-action failure: the environment write stayed applied after an injected restart '
          + 'failure; before/attempted/actual/after/error were persisted before rethrowing.');
      }
      costs.push('evidence gate: empty/missing/modified evidence each changed the decision from execute '
        + 'to refuse with 0 writes; record validation and hash checks are domain checks, not a schema framework.');
    }

    costs.push('expired/refuted/edit: 0 writes and 0 restarts; refusals leave the broken scene unchanged. '
      + 'The edit case is decided from the JSON file in both the main and a separate Node process.');
  }

  // --------------------------------------- conditions changed (artifact)
  {
    const incident = await startIncident(gate, workspace, {
      role: 'knowledge-changed',
      artifact: updatedArtifact,
      retiredUrl,
      evidenceRoot,
      evidencePath: 'evidence/knowledge/changed/incident.json',
    });
    const observedContext = contextFromSnapshot(incident.snapshot);
    if (observedContext.artifactSha256 !== updatedContext.artifactSha256) {
      throw new Error('updated artifact hash was not observed in the running gateway');
    }
    const oldContextApplicable = await decide({ file: knowledgeFile, context: primaryContext, proposal: REPAIR_PROCEDURE });
    const newContextBefore = await decide({ file: knowledgeFile, context: observedContext, proposal: REPAIR_PROCEDURE });
    if (newContextBefore.decision !== 'refuse' || newContextBefore.primaryReason !== 'CONDITION_MISMATCH') {
      throw new Error(`changed conditions did not refuse the old record: ${newContextBefore.primaryReason}`);
    }
    gate.reset();
    const afterRefusal = await snapshotScene(workspace, 'knowledge-changed');
    const decisionEvidence = await recordEvidence('evidence/knowledge/changed/decision.json', {
      purpose: 'persisted records bound to A are not applicable to B',
      oldContextDecision: oldContextApplicable,
      newContextDecision: newContextBefore,
      before: sceneState(incident.snapshot),
      after: sceneState(afterRefusal),
      mutations: { ...gate.counts },
      unchanged: sceneUnchanged(incident.snapshot, afterRefusal),
    });
    if (!sceneUnchanged(incident.snapshot, afterRefusal) || gate.counts.environmentWrites !== 0) {
      throw new Error('changed-condition refusal still changed the scene');
    }
    const changedRefusalMutations = { ...gate.counts };

    gate.reset();
    await gate.lab.writeGatewayEnvironment('knowledge-changed', {});
    const restarted = await gate.lab.restartGateway('knowledge-changed');
    const afterRepair = await snapshotScene(workspace, 'knowledge-changed');
    const repairEvidence = await recordEvidence('evidence/knowledge/changed/reverification.json', {
      purpose: 'unguided re-verification after the artifact changed',
      before: sceneState(afterRefusal),
      restarted,
      after: sceneState(afterRepair),
      mutations: { ...gate.counts },
    });
    if (afterRepair.requestStatus !== 200) throw new Error('changed-artifact re-verification did not recover');
    const changedRevalidationMutations = { ...gate.counts };
    const newRecord = {
      id: 'r-clear-override-restart-artifact-2',
      status: 'verified',
      claim: '旧制品条件下的修复记录可以直接用于新制品。',
      correction: '旧记录的 artifactSha256 与新制品不符，不能授权动作；'
        + '在新制品上重新执行并取证后，才得到这条适用记录。',
      procedure: REPAIR_PROCEDURE,
      steps: ['clear-environment-override', 'restart-gateway', 'verify-request'],
      conditions: observedContext,
      evidence: [incident.evidence, repairEvidence],
      recordedAt: now + 2,
      expiresAt: now + 30 * 60 * 1000,
    };
    await appendRecord({ file: knowledgeFile, record: newRecord });
    const newContextAfter = await decide({ file: knowledgeFile, context: observedContext, proposal: REPAIR_PROCEDURE });
    if (newContextAfter.decision !== 'execute') {
      throw new Error('the freshly persisted record did not change the gate for B');
    }
    scenarios.changedConditions = {
      role: 'knowledge-changed',
      decision: {
        evidence: decisionEvidence,
        ...newContextBefore,
        oldContextApplicable: oldContextApplicable.applicable,
        newContextApplicable: newContextBefore.applicable,
        mutations: changedRefusalMutations,
        sceneBefore: sceneState(incident.snapshot),
        sceneAfter: sceneState(afterRefusal),
        unchanged: true,
      },
      fileEffect: {
        file: knowledgeFile,
        decisionBeforeAppend: {
          decision: newContextBefore.decision,
          primaryReason: newContextBefore.primaryReason,
        },
        decisionAfterAppend: {
          decision: newContextAfter.decision,
          primaryReason: newContextAfter.primaryReason,
          authorizedBy: newContextAfter.authorizedBy,
        },
      },
      revalidation: {
        evidence: repairEvidence,
        mutations: changedRevalidationMutations,
        requestStatusAfter: afterRepair.requestStatus,
        note: 'the first repair under new conditions was not authorized by old knowledge',
      },
    };
    costs.push('condition change: the old finding was refused; an unguided write+restart and a new '
      + 'persisted record were required before the same proposal executed.');
  }

  // ---------------------------- valid knowledge authorizes a real write
  {
    const incident = await startIncident(gate, workspace, {
      role: 'knowledge-valid',
      artifact: updatedArtifact,
      retiredUrl,
      evidenceRoot,
      evidencePath: 'evidence/knowledge/valid/incident.json',
    });
    const decision = await decide({ file: knowledgeFile, context: updatedContext, proposal: REPAIR_PROCEDURE });
    if (decision.decision !== 'execute') {
      throw new Error(`valid knowledge did not authorize the repair: ${decision.primaryReason}`);
    }
    const validFileSha256 = sha256(await readFile(knowledgeFile));
    const validCold = await coldEvaluate({
      file: knowledgeFile, evidenceRoot, context: updatedContext, now: Date.now(), proposal: REPAIR_PROCEDURE,
    });
    if (!sameDecision(decision, validCold)) {
      throw new Error('cold read did not reproduce the valid decision');
    }
    gate.reset();
    const execution = await executeProcedure({
      workspace: { ...workspace, lab: gate.lab },
      role: 'knowledge-valid',
      decision,
      knowledge: { file: knowledgeFile, evidenceRoot, proposal: REPAIR_PROCEDURE },
      onFailure: failure => recordEvidence('evidence/knowledge/valid/action-failure.json', {
        ...failure,
        gateCounts: { ...gate.counts },
      }),
    });
    const executionEvidence = await recordEvidence('evidence/knowledge/valid/execution.json', {
      purpose: 'an applicable persisted verified record authorizes a real write and restart',
      decision,
      execution: { ...execution, before: sceneState(execution.before), after: sceneState(execution.after) },
      mutations: { ...gate.counts },
    });
    scenarios.valid = {
      role: 'knowledge-valid',
      decision,
      coldRead: {
        source: 'separate-node-process',
        file: knowledgeFile,
        sha256: validFileSha256,
        decision: validCold.decision,
        primaryReason: validCold.primaryReason,
        procedure: validCold.procedure,
        authorizedBy: validCold.authorizedBy,
        matchesInProcess: true,
      },
      evidence: executionEvidence,
      mutations: { ...gate.counts },
      sceneBefore: sceneState(execution.before),
      sceneAfter: sceneState(execution.after),
      requestStatusBefore: incident.snapshot.requestStatus,
      requestStatusAfter: execution.after.requestStatus,
      checks: execution.checks,
      revalidated: execution.revalidated,
    };
    costs.push('valid: exactly 1 environment write + 1 restart were authorized and verified; '
      + 'no extra write was used to confirm the record.');
  }

  // ----------------------------------------------------- conflict
  {
    const incident = await startIncident(gate, workspace, {
      role: 'knowledge-conflict',
      artifact: updatedArtifact,
      retiredUrl,
      evidenceRoot,
      evidencePath: 'evidence/knowledge/conflict/incident.json',
    });
    const artifact2Record = (await readRecords(knowledgeFile))
      .find(record => record.id === 'r-clear-override-restart-artifact-2');
    if (!artifact2Record) throw new Error('the artifact-2 record is missing from the persisted document');
    const claimRecord = {
      id: 'r-restart-only-author-claim',
      status: 'verified',
      claim: '502 时直接重启网关即可；覆盖配置会继续生效，但进程会重新加载它。',
      correction: '该判断与 clear-override-restart 使用同一份修复证据，作者声明相反；'
        + '证据哈希只说明字节未变，不能判定语义真伪，因此只能先按冲突处理。',
      procedure: RESTART_ONLY_PROCEDURE,
      steps: ['restart-gateway', 'verify-request'],
      conditions: updatedContext,
      evidence: [scenarios.valid.evidence, ...artifact2Record.evidence],
      recordedAt: now + 3,
    };
    const conflictShaBefore = sha256(await readFile(knowledgeFile));
    await appendRecord({ file: knowledgeFile, record: claimRecord });

    gate.reset();
    const conflictDecision = await decide({ file: knowledgeFile, context: updatedContext, proposal: REPAIR_PROCEDURE });
    const afterConflict = await snapshotScene(workspace, 'knowledge-conflict');
    const conflictEvidence = await recordEvidence('evidence/knowledge/conflict/decision.json', {
      purpose: 'two applicable persisted verified procedures block the proposed write',
      decision: conflictDecision,
      before: sceneState(incident.snapshot),
      after: sceneState(afterConflict),
      mutations: { ...gate.counts },
      unchanged: sceneUnchanged(incident.snapshot, afterConflict),
    });
    if (conflictDecision.decision !== 'refuse' || conflictDecision.primaryReason !== 'CONFLICT') {
      throw new Error(`conflicting knowledge did not block the action: ${conflictDecision.primaryReason}`);
    }
    if (!sceneUnchanged(incident.snapshot, afterConflict)) {
      throw new Error('conflict refusal changed the scene');
    }
    const conflictRefusalMutations = { ...gate.counts };

    gate.reset();
    const restarted = await gate.lab.restartGateway('knowledge-conflict');
    const afterRestartOnly = await snapshotScene(workspace, 'knowledge-conflict');
    const conflictResolutionMutations = { ...gate.counts };
    const restartOnlyEvidence = await recordEvidence('evidence/knowledge/conflict/restart-only-failed.json', {
      purpose: 'real restart-only attempt while the override is still present',
      before: sceneState(afterConflict),
      restarted,
      after: sceneState(afterRestartOnly),
      mutations: { ...gate.counts },
    });
    if (afterRestartOnly.requestStatus !== 502 || afterRestartOnly.configuration.source !== 'environment') {
      throw new Error('restart-only unexpectedly repaired the gateway; the competing claim would be valid');
    }
    const refutedRestart = {
      id: 'r-restart-only-refuted',
      status: 'refuted',
      claim: '直接重启即可修复 502。',
      correction: '重启后进程重新读取的仍是环境覆盖中的退役上游，/check 仍为 502；'
        + '必须先清除覆盖再重启。',
      procedure: RESTART_ONLY_PROCEDURE,
      steps: ['restart-gateway', 'verify-request'],
      conditions: updatedContext,
      evidence: [restartOnlyEvidence, incident.evidence],
      recordedAt: now + 4,
    };
    await appendRecord({ file: knowledgeFile, record: refutedRestart });
    const conflictShaAfter = sha256(await readFile(knowledgeFile));
    const resolvedDecision = await decide({ file: knowledgeFile, context: updatedContext, proposal: REPAIR_PROCEDURE });
    if (resolvedDecision.decision !== 'execute') {
      throw new Error(`refutation did not resolve the conflict: ${resolvedDecision.primaryReason}`);
    }
    gate.reset();
    const execution = await executeProcedure({
      workspace: { ...workspace, lab: gate.lab },
      role: 'knowledge-conflict',
      decision: resolvedDecision,
      knowledge: { file: knowledgeFile, evidenceRoot, proposal: REPAIR_PROCEDURE },
      onFailure: failure => recordEvidence('evidence/knowledge/conflict/action-failure.json', {
        ...failure,
        gateCounts: { ...gate.counts },
      }),
    });
    const resolvedMutations = { ...gate.counts };
    const resolvedEvidence = await recordEvidence('evidence/knowledge/conflict/resolved-execution.json', {
      purpose: 'persisted refutation removes the competing procedure; the remaining one executes',
      decision: resolvedDecision,
      execution: { ...execution, before: sceneState(execution.before), after: sceneState(execution.after) },
      mutations: { ...gate.counts },
    });
    scenarios.conflict = {
      role: 'knowledge-conflict',
      conflictDecision: {
        evidence: conflictEvidence,
        ...conflictDecision,
        mutations: conflictRefusalMutations,
        sceneBefore: sceneState(incident.snapshot),
        sceneAfter: sceneState(afterConflict),
        unchanged: true,
      },
      restartOnlyFailure: {
        evidence: restartOnlyEvidence,
        mutations: conflictResolutionMutations,
        sceneBefore: sceneState(afterConflict),
        sceneAfter: sceneState(afterRestartOnly),
        requestStatusAfter: afterRestartOnly.requestStatus,
      },
      resolvedDecision: {
        evidence: resolvedEvidence,
        ...resolvedDecision,
        mutations: { ...gate.counts },
        sceneBefore: sceneState(execution.before),
        sceneAfter: sceneState(execution.after),
        requestStatusAfter: execution.after.requestStatus,
        checks: execution.checks,
        revalidated: execution.revalidated,
      },
      fileChangedGate: {
        file: knowledgeFile,
        edit: {
          kind: 'append-refutation',
          recordId: 'r-restart-only-refuted',
          status: 'refuted',
          procedure: RESTART_ONLY_PROCEDURE,
        },
        sha256Before: conflictShaBefore,
        sha256After: conflictShaAfter,
        changed: conflictShaBefore !== conflictShaAfter,
        decisionBefore: {
          decision: conflictDecision.decision,
          primaryReason: conflictDecision.primaryReason,
          mutations: conflictRefusalMutations,
          unchanged: true,
        },
        decisionAfter: {
          decision: resolvedDecision.decision,
          primaryReason: resolvedDecision.primaryReason,
          authorizedBy: resolvedDecision.authorizedBy,
        },
        executionAfter: { mutations: resolvedMutations },
      },
    };
    costs.push('conflict: 0 writes at refusal; a real restart-only failure was persisted as refuted, '
      + 'which changed the file and the gate from CONFLICT to execute before 1 write + 1 restart.');
  }

  // ---------------------------------------------------------- summary
  const persistedRecords = await readRecords(knowledgeFile);
  const knowledgeBytes = await readFile(knowledgeFile);
  const sharing = {
    used: [
      'the existing operations lab for real gateway/configuration mutations',
      'one domain JSON document read on every decision; no in-process decision cache',
    ],
    notReused: [
      '@locus/operational-knowledge cannot persist the support/refutation and procedure semantics '
      + 'this gate needs: its public finding fields are id/originalClaim/correction/steps/conditions/'
      + 'evidence/expiresAt, and findApplicableFindings returns only currently applicable records. '
      + 'Encoding status/procedure in steps would be text parsing, so this stage intentionally uses '
      + 'its own small JSON model instead of forcing that package.',
      'An empty query result is not treated as a safe gate: expired, condition-mismatch, refuted and '
      + 'conflict cases are distinguished and each refusal proves the scene did not change.',
    ],
    candidate: 'No shared mechanism is proposed from one workspace and one repair procedure. '
      + 'A second independent context would be needed before extracting the status/veto rule.',
  };
  const summary = {
    generatedAt: new Date().toISOString(),
    knowledge: {
      file: knowledgeFile,
      sha256: sha256(knowledgeBytes),
      records: persistedRecords.map(recordSummary),
    },
    contexts: { original: primaryContext, updated: updatedContext },
    scenarios,
    evidenceFiles,
    costs,
    sharing,
    boundaries: [
      'Status is an author claim; evidence hashes bind bytes, not meaning.',
      'The two contrary records can share evidence bytes; the experiment demonstrates conflict blocking, not truth certification.',
      'Five local gateway processes and one retired backend are left running under the shared workspace lab; workspace.close() owns them.',
      'No Agent discovered these records or chose the procedure; the scenario script proposed the procedure explicitly.',
      'The JSON document and evidence files are trusted author inputs. Validation rejects invalid statuses, empty evidence, outside-root paths, missing files and hash mismatches, but does not authenticate who edited them.',
      'executeProcedure re-reads and re-evaluates the file immediately before the write, but a concurrent edit between that check and the mutation is still a TOCTOU window; no lock, transaction or rollback is claimed.',
      'Expiry uses action-time Date.now(); an explicit past time is used only for the pre-expiry boundary probe.',
      'The action-failure case injects a restart error after a real environment write to verify side-effect retention; it is not a natural facility fault.',
      'Not production, not multi-machine, not a general knowledge engine, and not proof that arbitrary conflicts can be resolved automatically.',
    ],
  };
  const summaryEvidence = await recordEvidence('evidence/knowledge/summary.json', summary);

  return {
    artifactContext: updatedContext,
    knowledge: {
      file: knowledgeFile,
      sha256: summary.knowledge.sha256,
      records: summary.knowledge.records,
    },
    evidence: { root, summary: summaryEvidence, files: evidenceFiles },
    scenarios,
    mutations: {
      bootstrapShortcut: scenarios.bootstrap.shortcut.mutations,
      bootstrapRepair: scenarios.bootstrap.repair.mutations,
      expired: scenarios.expired.mutations,
      changedConditions: {
        unauthorizedWrites: scenarios.changedConditions.decision.mutations.environmentWrites,
        unauthorizedRestarts: scenarios.changedConditions.decision.mutations.restarts,
        revalidationWrites: scenarios.changedConditions.revalidation.mutations.environmentWrites,
        revalidationRestarts: scenarios.changedConditions.revalidation.mutations.restarts,
      },
      valid: scenarios.valid.mutations,
      conflict: {
        blockedWrites: scenarios.conflict.conflictDecision.mutations.environmentWrites,
        blockedRestarts: scenarios.conflict.conflictDecision.mutations.restarts,
        resolutionWrites: scenarios.conflict.restartOnlyFailure.mutations.environmentWrites,
        resolutionRestarts: scenarios.conflict.restartOnlyFailure.mutations.restarts,
        authorizedWrites: scenarios.conflict.resolvedDecision.mutations.environmentWrites,
        authorizedRestarts: scenarios.conflict.resolvedDecision.mutations.restarts,
      },
    },
    costs,
    sharing,
    boundaries: summary.boundaries,
  };
}
