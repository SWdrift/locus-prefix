/**
 * Continuous-evolution workspace fixture.
 *
 * Real local Git source, real artifact bytes, real backend and gateway child
 * processes, and a real loopback HTTP access process. All resources live
 * below the caller's directory and are owned by the returned close().
 *
 * The fixture captures the initial direct access descriptor and copies the
 * initial consumer modules. It does not modify consumer code. Access evolution
 * retires the old gateway address, starts a restricted forwarding entry, and
 * writes an operations handoff; discovering and using that handoff remains a
 * consumer-side concern.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperationsLab } from '../11-operations-loop/lab.js';
import { startAccessForwarder } from './access.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const INITIAL_ACCESS = join(MODULE_DIR, 'initial', 'access.js');
const CONSUMERS = join(MODULE_DIR, 'consumers.js');
const BACKEND_ROLE = 'upstream';
const GATEWAY_ROLE = 'gateway';
const ROUTE_HEADER = 'x-locus-route';
const DISTINCT_ADDRESS_ATTEMPTS = 5;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function portablePath(path) {
  return path.split(sep).join('/');
}

async function writeJsonFile(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fileWitness(root, file) {
  const bytes = await readFile(file);
  return { file: portablePath(relative(root, file)), bytes: bytes.length, sha256: sha256(bytes) };
}

function pathError(code, message, directory) {
  return Object.assign(new Error(message), { code, directory });
}

function isStrictlyInside(relativePath) {
  return relativePath !== '' && relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function assertLexicallyInsideRepo(root) {
  const relation = relative(REPO_ROOT, root);
  if (relation === '') {
    throw pathError(
      'WORKSPACE_DIRECTORY_IS_REPO_ROOT',
      'workspace directory must be a non-root subdirectory of the experiment repository',
      root,
    );
  }
  if (!isStrictlyInside(relation)) {
    throw pathError(
      'WORKSPACE_DIRECTORY_OUTSIDE_REPO',
      'workspace directory must be inside the experiment repository',
      root,
    );
  }
}

async function nearestExistingRealpath(target) {
  let current = target;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertRealPathInsideRepo(root, repositoryRealPath) {
  const resolvedRealPath = await realpath(root);
  const relation = relative(repositoryRealPath, resolvedRealPath);
  if (relation === '') {
    throw pathError(
      'WORKSPACE_DIRECTORY_IS_REPO_ROOT',
      'workspace directory must be a non-root subdirectory of the experiment repository',
      root,
    );
  }
  if (!isStrictlyInside(relation)) {
    throw pathError(
      'WORKSPACE_DIRECTORY_OUTSIDE_REPO',
      'workspace directory resolves outside the experiment repository',
      root,
    );
  }
}

/**
 * The directory must be absent or empty, inside this repository, and below
 * the repository root. Existing data is never cleaned or overwritten.
 *
 * @param {{directory: string}} options
 */
