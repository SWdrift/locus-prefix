/**
 * Experiment 11 operations lab: real local Git source, real artifact bytes,
 * and real child processes behind HTTP.
 *
 * Scope is one machine with several logical roles, not several machines.
 * Everything lives below the caller's directory. No global Git config is
 * written; Git identity, hook isolation, and signing suppression are local to
 * the temporary repository. The caller owns deletion of the directory so a
 * demo run can retain its artifact, config, and logs for inspection.
 *
 * Plain closure object only: no classes and no external dependencies beyond
 * the workspace's deployment-audit package (release metadata + Git witness).
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { observeRelease, readGitSource } from '@locus/deployment-audit';

const execFileAsync = promisify(execFile);
const LAB_WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const RELEASE = 'release-a';
const READY_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 5000;
const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRole(role) {
  if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
    throw new TypeError('role must be a short identifier using letters, digits, dot, dash, or underscore');
  }
}

function validateHttpUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty absolute http(s) URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use http or https`);
  }
}

function processIsAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolvePromise => {
    if (!processIsAlive(child)) {
      resolvePromise(true);
      return;
    }
    let settled = false;
    const finish = exited => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (!processIsAlive(child)) return;
  try {
    child.kill();
  } catch {
    // The process may already be terminating; wait below is authoritative.
  }
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Fall through to the final wait; close must not hang forever.
  }
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    throw new Error('worker process did not exit after SIGTERM/SIGKILL');
  }
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stderrTail = '';
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      finish(new Error('worker did not announce readiness in time'));
    }, READY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      lines.close();
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr.off('data', onStderr);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onError = error => {
      finish(new Error(`worker could not be spawned (${error?.code ?? 'spawn-error'})`));
    };
    const onExit = (code, signal) => {
      const detail = stderrTail.trim();
      finish(new Error(
        `worker exited before readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        + (detail ? `; ${detail}` : ''),
      ));
    };
    const onStderr = chunk => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4096);
    };

    lines.on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.event === 'ready' && typeof message.url === 'string') {
        finish(null, message);
      }
    });
    child.once('error', onError);
    child.once('exit', onExit);
    child.stderr.on('data', onStderr);
  });
}

function validateReadyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('worker announced an invalid URL');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('worker announced a URL outside the expected local http endpoint');
  }
  return parsed.origin;
}

async function startWorker({ mode, workerPath, cwd, role, instanceId, retired, entry }) {
  const args = [
    workerPath,
    `--mode=${mode}`,
    `--role=${role}`,
    `--instance=${instanceId}`,
  ];
  if (retired) args.push('--retired');

  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  entry.child = child;
  entry.state = 'starting';

  try {
    const ready = await waitForReady(child);
    child.stdout.resume();
    child.stderr.resume();
    return { child, url: validateReadyUrl(ready.url) };
  } catch (error) {
    entry.child = null;
    await stopChild(child);
    throw error;
  }
}

async function runGit(cwd, hooksDir, args) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-c', `core.hooksPath=${hooksDir}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      '-c', 'core.autocrlf=false',
      ...args,
    ], {
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
    throw new Error(`git ${args.join(' ')} failed in the lab repository: ${detail}`, {
      cause: error,
    });
  }
}

async function nodeCheck(file, cwd) {
  try {
    await execFileAsync(process.execPath, ['--check', file], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error.message;
    throw new Error(`node --check failed for the lab worker source: ${detail}`, {
      cause: error,
    });
  }
}

async function copyDirectoryContents(sourceDir, targetDir) {
  for (const item of await readdir(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, item.name);
    const target = join(targetDir, item.name);
    if (item.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyDirectoryContents(source, target);
    } else if (item.isFile()) {
      await copyFile(source, target);
    } else {
      throw new Error('artifact contains an unsupported non-file entry');
    }
  }
}

async function readJsonHttp(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep raw text so callers can still inspect a non-JSON response.
  }
  return { status: response.status, body };
}

async function writeJsonFile(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function snapshot(entry) {
  return {
    role: entry.role,
    instanceId: entry.instanceId,
    url: entry.url,
    state: entry.state,
  };
}

/**
 * @param {{directory: string}} options
 */
