import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessRelease } from '@locus/deployment-audit';
import { appendFinding, findApplicableFindings } from '@locus/operational-knowledge';
import { createOperationsLab } from './lab.js';
import { publishKnowledge } from './publication.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGINAL_CLAIM = '健康检查和发布内容一致即代表端到端就绪；上游地址只由配置文件决定，修改文件会立即生效。';
const CONFIG_MODEL = 'environment-over-file-at-startup-v1';
const CORRECTION = '发布字节一致不证明运行配置正确。环境覆盖优先于文件，且进程启动时加载；应检查有效配置与来源，清除错误覆盖后重启并重新验证请求。';
const REPAIR_STEPS = [
  'inspect-effective-configuration',
  'clear-environment-override',
  'restart-instance',
  'verify-request',
];

export async function runOperationsScenario({ keepArtifacts = false } = {}) {
  await mkdir(join(ROOT, 'temp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, 'temp', 'operations-loop-'));
  await mkdir(join(directory, 'evidence'));
  await mkdir(join(directory, 'knowledge'));
  const events = [];
  let lab;
  let closed = false;
  let complete = false;

  async function perform(name, action) {
    const startedAt = new Date().toISOString();
    try {
      const value = await action();
      events.push({ name, status: 'completed', startedAt });
      return value;
    } catch (error) {
      events.push({ name, status: 'failed', startedAt, error: error.message });
      throw error;
    }
  }

  async function saveEvidence(name, value) {
    const path = `evidence/${name}.json`;
    const content = JSON.stringify(value, null, 2) + '\n';
    await writeFile(join(directory, path), content);
    return { path, sha256: createHash('sha256').update(content).digest('hex') };
  }

  async function repair(role, label) {
    await perform(`${label}.clear-environment`, () => lab.writeGatewayEnvironment(role, {}));
    const beforeRestart = await perform(`${label}.observe-before-restart`, () => lab.observe(role));
    await perform(`${label}.restart`, () => lab.restartGateway(role));
    const afterRestart = await perform(`${label}.observe-after-restart`, () => lab.observe(role));
    return { beforeRestart, afterRestart };
  }

  try {
    lab = await createOperationsLab({ directory: join(directory, 'lab') });
    const artifact = await perform('ci.build-and-package', () => lab.build());
    const { artifactDir, ...artifactEvidence } = artifact;
    const expected = { release: artifact.release, sourceRevision: artifact.sourceRevision };
    const backend = await perform('infrastructure.start-backend', () => lab.startBackend({ role: 'backend-a' }));
    const retired = await perform('infrastructure.start-retired-backend', () =>
      lab.startBackend({ role: 'backend-retired', retired: true }));
    const gateway = await perform('cd.deploy-gateway', () => lab.startGateway({
      role: 'gateway-a', artifact, upstreamUrl: backend.url, overrideUrl: retired.url,
    }));
    const registered = lab.registry();
    const notebookFile = join(directory, 'knowledge', 'runbook.md');
    const beforeMarkdown = `# 服务A运行手册\n\n## 初始判断（待验证）\n\n${ORIGINAL_CLAIM}\n`;
    await writeFile(notebookFile, beforeMarkdown);
    await writeFile(join(directory, 'knowledge', 'runbook.before.md'), beforeMarkdown);

    const incident = await perform('acceptance.observe-incident', () => lab.observe('gateway-a'));
    const lineage = await perform('debug.inspect-release-lineage', async () =>
      assessRelease({ expected, artifact: artifactEvidence, runtime: incident.runtime }));
    const backendEvidence = await perform('debug.probe-active-backend', () => lab.observe('backend-a'));
    const diagnosis = diagnose({ incident, lineage, backendEvidence });
    if (diagnosis.cause !== 'environment-shadowing') {
      throw new Error('Evidence did not establish the expected configuration hypothesis; refusing scripted repair.');
    }
    const incidentFile = await saveEvidence('incident', { incident, lineage, backendEvidence, diagnosis });

    const fixed = await repair('gateway-a', 'repair');
    if (fixed.beforeRestart.request.status !== 502 || fixed.afterRestart.request.status !== 200) {
      throw new Error('Configuration intervention did not show the expected startup-only transition.');
    }
    const fixedLineage = assessRelease({ expected, artifact: artifactEvidence, runtime: fixed.afterRestart.runtime });
    if (fixedLineage.verdict !== 'consistent') throw new Error('Repair unexpectedly changed the checked release contract.');
    const repairFile = await saveEvidence('repair', {
      ...fixed,
      lineage: fixedLineage,
      confirmation: {
        operation: 'clear-environment-override-and-restart',
        sameArtifact: fixed.afterRestart.runtime.payloadSha256 === artifact.payloadSha256,
        requestBefore: fixed.beforeRestart.request.status,
        requestAfter: fixed.afterRestart.request.status,
      },
    });
    const conditions = {
      artifactSha256: artifact.payloadSha256,
      configModel: incident.configuration.model,
    };
    const now = Date.now();
    const finding = await perform('truth.append-evidence-bound-correction', () => appendFinding({
      file: notebookFile,
      evidenceRoot: directory,
      now,
      finding: {
        id: 'startup-environment-shadowing',
        originalClaim: ORIGINAL_CLAIM,
        correction: CORRECTION,
        steps: REPAIR_STEPS,
        conditions,
        evidence: [incidentFile, repairFile],
        expiresAt: now + 3_600_000,
      },
    }));
    const afterMarkdown = await readFile(notebookFile, 'utf8');
    const publication = await perform('truth.publish-and-clone', () => publishKnowledge({
      directory, workspaceRoot: ROOT,
    }));

    await perform('cd.deploy-second-target-same-artifact', () => lab.startGateway({
      role: 'gateway-b', artifact, upstreamUrl: backend.url, overrideUrl: retired.url,
    }));
    const recurring = await perform('repeat.observe-incident', () => lab.observe('gateway-b'));
    const applicable = await perform('repeat.lookup-verified-knowledge', () => findApplicableFindings({
      file: publication.file,
      evidenceRoot: publication.evidenceRoot,
      context: {
        artifactSha256: recurring.runtime.payloadSha256,
        configModel: recurring.configuration.model,
      },
    }));
    const useful = applicable.find(item => item.id === finding.id &&
      REPAIR_STEPS.every(step => item.steps.includes(step)));
    if (!useful) throw new Error('No evidence-bound procedure applies; refusing to invent a reusable rule.');
    if (recurring.configuration.source !== 'environment' ||
        recurring.configuration.effectiveUpstreamUrl === recurring.configuration.fileUpstreamUrl) {
      throw new Error('The new incident does not support the saved configuration diagnosis.');
    }
    // No repeated build, source audit, or backend probe: choose the verified procedure,
    // but still inspect this instance and observe the actual effect of the repair.
    const reusedRepair = await repair('gateway-b', 'repeat');
    if (reusedRepair.afterRestart.request.status !== 200) throw new Error('Reused procedure did not repair the new target.');
    await saveEvidence('repeat', {
      incident: recurring, findingId: useful.id, repair: reusedRepair,
      knowledgeSource: 'git-checkout', knowledgeRevision: publication.revision,
    });
    const changedContext = await findApplicableFindings({
      file: publication.file,
      evidenceRoot: publication.evidenceRoot,
      context: { ...conditions, artifactSha256: '0'.repeat(64) },
    });

    const liveResources = lab.registry();
    await lab.close();
    closed = true;
    const stoppedResources = lab.registry();
    const summary = {
      scope: '单机多进程角色；本地真实Git、文件、HTTP与Markdown，非生产部署或物理多机证明。',
      artifactDirectory: relative(ROOT, directory).replaceAll('\\', '/'),
      artifactsRetained: keepArtifacts,
      initialRequestStatus: incident.request.status,
      releaseAudit: lineage.verdict,
      diagnosis: diagnosis.cause,
      requestAfterFileEdit: fixed.beforeRestart.request.status,
      requestAfterRestart: fixed.afterRestart.request.status,
      repaired: fixed.afterRestart.request.status === 200,
      knowledgeDocument: 'knowledge/runbook.md',
      knowledgeReused: reusedRepair.afterRestart.request.status === 200 && useful.id === finding.id,
      knowledgeSurvivedGitCheckout: publication.byteIdentical,
      changedArtifactInvalidatesKnowledge: changedContext.length === 0,
      resourcesStopped: stoppedResources.every(resource => resource.state === 'stopped'),
      buildExecutions: events.filter(event => event.name === 'ci.build-and-package').length,
      activeBackendDebugProbes: events.filter(event => event.name === 'debug.probe-active-backend').length,
    };
    await writeFile(join(directory, 'infrastructure.json'), JSON.stringify({
      registered, beforeClose: liveResources, afterClose: stoppedResources,
    }, null, 2) + '\n');
    await writeFile(join(directory, 'events.json'), JSON.stringify(events, null, 2) + '\n');
    await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    complete = true;
    return {
      summary, artifact: artifactEvidence, registered, gateway, incident, lineage, diagnosis,
      fixed, recurring, reusedRepair, liveResources, stoppedResources, events,
      knowledge: {
        finding, beforeMarkdown, afterMarkdown, applicable, changedContext,
        publication: {
          revision: publication.revision,
          byteIdentical: publication.byteIdentical,
          checkoutMode: publication.checkoutMode,
        },
      },
    };
  } finally {
    try {
      if (lab && !closed) await lab.close();
    } finally {
      if (!keepArtifacts || !complete) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

function diagnose({ incident, lineage, backendEvidence }) {
  const config = incident.configuration;
  const configurationConflict = config?.model === CONFIG_MODEL && config.source === 'environment' &&
    config.effectiveUpstreamUrl !== config.fileUpstreamUrl;
  return {
    kind: 'deterministic-domain-rule',
    status: 'hypothesis-awaiting-intervention',
    cause: incident.request.status === 502 && lineage.verdict === 'consistent' &&
      backendEvidence.request.status === 200 && configurationConflict
      ? 'environment-shadowing' : 'unresolved',
    hypotheses: [
      { id: 'release-content-drift', result: lineage.verdict === 'consistent' ? 'not-supported-by-checked-bytes' : 'unresolved' },
      { id: 'active-backend-unavailable', result: backendEvidence.request.status === 200 ? 'not-observed-from-inspector' : 'unresolved' },
      { id: 'environment-shadowing', result: configurationConflict ? 'supported-needs-intervention' : 'unresolved' },
    ],
    limits: ['当前观测不排除所有应用缺陷或其他网络视角；配置因果判断还需干预后的请求验证。'],
  };
}
