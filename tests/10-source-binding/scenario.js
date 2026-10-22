/**
 * 实验 10：固定工作树构建与触发提交的混淆。
 *
 * 在仓库 temp 下的唯一目录中创建真实 Git 仓库并提交 A、B：
 * - 错误场景：触发提交 A，构建工作树实际停在 B，payload 来自 B；
 *   标签与运行时声明仍写 A，/healthz 返回 200。
 * - 修正场景：从 A 的干净克隆重新生成 payload，再部署和观测。
 * - 复用场景：同一修正制品部署到另一个目标角色，运行时重新观测，
 *   不沿用之前的观测结果。
 *
 * 角色名只是单机标签，不代表物理多机，也不表示现场曾发生该错误。
 * 每个目标使用本机临时 HTTP server（端口由系统分配），观测后立即关闭；
 * 仓库 temp 目录在 finally 中删除。不写入用户全局 git 配置，身份与换行
 * 转换仅在临时仓库内设置。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TEMP_ROOT = fileURLToPath(new URL('../../temp/', import.meta.url));
const RELEASE = 'release-a';
const PAYLOADS = {
  trigger: 'release-a payload\nbuilt from source A\n',
  fixedWorktree: 'release-a payload\nbuilt from source B\n',
};

export async function runSourceBindingScenario() {
  const { assessRelease, observeRelease, readGitSource } = await import('@locus/deployment-audit');

  await mkdir(TEMP_ROOT, { recursive: true });
  const work = await mkdtemp(join(TEMP_ROOT, 'source-binding-'));

  try {
    const repo = join(work, 'project-a');
    await initRepo(repo);
    const commitA = await commitPayload(repo, PAYLOADS.trigger, 'source A');
    const commitB = await commitPayload(repo, PAYLOADS.fixedWorktree, 'source B');

    const cleanFixedWorktree = await readGitSource(repo);
    await writeFile(join(repo, 'untracked-probe.txt'), 'probe\n');
    const dirtyProbe = await readGitSource(repo);
    await unlink(join(repo, 'untracked-probe.txt'));

    const expected = { release: RELEASE, sourceRevision: commitA };

    const wrongArtifactDir = join(work, 'artifact-wrong');
    const wrongPayload = await copyPayload(repo, wrongArtifactDir);
    const wrongArtifact = {
      release: RELEASE,
      sourceRevision: commitA,
      payloadSha256: sha256(wrongPayload),
      buildSource: cleanFixedWorktree,
    };
    const wrong = await deployAndObserve({
      work,
      targetRole: 'target-a',
      artifactDir: wrongArtifactDir,
      release: RELEASE,
      sourceRevision: commitA,
      expected,
      artifact: wrongArtifact,
      assessRelease,
      observeRelease,
    });

    const cleanDir = join(work, 'builder-clean');
    await git(work, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', repo, cleanDir]);
    await git(cleanDir, ['config', 'core.autocrlf', 'false']);
    await git(cleanDir, ['checkout', '--quiet', '--detach', commitA]);
    const cleanCheckout = await readGitSource(cleanDir);

    const correctedArtifactDir = join(work, 'artifact-corrected');
    const correctedPayload = await copyPayload(cleanDir, correctedArtifactDir);
    const correctedArtifact = {
      release: RELEASE,
      sourceRevision: commitA,
      payloadSha256: sha256(correctedPayload),
      buildSource: cleanCheckout,
    };
    const corrected = await deployAndObserve({
      work,
      targetRole: 'target-b',
      artifactDir: correctedArtifactDir,
      release: RELEASE,
      sourceRevision: commitA,
      expected,
      artifact: correctedArtifact,
      assessRelease,
      observeRelease,
    });

    // 同一制品再部署到新目标；runtime 来自新 server 的实际响应，不复制旧观测。
    const redeploy = await deployAndObserve({
      work,
      targetRole: 'target-c',
      artifactDir: correctedArtifactDir,
      release: RELEASE,
      sourceRevision: commitA,
      expected,
      artifact: correctedArtifact,
      assessRelease,
      observeRelease,
    });

    return {
      roles: {
        project: 'project-a',
        builder: 'builder-a',
        release: RELEASE,
        trigger: 'commit-a',
        targets: ['target-a', 'target-b', 'target-c'],
      },
      scope: '单机本机 HTTP 目标，角色名不是物理机器；这是受控复现，不表示现场曾发生该错误。',
      source: {
        revisions: {
          trigger: commitA,
          fixedWorktree: commitB,
          cleanCheckout: cleanCheckout.revision,
        },
        payloads: { ...PAYLOADS },
        probes: {
          cleanFixedWorktree,
          dirtyWorktree: dirtyProbe,
          cleanCheckout,
        },
      },
      wrong,
      corrected,
      redeploy,
    };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function initRepo(repo) {
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '--quiet', '--initial-branch=main']);
  await git(repo, ['config', 'user.name', 'Example']);
  await git(repo, ['config', 'user.email', 'author@example.invalid']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
}

async function commitPayload(repo, content, message) {
  await writeFile(join(repo, 'payload.txt'), content, 'utf8');
  await git(repo, ['add', '--', 'payload.txt']);
  await git(repo, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

async function copyPayload(sourceDir, artifactDir) {
  await mkdir(artifactDir, { recursive: true });
  await copyFile(join(sourceDir, 'payload.txt'), join(artifactDir, 'payload.txt'));
  return readFile(join(artifactDir, 'payload.txt'));
}

async function deployArtifact(work, targetRole, artifactDir) {
  const deployedDir = join(work, targetRole);
  await mkdir(deployedDir, { recursive: true });
  await copyFile(join(artifactDir, 'payload.txt'), join(deployedDir, 'payload.txt'));
  return deployedDir;
}

async function deployAndObserve({
  work,
  targetRole,
  artifactDir,
  release,
  sourceRevision,
  expected,
  artifact,
  assessRelease,
  observeRelease,
}) {
  const deployedDir = await deployArtifact(work, targetRole, artifactDir);
  const { runtime, observation } = await observeTarget({
    targetRole,
    deployedDir,
    release,
    sourceRevision,
    observeRelease,
  });
  return {
    target: targetRole,
    expected,
    artifact,
    runtime,
    observation,
    assessment: assessRelease({ expected, artifact, runtime }),
  };
}

async function observeTarget({ targetRole, deployedDir, release, sourceRevision, observeRelease }) {
  const server = createTargetServer({ deployedDir, release, sourceRevision });
  await listen(server);

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const healthResponse = await fetch(`${base}/healthz`);
    if (!healthResponse.ok) {
      throw new Error(`${targetRole}: health check returned ${healthResponse.status}`);
    }
    const health = await healthResponse.json();
    const observed = await observeRelease({
      metadataUrl: `${base}/release.json`,
      payloadUrl: `${base}/payload`,
    });

    if (observed.runtime === null || typeof observed.runtime.payloadSha256 !== 'string') {
      const detail = observed.interpretationError
        ?? observed.metadata?.error?.message
        ?? observed.payload?.error?.message
        ?? 'release metadata or payload was not observed';
      throw new Error(`${targetRole}: ${detail}`);
    }

    return {
      runtime: observed.runtime,
      observation: {
        target: targetRole,
        healthStatus: healthResponse.status,
        health,
        metadataStatus: observed.metadata.status,
        payloadStatus: observed.payload?.status ?? null,
        declaredRelease: observed.runtime.release,
        declaredSourceRevision: observed.runtime.sourceRevision,
        payloadSha256: observed.runtime.payloadSha256,
        payloadText: observed.payload?.body ?? null,
      },
    };
  } finally {
    await stopServer(server);
  }
}

function createTargetServer({ deployedDir, release, sourceRevision }) {
  const payloadPath = join(deployedDir, 'payload.txt');
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (req.url === '/release.json') {
        sendJson(res, 200, { release, sourceRevision });
        return;
      }
      if (req.url === '/payload') {
        const bytes = await readFile(payloadPath);
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': bytes.length,
        });
        res.end(bytes);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'serve failed' });
    }
  });
  server.on('clientError', (error, socket) => socket.destroy());
  return server;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=.git/disabled-hooks', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error.message;
    throw new Error(`git ${args[0]} failed: ${detail}`, { cause: error });
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
