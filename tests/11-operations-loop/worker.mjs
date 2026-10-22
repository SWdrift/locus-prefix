#!/usr/bin/env node
/**
 * Standalone demo service process for the operations lab.
 *
 * Two modes share one file so that the gateway artifact (and its Git source)
 * can be inspected as real bytes:
 * - backend: a local readiness probe target; can be "retired" (HTTP 410 on
 *   /value while /healthz stays green).
 * - gateway: reads deployed config.json/environment.json once at startup,
 *   allows environment.UPSTREAM_URL to override config.upstreamUrl, serves
 *   release metadata and payload bytes, and checks the upstream over real HTTP.
 *
 * Deliberately dependency-free and environment-agnostic: configuration comes
 * from files, never from process.env. Diagnostics expose only demo
 * configuration fields, never environment variables or filesystem paths.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const CONFIG_MODEL = 'environment-over-file-at-startup-v1';
const UPSTREAM_TIMEOUT_MS = 3000;
const UPSTREAM_BODY_LIMIT = 65536;

function parseArgs(argv) {
  const values = { mode: null, role: null, instance: null, retired: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--retired') {
      values.retired = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw startupError('invalid-arguments', 'unexpected worker argument');
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (name === 'mode') values.mode = value;
    else if (name === 'role') values.role = value;
    else if (name === 'instance') values.instance = value;
    else if (name === 'retired') values.retired = value === 'true' || value === '1';
    else throw startupError('invalid-arguments', 'unknown worker argument');
  }
  if (values.mode !== 'backend' && values.mode !== 'gateway') {
    throw startupError('invalid-arguments', 'mode must be backend or gateway');
  }
  if (typeof values.role !== 'string' || values.role.length === 0) {
    throw startupError('invalid-arguments', 'role is required');
  }
  if (typeof values.instance !== 'string' || values.instance.length === 0) {
    throw startupError('invalid-arguments', 'instance is required');
  }
  return values;
}

function startupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendText(response, status, value) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(value),
    'cache-control': 'no-store',
  });
  response.end(value);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

function installShutdown(server) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function announceReady({ role, instance, url }) {
  process.stdout.write(`${JSON.stringify({ event: 'ready', role, instance, url })}\n`);
}

async function runBackend({ role, instance, retired }) {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok', service: role });
        return;
      }
      if (pathname === '/value') {
        if (retired) {
          sendJson(response, 410, { service: role, status: 'retired' });
        } else {
          sendJson(response, 200, { service: role, value: 'ready' });
        }
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    } catch {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: 'request-failed' });
    }
  });
  server.on('clientError', (error, socket) => socket.destroy());
  const port = await listen(server);
  installShutdown(server);
  announceReady({ role, instance, url: `http://127.0.0.1:${port}` });
}

async function readDocument(name, codeBase) {
  let bytes;
  try {
    bytes = await readFile(join(process.cwd(), name));
  } catch {
    throw startupError(`${codeBase}-unreadable`, `${name} could not be read`);
  }
  const text = bytes.toString('utf8');
  if (name === 'environment.json' && text.trim().length === 0) {
    return { bytes, value: {} };
  }
  try {
    return { bytes, value: JSON.parse(text) };
  } catch {
    throw startupError(`${codeBase}-invalid`, `${name} is not valid JSON`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBase(url) {
  return url.replace(/\/+$/, '');
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readGatewayStartup() {
  const configDocument = await readDocument('config.json', 'config');
  if (!isRecord(configDocument.value) || !isValidHttpUrl(configDocument.value.upstreamUrl)) {
    throw startupError('config-invalid', 'config.json requires an absolute http(s) upstreamUrl');
  }

  const environmentDocument = await readDocument('environment.json', 'environment');
  if (!isRecord(environmentDocument.value)) {
    throw startupError('environment-invalid', 'environment.json must contain a JSON object');
  }
  const environmentUpstream = environmentDocument.value.UPSTREAM_URL;
  const hasEnvironmentOverride =
    typeof environmentUpstream === 'string' && environmentUpstream.trim().length > 0;
  if (hasEnvironmentOverride && !isValidHttpUrl(environmentUpstream)) {
    throw startupError('environment-invalid', 'UPSTREAM_URL must be an absolute http(s) URL');
  }

  const manifestDocument = await readDocument('manifest.json', 'manifest');
  if (!isRecord(manifestDocument.value) ||
      typeof manifestDocument.value.release !== 'string' ||
      manifestDocument.value.release.length === 0 ||
      typeof manifestDocument.value.sourceRevision !== 'string' ||
      manifestDocument.value.sourceRevision.length === 0) {
    throw startupError('manifest-invalid', 'manifest.json requires release and sourceRevision');
  }

  const fileUpstreamUrl = configDocument.value.upstreamUrl;
  return {
    release: manifestDocument.value.release,
    sourceRevision: manifestDocument.value.sourceRevision,
    configSha256: createHash('sha256').update(configDocument.bytes).digest('hex'),
    configuration: {
      model: CONFIG_MODEL,
      fileUpstreamUrl,
      effectiveUpstreamUrl: hasEnvironmentOverride ? environmentUpstream : fileUpstreamUrl,
      source: hasEnvironmentOverride ? 'environment' : 'file',
    },
  };
}

async function readUpstream(checkUrl) {
  let response;
  try {
    response = await fetch(checkUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: 'application/json, text/plain;q=0.9' },
    });
  } catch {
    return { reachable: false, status: null, body: null };
  }
  let text;
  try {
    text = (await response.text()).slice(0, UPSTREAM_BODY_LIMIT);
  } catch {
    return { reachable: false, status: response.status, body: null };
  }
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text; demo backends normally answer JSON.
  }
  return { reachable: true, status: response.status, body };
}

async function runGateway({ role, instance }) {
  const startup = await readGatewayStartup();
  const checkUrl = `${normalizeBase(startup.configuration.effectiveUpstreamUrl)}/value`;

  const diagnostics = () => ({
    role,
    instanceId: instance,
    release: startup.release,
    sourceRevision: startup.sourceRevision,
    configuration: {
      ...startup.configuration,
      configSha256: startup.configSha256,
    },
  });

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    try {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok', service: role, instanceId: instance });
        return;
      }
      if (pathname === '/_release.json') {
        sendJson(response, 200, {
          release: startup.release,
          sourceRevision: startup.sourceRevision,
        });
        return;
      }
      if (pathname === '/payload') {
        const bytes = await readFile(join(process.cwd(), 'worker.mjs'));
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': bytes.length,
          'cache-control': 'no-store',
        });
        response.end(bytes);
        return;
      }
      if (pathname === '/diagnostics') {
        sendJson(response, 200, diagnostics());
        return;
      }
      if (pathname === '/check') {
        const upstream = await readUpstream(checkUrl);
        if (!upstream.reachable) {
          sendJson(response, 502, {
            status: 'failed',
            upstreamStatus: upstream.status,
          });
          return;
        }
        if (upstream.status < 200 || upstream.status > 299) {
          sendJson(response, 502, {
            status: 'failed',
            upstreamStatus: upstream.status,
            upstream: upstream.body,
          });
          return;
        }
        sendJson(response, 200, {
          status: 'ok',
          upstreamStatus: upstream.status,
          upstream: upstream.body,
        });
        return;
      }
      sendText(response, 404, 'not found');
    } catch {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: 'request-failed' });
    }
  });
  server.on('clientError', (error, socket) => socket.destroy());
  const port = await listen(server);
  installShutdown(server);
  announceReady({ role, instance, url: `http://127.0.0.1:${port}` });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'backend') {
    await runBackend(options);
    return;
  }
  await runGateway(options);
}

main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'startup-failed';
  const message = typeof error?.message === 'string' && /^[a-z-]+$/.test(code)
    ? error.message
    : 'worker failed to start';
  process.stderr.write(`${JSON.stringify({ event: 'startup-error', code, message })}\n`);
  process.exitCode = 1;
});