export async function createOperationsLab({ directory } = {}) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new TypeError('directory must be a non-empty path');
  }

  const root = resolve(directory);
  const repoDir = join(root, 'source');
  const artifactsDir = join(root, 'artifacts');
  const rolesDir = join(root, 'roles');
  const hooksDir = join(root, 'disabled-hooks');

  await mkdir(root, { recursive: true });
  await mkdir(hooksDir, { recursive: true });
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });
  await rm(rolesDir, { recursive: true, force: true });
  await mkdir(rolesDir, { recursive: true });

  // The lab owns <directory>/source. A fresh directory is expected, but
  // clearing only this subdirectory makes retries deterministic without
  // touching unrelated files the caller may keep in the run directory.
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, hooksDir, ['-c', `init.templateDir=${hooksDir}`, 'init', '--quiet', '--initial-branch=main']);
  await runGit(repoDir, hooksDir, ['config', 'user.name', 'Example']);
  await runGit(repoDir, hooksDir, ['config', 'user.email', 'author@example.invalid']);
  await runGit(repoDir, hooksDir, ['config', 'commit.gpgsign', 'false']);
  await runGit(repoDir, hooksDir, ['config', 'tag.gpgsign', 'false']);
  await runGit(repoDir, hooksDir, ['config', 'core.autocrlf', 'false']);
  await runGit(repoDir, hooksDir, ['config', 'core.hooksPath', hooksDir]);

  const workerBytes = await readFile(LAB_WORKER_PATH);
  const sourceWorker = join(repoDir, 'worker.mjs');
  await writeFile(sourceWorker, workerBytes);
  await nodeCheck(sourceWorker, repoDir);
  await runGit(repoDir, hooksDir, ['add', '-f', '--', 'worker.mjs']);
  await runGit(repoDir, hooksDir, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'demo: add worker source']);

  const roles = new Map();
  let buildNumber = 0;
  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error('operations lab is closed');
  }

  function ensureRoleFree(role) {
    if (roles.has(role)) {
      throw new Error(`role "${role}" already exists; use restartGateway to restart a gateway role`);
    }
  }

  function requireEntry(role) {
    const entry = roles.get(role);
    if (!entry) throw new Error(`unknown role "${role}"`);
    return entry;
  }

  async function build() {
    ensureOpen();
    await nodeCheck(sourceWorker, repoDir);
    const buildSource = await readGitSource(repoDir);
    const sourceBytes = await readFile(sourceWorker);
    const payloadSha256 = sha256(sourceBytes);

    // Every build gets its own directory so an older artifact object remains
    // valid for audit comparison even after a later build.
    buildNumber += 1;
    const artifactDir = join(artifactsDir, `${RELEASE}-${buildNumber}`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, 'worker.mjs'), sourceBytes);

    const manifest = {
      release: RELEASE,
      sourceRevision: buildSource.revision,
      payloadSha256,
      files: [{ path: 'worker.mjs', bytes: sourceBytes.length, sha256: payloadSha256 }],
      builtAt: new Date().toISOString(),
    };
    await writeJsonFile(join(artifactDir, 'manifest.json'), manifest);

    const artifactBytes = await readFile(join(artifactDir, 'worker.mjs'));
    if (!artifactBytes.equals(sourceBytes)) {
      throw new Error('artifact bytes differ from the checked Git source bytes');
    }

    return {
      release: RELEASE,
      sourceRevision: buildSource.revision,
      payloadSha256,
      buildSource,
      artifactDir,
    };
  }

  async function startBackend({ role, retired = false } = {}) {
    ensureOpen();
    validateRole(role);
    ensureRoleFree(role);

    const instanceId = randomUUID();
    const roleDir = join(rolesDir, role);
    await mkdir(roleDir, { recursive: true });
    const entry = {
      role,
      kind: 'backend',
      instanceId,
      url: null,
      state: 'starting',
      child: null,
      dir: roleDir,
    };
    roles.set(role, entry);

    try {
      const { child, url } = await startWorker({
        mode: 'backend',
        workerPath: LAB_WORKER_PATH,
        cwd: roleDir,
        role,
        instanceId,
        retired: retired === true,
        entry,
      });
      entry.child = child;
      entry.url = url;
      entry.state = 'running';
      child.once('exit', () => {
        if (entry.child === child && entry.state === 'running') entry.state = 'stopped';
      });
      if (!processIsAlive(child)) entry.state = 'stopped';
      return snapshot(entry);
    } catch (error) {
      roles.delete(role);
      throw error;
    }
  }

  async function deployArtifact(artifact, roleDir) {
    if (!isRecord(artifact) || typeof artifact.artifactDir !== 'string' || artifact.artifactDir.length === 0) {
      throw new TypeError('artifact must contain artifactDir from lab.build()');
    }
    const artifactStat = await stat(artifact.artifactDir);
    if (!artifactStat.isDirectory()) throw new TypeError('artifactDir must be a directory');

    await rm(roleDir, { recursive: true, force: true });
    await mkdir(roleDir, { recursive: true });
    await copyDirectoryContents(artifact.artifactDir, roleDir);

    for (const required of ['worker.mjs', 'manifest.json']) {
      const requiredStat = await stat(join(roleDir, required));
      if (!requiredStat.isFile()) throw new Error(`artifact is missing ${required}`);
    }
  }

  async function startGateway({ role, artifact, upstreamUrl, overrideUrl } = {}) {
    ensureOpen();
    validateRole(role);
    ensureRoleFree(role);
    validateHttpUrl(upstreamUrl, 'upstreamUrl');
    if (overrideUrl !== undefined) validateHttpUrl(overrideUrl, 'overrideUrl');

    const instanceId = randomUUID();
    const roleDir = join(rolesDir, role);
    const entry = {
      role,
      kind: 'gateway',
      instanceId,
      url: null,
      state: 'starting',
      child: null,
      dir: roleDir,
    };
    roles.set(role, entry);

    try {
      await deployArtifact(artifact, roleDir);
      await writeJsonFile(join(roleDir, 'config.json'), { upstreamUrl });
      const environment = overrideUrl === undefined ? {} : { UPSTREAM_URL: overrideUrl };
      await writeJsonFile(join(roleDir, 'environment.json'), environment);

      const { child, url } = await startWorker({
        mode: 'gateway',
        workerPath: join(roleDir, 'worker.mjs'),
        cwd: roleDir,
        role,
        instanceId,
        entry,
      });
      entry.child = child;
      entry.url = url;
      entry.state = 'running';
      child.once('exit', () => {
        if (entry.child === child && entry.state === 'running') entry.state = 'stopped';
      });
      if (!processIsAlive(child)) entry.state = 'stopped';
      return snapshot(entry);
    } catch (error) {
      roles.delete(role);
      throw error;
    }
  }

  async function writeGatewayEnvironment(role, environmentObject) {
    ensureOpen();
    const entry = requireEntry(role);
    if (entry.kind !== 'gateway') throw new Error(`role "${role}" is not a gateway`);
    if (!isRecord(environmentObject)) throw new TypeError('environmentObject must be a JSON object');

    // Deliberately only a file write. The running process loaded configuration
    // at startup, so this change becomes effective only on restartGateway().
    await writeJsonFile(join(entry.dir, 'environment.json'), environmentObject);
  }

  async function restartGateway(role) {
    ensureOpen();
    const entry = requireEntry(role);
    if (entry.kind !== 'gateway') throw new Error(`role "${role}" is not a gateway`);

    const previous = entry.child;
    entry.state = 'stopping';
    try {
      await stopChild(previous);
    } catch (error) {
      // Keep the child reference so close() can make another attempt; do not
      // start a replacement while the old process may still be alive.
      entry.state = 'stopping';
      throw error;
    }
    if (entry.child === previous) {
      entry.child = null;
    }

    try {
      const instanceId = randomUUID();
      const { child, url } = await startWorker({
        mode: 'gateway',
        workerPath: join(entry.dir, 'worker.mjs'),
        cwd: entry.dir,
        role,
        instanceId,
        entry,
      });
      entry.instanceId = instanceId;
      entry.child = child;
      entry.url = url;
      entry.state = 'running';
      child.once('exit', () => {
        if (entry.child === child && entry.state === 'running') entry.state = 'stopped';
      });
      if (!processIsAlive(child)) entry.state = 'stopped';
      return snapshot(entry);
    } catch (error) {
      entry.state = 'stopped';
      throw error;
    }
  }

  async function observe(role) {
    ensureOpen();
    const entry = requireEntry(role);
    if (entry.state !== 'running' || !entry.url) {
      throw new Error(`role "${role}" is not running`);
    }

    const health = await readJsonHttp(`${entry.url}/healthz`);
    const requestPath = entry.kind === 'gateway' ? '/check' : '/value';
    const request = await readJsonHttp(`${entry.url}${requestPath}`);

    if (entry.kind === 'backend') {
      return {
        role,
        instanceId: entry.instanceId,
        health,
        request,
      };
    }

    const observed = await observeRelease({
      metadataUrl: `${entry.url}/_release.json`,
      payloadUrl: `${entry.url}/payload`,
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    if (!observed.runtime ||
        typeof observed.runtime.release !== 'string' ||
        typeof observed.runtime.sourceRevision !== 'string' ||
        typeof observed.runtime.payloadSha256 !== 'string') {
      const detail = observed.interpretationError
        ?? observed.metadata?.error?.message
        ?? observed.payload?.error?.message
        ?? 'release metadata or payload was not observed';
      throw new Error(`gateway "${role}" could not be observed: ${detail}`);
    }

    const diagnostics = await readJsonHttp(`${entry.url}/diagnostics`);
    const configuration = diagnostics.body?.configuration;
    if (diagnostics.status !== 200 || !isRecord(configuration)) {
      throw new Error(`gateway "${role}" did not expose diagnostics`);
    }

    return {
      role,
      instanceId: entry.instanceId,
      health,
      runtime: {
        release: observed.runtime.release,
        sourceRevision: observed.runtime.sourceRevision,
        payloadSha256: observed.runtime.payloadSha256,
      },
      request,
      configuration: {
        fileUpstreamUrl: configuration.fileUpstreamUrl,
        effectiveUpstreamUrl: configuration.effectiveUpstreamUrl,
        source: configuration.source,
        configSha256: configuration.configSha256,
        model: configuration.model,
      },
    };
  }

  function registry() {
    return [...roles.values()].map(snapshot);
  }

  async function close() {
    closed = true;
    const errors = [];
    await Promise.all([...roles.values()].map(async entry => {
      const child = entry.child;
      try {
        await stopChild(child);
        if (entry.child === child) entry.child = null;
        entry.state = 'stopped';
      } catch (error) {
        errors.push(new Error(`${entry.role}: ${error.message}`, { cause: error }));
      }
    }));
    if (errors.length > 0) {
      throw new AggregateError(errors, 'some lab worker processes did not stop cleanly');
    }
  }

  return {
    build,
    startBackend,
    startGateway,
    writeGatewayEnvironment,
    restartGateway,
    observe,
    registry,
    close,
  };
}