export async function createWorkspace({ directory } = {}) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new TypeError('directory must be a non-empty path');
  }

  const root = resolve(directory);
  const repositoryRealPath = await realpath(REPO_ROOT);
  assertLexicallyInsideRepo(root);
  const paths = {
    labDirectory: join(root, 'lab'),
    sourceDirectory: join(root, 'lab', 'source'),
    rolesDirectory: join(root, 'lab', 'roles'),
    serviceFile: join(root, 'service.json'),
    consumerDirectory: join(root, 'consumer'),
    consumerAccess: join(root, 'consumer', 'access.js'),
    consumerConsumers: join(root, 'consumer', 'consumers.js'),
    initialDirectory: join(root, 'initial'),
    initialAccess: join(root, 'initial', 'access.js'),
    initialConsumers: join(root, 'initial', 'consumers.js'),
    initialService: join(root, 'initial', 'service.json'),
    operationsDirectory: join(root, 'operations'),
    handoffFile: join(root, 'operations', 'access-handoff.json'),
    evidenceDirectory: join(root, 'evidence'),
  };

  // The caller owns the parent directory. Only an absent or empty directory
  // is accepted; this fixture never deletes an existing user directory.
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const ancestorRealPath = await nearestExistingRealpath(root);
    const relation = relative(repositoryRealPath, ancestorRealPath);
    if (relation !== '' && !isStrictlyInside(relation)) {
      throw pathError(
        'WORKSPACE_DIRECTORY_OUTSIDE_REPO',
        'nearest existing workspace ancestor resolves outside the experiment repository',
        root,
      );
    }
    await mkdir(root, { recursive: true });
    await assertRealPathInsideRepo(root, repositoryRealPath);
  }
  if (rootInfo) {
    await assertRealPathInsideRepo(root, repositoryRealPath);
    if (!rootInfo.isDirectory()) {
      throw Object.assign(new Error('workspace directory must be a directory'), {
        code: 'WORKSPACE_DIRECTORY_NOT_DIRECTORY',
        directory: root,
      });
    }
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw Object.assign(new Error(
        'workspace directory must be empty; the fixture does not clean existing data',
      ), {
        code: 'WORKSPACE_DIRECTORY_NOT_EMPTY',
        directory: root,
        entries: entries.slice(0, 20),
      });
    }
  } else {
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw Object.assign(new Error(
        'workspace directory must be empty; the fixture does not clean existing data',
      ), {
        code: 'WORKSPACE_DIRECTORY_NOT_EMPTY',
        directory: root,
        entries: entries.slice(0, 20),
      });
    }
  }
  for (const owned of [
    paths.labDirectory,
    paths.consumerDirectory,
    paths.initialDirectory,
    paths.operationsDirectory,
    paths.evidenceDirectory,
  ]) {
    await mkdir(owned, { recursive: true });
  }

  // The initial modules are copied, not rewritten. consumer/ is the working
  // copy; initial/ remains the frozen snapshot for later comparison.
  for (const [source, target] of [
    [INITIAL_ACCESS, paths.consumerAccess],
    [INITIAL_ACCESS, paths.initialAccess],
    [CONSUMERS, paths.consumerConsumers],
    [CONSUMERS, paths.initialConsumers],
  ]) {
    await copyFile(source, target);
  }

  let lab;
  let artifact;
  let backend;
  let gateway;
  let initialSnapshot;
  let forwarder = null;
  let evolution = null;
  let closePromise = null;
  let closed = false;

  try {
    lab = await createOperationsLab({ directory: paths.labDirectory });
    artifact = await lab.build();
    backend = await lab.startBackend({ role: BACKEND_ROLE });
    gateway = await lab.startGateway({
      role: GATEWAY_ROLE,
      artifact,
      upstreamUrl: backend.url,
    });

    const service = {
      role: gateway.role,
      baseUrl: gateway.url,
      instanceId: gateway.instanceId,
    };
    await writeJsonFile(paths.serviceFile, service);
    await writeJsonFile(paths.initialService, service);

    initialSnapshot = {
      capturedAt: new Date().toISOString(),
      gateway: { role: gateway.role, url: gateway.url, instanceId: gateway.instanceId },
      files: await Promise.all([
        fileWitness(root, paths.initialAccess),
        fileWitness(root, paths.initialConsumers),
        fileWitness(root, paths.initialService),
        fileWitness(root, paths.consumerAccess),
        fileWitness(root, paths.consumerConsumers),
        fileWitness(root, paths.serviceFile),
      ]),
    };
  } catch (error) {
    if (lab) {
      try {
        await lab.close();
      } catch (closeError) {
        error.closeError = closeError;
      }
    }
    throw error;
  }

  function ensureOpen() {
    if (closed) throw new Error('evolution workspace is closed');
  }

  function currentGateway() {
    ensureOpen();
    const entry = lab.registry().find(item => item.role === GATEWAY_ROLE);
    if (!entry) throw new Error('gateway role disappeared from the operations lab');
    return {
      role: entry.role,
      url: entry.url,
      instanceId: entry.instanceId,
      state: entry.state,
    };
  }

  async function evolveAccess() {
    ensureOpen();
    if (evolution) return evolution;

    const previous = currentGateway();
    if (previous.state !== 'running' || !previous.url) {
      throw new Error('gateway is not running; access cannot be evolved from a stopped process');
    }

    // Retiring the old address means stopping that exact process. The lab
    // restarts the role on a fresh ephemeral port and a fresh instanceId. A
    // repeated restart is only to avoid the unlikely case where the kernel
    // hands the same port back; it is not an assertion about uniqueness.
    let current = previous;
    let restarts = 0;
    do {
      current = await lab.restartGateway(GATEWAY_ROLE);
      restarts += 1;
    } while (current.url === previous.url && restarts < DISTINCT_ADDRESS_ATTEMPTS);
    if (current.url === previous.url) {
      throw new Error('gateway restarted on the retired address; access evolution aborted');
    }

    const pathToken = randomBytes(18).toString('hex');
    const routeToken = randomBytes(18).toString('hex');
    const pathPrefix = `/gateway/${pathToken}`;

    // Starting the proxy after the gateway restart gives the kernel a chance
    // to hand the retired port to the proxy. That would contradict the
    // experiment's "old address is retired" observation, so close and retry
    // if the proxy lands on the old origin.
    let forwarderAttempts = 0;
    try {
      while (!forwarder && forwarderAttempts < DISTINCT_ADDRESS_ATTEMPTS) {
        forwarderAttempts += 1;
        const candidate = await startAccessForwarder({
          targetUrl: current.url,
          pathPrefix,
          route: { name: ROUTE_HEADER, value: routeToken },
        });
        if (candidate.url === previous.url) {
          await candidate.close();
          continue;
        }
        forwarder = candidate;
      }
    } catch (error) {
      throw Object.assign(new Error(`restricted access entry could not be started: ${error.message}`, {
        cause: error,
      }), { previous, current });
    }
    if (!forwarder) {
      throw Object.assign(
        new Error('restricted access entry kept landing on the retired gateway address'),
        { previous, current },
      );
    }

    const handoff = {
      schemaVersion: 1,
      kind: 'gateway-access',
      issuedAt: new Date().toISOString(),
      issuedBy: 'tests/14-workspace-evolution/fixture.js',
      service: {
        role: current.role,
        instanceId: current.instanceId,
      },
      entry: {
        baseUrl: forwarder.url,
        pathPrefix,
        headers: { [ROUTE_HEADER]: routeToken },
        allowedMethods: ['GET', 'HEAD'],
      },
      verification: {
        diagnostics: `${forwarder.url}${pathPrefix}/diagnostics`,
        check: `${forwarder.url}${pathPrefix}/check`,
      },
      retired: {
        baseUrl: previous.url,
        instanceId: previous.instanceId,
      },
      notes: [
        'service.json is the retired direct snapshot; its address is not current.',
        'Every request requires both the path prefix and the routing header.',
        'Verify live diagnostics role and instanceId against this handoff before acting.',
      ],
    };
    const serialized = `${JSON.stringify(handoff, null, 2)}\n`;
    const temporary = `${paths.handoffFile}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, serialized, 'utf8');
      await rename(temporary, paths.handoffFile);
    } catch (error) {
      await rm(temporary, { force: true });
      try {
        await forwarder.close();
      } catch (closeError) {
        error.closeError = closeError;
      } finally {
        forwarder = null;
      }
      throw error;
    }

    evolution = {
      previous: {
        role: previous.role,
        url: previous.url,
        instanceId: previous.instanceId,
      },
      current: {
        role: current.role,
        url: current.url,
        instanceId: current.instanceId,
      },
      restarts,
      forwarderAttempts,
      handoffFile: paths.handoffFile,
      handoffSha256: sha256(Buffer.from(serialized, 'utf8')),
      entry: {
        baseUrl: forwarder.url,
        pathPrefix,
        headers: { [ROUTE_HEADER]: routeToken },
        allowedMethods: ['GET', 'HEAD'],
      },
      retired: {
        baseUrl: previous.url,
        instanceId: previous.instanceId,
      },
    };

    workspace.access = {
      role: current.role,
      instanceId: current.instanceId,
      baseUrl: forwarder.url,
      pathPrefix,
      headers: { [ROUTE_HEADER]: routeToken },
      handoffFile: paths.handoffFile,
      retiredDirectUrl: previous.url,
    };
    return evolution;
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const errors = [];
      if (forwarder) {
        const resource = forwarder;
        forwarder = null;
        try {
          await resource.close();
        } catch (error) {
          errors.push(new Error(`access forwarder: ${error.message}`, { cause: error }));
        }
      }
      try {
        await lab.close();
      } catch (error) {
        errors.push(new Error(`operations lab: ${error.message}`, { cause: error }));
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'some workspace resources did not stop cleanly');
      }
    })();
    return closePromise;
  }

  const workspace = {
    directory: root,
    lab,
    artifact,
    backend,
    gateway,
    paths,
    labDirectory: paths.labDirectory,
    sourceDir: paths.sourceDirectory,
    rolesDir: paths.rolesDirectory,
    initialSnapshot,
    currentGateway,
    evolveAccess,
    close,
    // Populated only after evolveAccess(); gateway remains the initial
    // snapshot so callers cannot confuse the retired identity with the
    // current one by reading one field.
    access: null,
  };
  return workspace;
}
