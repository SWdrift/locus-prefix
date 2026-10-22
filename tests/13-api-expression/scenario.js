import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeRelease } from '@locus/deployment-audit';
import { appendFinding, findApplicableFindings } from '@locus/operational-knowledge';
import { createOperationsLab } from '../11-operations-loop/lab.js';
import { createConsumers } from './consumers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Adapter for this service's nonstandard diagnostics, not a universal connector.
function httpConnection(target) {
  const json = async path => {
    const response = await fetch(`${target.url}${path}`, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  return {
    subject: { instanceId: target.instanceId, connection: 'direct-http' },
    async inspect() {
      const health = await json('/healthz');
      const request = await json('/check');
      const release = await observeRelease({
        metadataUrl: `${target.url}/_release.json`, payloadUrl: `${target.url}/payload`,
      });
      const diagnostics = await json('/diagnostics');
      if (!release.runtime || diagnostics.status !== 200) throw new Error('incomplete gateway observation');
      return { role: diagnostics.body.role, instanceId: diagnostics.body.instanceId,
        health, request, runtime: release.runtime, configuration: diagnostics.body.configuration };
    },
  };
}

export async function runApiScenario({ keepArtifacts = false } = {}) {
  await mkdir(join(root, 'temp'), { recursive: true });
  const directory = await mkdtemp(join(root, 'temp', 'api-expression-'));
  let lab;
  try {
    lab = await createOperationsLab({ directory: join(directory, 'lab') });
    const artifact = await lab.build();
    const release = { artifact, expected: { release: artifact.release, sourceRevision: artifact.sourceRevision } };
    const active = await lab.startBackend({ role: 'backend-active' });
    const retired = await lab.startBackend({ role: 'backend-retired', retired: true });
    const gateway = await lab.startGateway({ role: 'gateway-a', artifact,
      upstreamUrl: active.url, overrideUrl: retired.url });
    const roleConnection = target => ({
      subject: { instanceId: target.instanceId, connection: 'role-api' },
      inspect: () => lab.observe(target.role),
    });
    const consumers = createConsumers(roleConnection(gateway), release);
    const stages = {};
    const observations = {};
    async function sample(stage) {
      stages[stage] = {};
      for (const [name, consumer] of Object.entries(consumers)) {
        const result = await consumer.run();
        observations[`${stage}.${name}`] = result.observation;
        stages[stage][name] = { request: result.observation.request.status,
          verdict: result.release.verdict, ready: result.ready,
          instanceId: result.observation.instanceId };
      }
    }
    function replace(connection) {
      for (const consumer of Object.values(consumers)) consumer.replace(connection);
    }
    await sample('incident');
    const oldEvidence = consumers.witnessed.events.at(-1);
    await lab.writeGatewayEnvironment('gateway-a', {});
    await sample('fileEdited');
    const restarted = await lab.restartGateway('gateway-a');
    replace(roleConnection(restarted));
    await sample('restarted');
    let staleRejected = false;
    try { consumers.witnessed.reuse(oldEvidence); }
    catch (error) { staleRejected = error.code === 'STALE_EVIDENCE'; }

    // Reuse the existing evidence-bound notebook, rather than inventing another knowledge API.
    const evidenceBytes = JSON.stringify({ incident: observations['incident.native'],
      repaired: observations['restarted.native'] }, null, 2) + '\n';
    await writeFile(join(directory, 'intervention.json'), evidenceBytes);
    const evidence = [{ path: 'intervention.json',
      sha256: createHash('sha256').update(evidenceBytes).digest('hex') }];
    const conditions = { artifactSha256: artifact.payloadSha256,
      configModel: observations['incident.native'].configuration.model };
    const now = Date.now();
    const notebook = { file: join(directory, 'runbook.md'), evidenceRoot: directory };
    await appendFinding({ ...notebook, now, finding: {
      id: 'startup-override', originalClaim: '修改文件立即生效',
      correction: '本模型需清除覆盖并重启，再验证请求',
      steps: ['clear-override', 'restart', 'verify'], conditions, evidence, expiresAt: now + 60000,
    } });
    const replacement = await lab.startGateway({ role: 'gateway-b', artifact,
      upstreamUrl: active.url, overrideUrl: retired.url });
    replace(httpConnection(replacement));
    await sample('replacement');
    const current = observations['replacement.native'];
    const context = { artifactSha256: current.runtime.payloadSha256, configModel: current.configuration.model };
    const applicable = await findApplicableFindings({ ...notebook, context, now });
    // An exact, reviewed procedure ID plus fresh incident conditions, not arbitrary document commands.
    const selected = applicable.find(item => item.id === 'startup-override');
    if (!selected || current.request.status !== 502 || current.configuration.source !== 'environment') {
      throw new Error('no applicable, observed startup override procedure');
    }
    await lab.writeGatewayEnvironment('gateway-b', {});
    const repairedB = await lab.restartGateway('gateway-b');
    replace(httpConnection(repairedB));
    await sample('reused');

    const cachedTargets = {};
    for (const [name, consumer] of Object.entries(consumers)) {
      cachedTargets[name] = (await consumer.cached()).role;
    }
    const discovery = Object.fromEntries(Object.entries(consumers).map(([name, c]) => [name, c.discover()]));
    consumers.described.replaceWithoutDescription(httpConnection(repairedB));
    const missingDescription = consumers.described.discover().inspect === null;

    // Each race performs a real observation, pauses its return, then changes the connection.
    const races = {};
    for (const name of Object.keys(consumers)) {
      const entered = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const source = httpConnection(repairedB);
      const slow = { subject: source.subject, async inspect() {
        try {
          const value = await source.inspect();
          entered.resolve();
          await resume.promise;
          return value;
        } catch (error) {
          entered.reject(error);
          throw error;
        }
      } };
      const c = createConsumers(slow, release)[name];
      const pending = c.run().then(value => ({ status: 'returned', role: value.observation.role }),
        error => ({ status: 'rejected', code: error.code, error: error.message }));
      await entered.promise;
      c.replace(roleConnection(restarted));
      resume.resolve();
      races[name] = { ...await pending, eventSubject: c.events?.at(-1)?.subject.instanceId,
        beganOnB: c.events ? c.events.at(-1).subject.instanceId === repairedB.instanceId : null };
    }

    // A closure created outside the view remains invisible to Proxy interception.
    const captured = roleConnection(restarted).inspect;
    const hidden = createConsumers({ subject: { instanceId: repairedB.instanceId, connection: 'hidden-closure' },
      inspect: () => captured() }, release);
    const hiddenResults = {};
    for (const [name, c] of Object.entries(hidden)) {
      try { hiddenResults[name] = { status: 'returned', role: (await c.run()).observation.role }; }
      catch (error) { hiddenResults[name] = { status: 'rejected', code: error.code }; }
    }

    const changedArtifact = await findApplicableFindings({ ...notebook, now,
      context: { ...context, artifactSha256: '0'.repeat(64) } });
    const changedModel = await findApplicableFindings({ ...notebook, now,
      context: { ...context, configModel: 'different-model' } });
    const expired = await findApplicableFindings({ ...notebook, context, now: now + 60000 });
    // Deliberately wrong interpretation of the same bytes: the notebook checks bytes, not entailment.
    await appendFinding({ ...notebook, now, finding: {
      id: 'opposing-advice', originalClaim: '需要重启', correction: '只改文件，不必重启（反例：错误解释）',
      steps: ['edit-only'], conditions, evidence, expiresAt: now + 60000,
    } });
    const conflicting = await findApplicableFindings({ ...notebook, context, now });
    const retainedConflict = (await readFile(notebook.file, 'utf8')).includes('opposing-advice');
    // Explicit domain decision: neither API layer nor notebook can authorize automatic conflict resolution.
    const conflictDecision = conflicting.some(item => item.steps.includes('restart')) &&
      conflicting.some(item => item.steps.includes('edit-only')) ? 'manual-review' : 'unexpected';

    await lab.close();
    const failures = {};
    for (const [name, c] of Object.entries(consumers)) {
      try { await c.run(); failures[name] = { status: 'unexpected-success' }; }
      catch (error) { failures[name] = { status: 'failed', message: error.message,
        attributedToB: c.events ? c.events.at(-1).subject.instanceId === repairedB.instanceId : null }; }
    }
    const summary = { stages, cachedTargets, staleRejected, discovery, missingDescription, races,
      hiddenResults, knowledge: { selected: selected.id, changedArtifact: changedArtifact.map(f => f.id),
        changedModel: changedModel.map(f => f.id), expired: expired.map(f => f.id),
        conflicting: conflicting.map(f => f.id), retainedConflict, conflictDecision },
      failures, stopped: lab.registry().every(entry => entry.state === 'stopped'),
      scope: '单机真实Git/进程/文件/HTTP；非生产、多机或独立Agent可靠性证明',
      artifactDirectory: keepArtifacts ? relative(root, directory).replaceAll('\\', '/') : null };
    if (keepArtifacts) await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    return summary;
  } finally {
    try { if (lab) await lab.close(); }
    finally { if (!keepArtifacts) await rm(directory, { recursive: true, force: true }); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runApiScenario({ keepArtifacts: true }), null, 2));
}
