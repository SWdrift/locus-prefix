#!/usr/bin/env node
/**
 * Restricted loopback HTTP entry for one already-running service process.
 *
 * The proxy knows a single fixed upstream. It is not a general gateway and
 * does not implement service discovery, TLS, authentication, or retries.
 * Exactly two local conventions gate forwarding:
 *   1. the request path must start with the configured prefix, and
 *   2. the request must carry the configured routing header.
 *
 * The prefix and header value are issued as a pair in the operations handoff.
 * A request missing either one never reaches the upstream. Configuration only
 * comes from process arguments; diagnostics are never invented here.
 */
import { createServer } from 'node:http';

const UPSTREAM_TIMEOUT_MS = 5000;
const BODY_LIMIT = 1024 * 1024;
const HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  const values = { target: null, prefix: null, headerName: null, headerValue: null };
  for (const argument of argv) {
    if (!argument.startsWith('--')) throw fail('invalid-arguments', 'unexpected proxy argument');
    const equals = argument.indexOf('=');
    if (equals === -1) throw fail('invalid-arguments', 'proxy arguments require =values');
    const name = argument.slice(2, equals);
    const value = argument.slice(equals + 1);
    if (name === 'target') values.target = value;
    else if (name === 'prefix') values.prefix = value;
    else if (name === 'header-name') values.headerName = value;
    else if (name === 'header-value') values.headerValue = value;
    else throw fail('invalid-arguments', 'unknown proxy argument');
  }

  let target;
  try {
    target = new URL(values.target ?? '');
  } catch {
    throw fail('invalid-arguments', 'target must be an absolute http(s) URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw fail('invalid-arguments', 'target must use http or https');
  }

  const prefix = values.prefix;
  if (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix.length < 2 ||
      prefix.endsWith('/') || /[?#\s]/.test(prefix)) {
    throw fail('invalid-arguments', 'prefix must be an absolute path without query, fragment, or trailing slash');
  }
  const headerName = values.headerName;
  if (typeof headerName !== 'string' || !HEADER_NAME_PATTERN.test(headerName)) {
    throw fail('invalid-arguments', 'header-name must be a lowercase HTTP header name');
  }
  if (typeof values.headerValue !== 'string' || values.headerValue.length === 0) {
    throw fail('invalid-arguments', 'header-value is required');
  }

  return {
    targetOrigin: target.origin,
    prefix,
    headerName,
    headerValue: values.headerValue,
  };
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function requestPath(requestUrl) {
  // Node gives an origin-form target for proxied requests; parsing against a
  // fixed base also tolerates absolute-form targets without trusting the host.
  const parsed = new URL(requestUrl ?? '/', 'http://edge.invalid');
  return { pathname: parsed.pathname, search: parsed.search };
}

function stripPrefix(pathname, prefix) {
  if (pathname === prefix) return '/';
  return pathname.slice(prefix.length);
}

async function forward({ method, targetOrigin, suffix, search, accept }) {
  let response;
  try {
    response = await fetch(`${targetOrigin}${suffix}${search}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: accept ? { accept } : {},
    });
  } catch {
    return { status: 502, body: null, contentType: null, cacheControl: null };
  }

  if (method === 'HEAD' || response.status === 204 || response.status === 304) {
    return {
      status: response.status,
      body: null,
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
    };
  }

  let body;
  try {
    body = Buffer.from(await response.arrayBuffer());
  } catch {
    return { status: 502, body: null, contentType: null, cacheControl: null };
  }
  if (body.length > BODY_LIMIT) {
    return { status: 502, body: null, contentType: null, cacheControl: null };
  }
  return {
    status: response.status,
    body,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
  };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createServer(async (request, response) => {
    try {
      const { pathname, search } = requestPath(request.url);
      if (pathname !== options.prefix && !pathname.startsWith(`${options.prefix}/`)) {
        sendJson(response, 404, { error: 'outside-route-prefix' });
        return;
      }
      if (request.headers[options.headerName] !== options.headerValue) {
        sendJson(response, 403, { error: 'route-header-required' });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      const suffix = stripPrefix(pathname, options.prefix);
      const upstream = await forward({
        method: request.method,
        targetOrigin: options.targetOrigin,
        suffix: suffix.startsWith('/') ? suffix : `/${suffix}`,
        search,
        accept: request.headers.accept,
      });

      if (upstream.body === null) {
        const headers = {
          'content-type': upstream.contentType ?? 'application/json; charset=utf-8',
          'cache-control': upstream.cacheControl ?? 'no-store',
        };
        if (upstream.status === 502) {
          sendJson(response, 502, { error: 'upstream-unreachable' });
          return;
        }
        response.writeHead(upstream.status, headers);
        response.end();
        return;
      }

      response.writeHead(upstream.status, {
        'content-type': upstream.contentType ?? 'application/octet-stream',
        'content-length': upstream.body.length,
        'cache-control': upstream.cacheControl ?? 'no-store',
      });
      response.end(upstream.body);
    } catch {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: 'proxy-request-failed' });
    }
  });
  server.on('clientError', (error, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      resolve(address.port);
    });
  });

  installShutdown(server);
  const address = server.address();
  process.stdout.write(`${JSON.stringify({
    event: 'ready',
    url: `http://127.0.0.1:${address.port}`,
  })}\n`);
}

main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'startup-failed';
  process.stderr.write(`${JSON.stringify({ event: 'startup-error', code })}\n`);
  process.exitCode = 1;
});
