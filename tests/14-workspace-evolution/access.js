import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROXY_PATH = fileURLToPath(new URL('./access-proxy.mjs', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 5000;
const HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function accessError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireHttpUrl(value, label) {
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
  return parsed;
}

function edgeUrl(baseUrl, pathPrefix, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}${pathPrefix}${pathname}`;
}

async function fetchDiagnostics(entry, expected) {
  let response;
  try {
    response = await fetch(edgeUrl(entry.baseUrl, entry.pathPrefix ?? '', '/diagnostics'), {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
      headers: entry.headers,
    });
  } catch (error) {
    throw accessError('ACCESS_UNREACHABLE', `diagnostics request failed: ${error.message}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    try {
      await response.arrayBuffer();
    } catch {
      // The status is the evidence; an unreadable error body is not required.
    }
    throw accessError('NOT_READY', `diagnostics HTTP ${response.status}`, {
      status: response.status,
    });
  }

  let diagnostics;
  try {
    diagnostics = await response.json();
  } catch {
    throw accessError('INVALID_OBSERVATION', 'diagnostics response is not valid JSON');
  }
  if (!isRecord(diagnostics) || typeof diagnostics.role !== 'string' ||
      typeof diagnostics.instanceId !== 'string' || diagnostics.instanceId.length === 0) {
    throw accessError('INVALID_OBSERVATION', 'diagnostics response lacks role or instanceId');
  }
  if (diagnostics.role !== expected.role || diagnostics.instanceId !== expected.instanceId) {
    throw accessError(
      'WRONG_TARGET',
      `target identity mismatch: expected ${expected.role}/${expected.instanceId}, `
        + `observed ${diagnostics.role}/${diagnostics.instanceId}`,
      {
        expectedRole: expected.role,
        expectedInstanceId: expected.instanceId,
        observedRole: diagnostics.role,
        observedInstanceId: diagnostics.instanceId,
      },
    );
  }
  return diagnostics;
}

async function fetchRequestStatus(entry) {
  let response;
  try {
    response = await fetch(edgeUrl(entry.baseUrl, entry.pathPrefix ?? '', '/check'), {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
      headers: entry.headers,
    });
  } catch (error) {
    throw accessError('ACCESS_UNREACHABLE', `check request failed: ${error.message}`, {
      cause: error,
    });
  }
  await response.arrayBuffer();
  return response.status;
}

async function inspectEntry(entry, expected) {
  const diagnostics = await fetchDiagnostics(entry, expected);
  const requestStatus = await fetchRequestStatus(entry);
  return { ...diagnostics, requestStatus };
}

function validateHeaders(headers) {
  if (!isRecord(headers)) throw new TypeError('handoff entry.headers must be a JSON object');
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name) || typeof value !== 'string' || value.length === 0) {
      throw new TypeError('handoff entry.headers must map header names to non-empty strings');
    }
    result[name] = value;
  }
  return result;
}

function parseHandoff(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'gateway-access') {
    throw accessError('INVALID_HANDOFF', 'operations handoff is not a gateway-access v1 document');
  }
  if (!isRecord(value.service) ||
      typeof value.service.role !== 'string' || value.service.role.length === 0 ||
      typeof value.service.instanceId !== 'string' || value.service.instanceId.length === 0) {
    throw accessError('INVALID_HANDOFF', 'operations handoff lacks service.role or service.instanceId');
  }
  if (!isRecord(value.entry)) {
    throw accessError('INVALID_HANDOFF', 'operations handoff lacks an access entry');
  }
  requireHttpUrl(value.entry.baseUrl, 'handoff entry.baseUrl');
  if (typeof value.entry.pathPrefix !== 'string' ||
      !value.entry.pathPrefix.startsWith('/') || value.entry.pathPrefix.length < 2) {
    throw accessError('INVALID_HANDOFF', 'operations handoff entry.pathPrefix must be an absolute path');
  }
  const headers = validateHeaders(value.entry.headers);
  return {
    service: { role: value.service.role, instanceId: value.service.instanceId },
    entry: {
      baseUrl: value.entry.baseUrl,
      pathPrefix: value.entry.pathPrefix,
      headers,
    },
  };
}

/**
 * Original direct consumer: read the captured service descriptor and inspect
 * that exact role and instance. The descriptor is the old snapshot; after an
 * access change its address may be dead. This function deliberately does not
 * discover replacement entries.
 */
export async function inspectGateway(directory) {
  let service;
  try {
    service = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
  } catch (error) {
    throw accessError('SERVICE_DESCRIPTOR_UNREADABLE', 'service.json could not be read as JSON', {
      cause: error,
    });
  }
  if (!isRecord(service) || typeof service.role !== 'string' ||
      typeof service.instanceId !== 'string' || service.instanceId.length === 0) {
    throw accessError('SERVICE_DESCRIPTOR_INVALID', 'service.json requires role and instanceId');
  }
  requireHttpUrl(service.baseUrl, 'service.baseUrl');
  return inspectEntry(
    { baseUrl: service.baseUrl, pathPrefix: '', headers: {} },
    { role: service.role, instanceId: service.instanceId },
  );
}

/**
 * Consumer-side handoff reader. This is an explicit adaptation, not an
 * automatic property of the fixture or of the service process. Both the role
 * and the instanceId written in the handoff must match the live diagnostics;
 * a matching role label alone is not accepted.
 */
export async function inspectGatewayFromHandoff(directory, options = {}) {
  const handoffFile = resolve(directory, options.handoffFile ?? join('operations', 'access-handoff.json'));
  let document;
  try {
    document = JSON.parse(await readFile(handoffFile, 'utf8'));
  } catch (error) {
    throw accessError('HANDOFF_UNREADABLE', 'operations handoff could not be read as JSON', {
      cause: error,
      handoffFile,
    });
  }
  const handoff = parseHandoff(document);
  const observed = await inspectEntry(handoff.entry, handoff.service);
  return observed;
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
    // The process may already be terminating; the waits below are authoritative.
  }
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Fall through to the final wait; close must not hang forever.
  }
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    throw new Error('access forwarder did not exit after SIGTERM/SIGKILL');
  }
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stderrTail = '';
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      finish(new Error('access forwarder did not announce readiness in time'));
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
      finish(new Error(`access forwarder could not be spawned (${error?.code ?? 'spawn-error'})`));
    };
    const onExit = (code, signal) => {
      const detail = stderrTail.trim();
      finish(new Error(
        `access forwarder exited before readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
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
    throw new Error('access forwarder announced an invalid URL');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('access forwarder announced a URL outside the expected local endpoint');
  }
  return parsed.origin;
}

/**
 * Start a real child HTTP process in front of one fixed upstream. The caller
 * receives the prefix and required header that consumers must present; they
 * are not written anywhere automatically.
 */
export async function startAccessForwarder({ targetUrl, pathPrefix, route } = {}) {
  requireHttpUrl(targetUrl, 'targetUrl');
  if (typeof pathPrefix !== 'string' || !pathPrefix.startsWith('/') ||
      pathPrefix.length < 2 || pathPrefix.endsWith('/') || /[?#\s]/.test(pathPrefix)) {
    throw new TypeError('pathPrefix must be an absolute path without query, fragment, or trailing slash');
  }
  if (!isRecord(route) || typeof route.name !== 'string' || !HEADER_NAME_PATTERN.test(route.name) ||
      typeof route.value !== 'string' || route.value.length === 0) {
    throw new TypeError('route must provide a lowercase header name and non-empty value');
  }

  const child = spawn(process.execPath, [
    PROXY_PATH,
    `--target=${targetUrl}`,
    `--prefix=${pathPrefix}`,
    `--header-name=${route.name}`,
    `--header-value=${route.value}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  try {
    const ready = await waitForReady(child);
    child.stdout.resume();
    child.stderr.resume();
    let closed = false;
    return {
      url: validateReadyUrl(ready.url),
      pathPrefix,
      headers: { [route.name]: route.value },
      async close() {
        if (closed) return;
        closed = true;
        await stopChild(child);
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
