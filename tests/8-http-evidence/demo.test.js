/**
 * 实验 8：部署验收的 HTTP 证据采集边界。
 *
 * 运行：`node --test tests/8-http-evidence/demo.test.js`
 *
 * 使用本机临时 HTTP server（端口由系统分配）观察真实传输行为：
 * 非 2xx 响应体保留、200 的 HTML 不被当成结构成功、字节上限截断、
 * 连接中途断开、响应头与响应体阶段的超时、302 不被自动跟随。
 * server 与连接在测试结束时关闭，不写系统临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readHttp } from '../../packages/deployment-audit/http.js';
import { observeRelease } from '@locus/deployment-audit';

async function serve(t, handler) {
  const server = createServer(handler);
  server.on('clientError', (error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('non-2xx body is evidence, not an exception', async t => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"not here"}');
      return;
    }
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('unexpected path');
  });

  const missing = await readHttp(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.contentType, 'application/json; charset=utf-8');
  assert.equal(missing.body, '{"error":"not here"}');
  assert.equal(missing.complete, true);
  assert.equal(missing.error, null);
});

test('200 with an HTML body is preserved as HTML, not converted into success semantics', async t => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Sign in</title>');
  });

  const result = await readHttp(base, { timeoutMs: 2000 });
  assert.equal(result.status, 200);
  assert.match(result.contentType, /^text\/html/);
  assert.match(result.body, /<title>Sign in<\/title>/);
  assert.equal(result.complete, true);
  assert.equal(result.error, null);
  // Transport keeps the bytes; the domain layer must not read this as JSON identity.
  assert.throws(() => JSON.parse(result.body), SyntaxError);
});

test('302 is recorded without following the redirect', async t => {
  let targetHits = 0;
  const base = await serve(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, {
        location: '/target',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('see target');
      return;
    }
    targetHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('target body');
  });

  const result = await readHttp(`${base}/redirect`, { timeoutMs: 2000 });
  assert.equal(result.status, 302);
  assert.equal(result.body, 'see target');
  assert.equal(result.error, null);
  assert.equal(result.complete, true);
  assert.equal(targetHits, 0, 'manual redirect must not request the target');
});

test('maxBytes truncation is marked incomplete and keeps the known prefix', async t => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('a'.repeat(4096));
  });

  const result = await readHttp(base, { timeoutMs: 2000, maxBytes: 1024 });
  assert.equal(result.status, 200);
  assert.equal(result.body, 'a'.repeat(1024));
  assert.equal(result.complete, false);
  assert.equal(result.error.kind, 'truncated');
  assert.equal(result.sha256, null);
});

test('a body interrupted mid-flight preserves status and partial bytes', async t => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '1000',
    });
    res.write('{"partial":');
    setTimeout(() => res.destroy(), 20);
  });

  const result = await readHttp(base, { timeoutMs: 3000 });
  assert.equal(result.status, 200);
  assert.equal(result.complete, false);
  assert.ok(result.body.startsWith('{"partial":'), result.body);
  assert.equal(result.error.kind, 'body');
  assert.equal(result.sha256, null);
  // A cut JSON document must not be mistaken for complete structural evidence.
  assert.throws(() => JSON.parse(result.body), SyntaxError);
});

test('timeout before response headers leaves status unknown', async t => {
  const base = await serve(t, () => {
    // Deliberately never respond.
  });

  const result = await readHttp(base, { timeoutMs: 150 });
  assert.equal(result.status, null);
  assert.equal(result.contentType, null);
  assert.equal(result.body, '');
  assert.equal(result.complete, false);
  assert.equal(result.error.kind, 'timeout');
  assert.equal(result.sha256, null);
});

test('timeout while reading the body keeps the received status and prefix', async t => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '100',
    });
    res.write('head');
    // Deliberately stall after partial bytes.
  });

  const result = await readHttp(base, { timeoutMs: 200 });
  assert.equal(result.status, 200);
  assert.equal(result.body, 'head');
  assert.equal(result.complete, false);
  assert.equal(result.error.kind, 'timeout');
});

test('payload identity comes from exact response bytes, not a metadata claim or decoded text', async t => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('asset-a')]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const base = await serve(t, (req, res) => {
    if (req.url === '/metadata') {
      res.end(JSON.stringify({ release: 'release-a', sourceRevision: 'revision-a', payloadSha256: '0'.repeat(64) }));
    } else {
      res.end(bytes);
    }
  });
  const observed = await observeRelease({ metadataUrl: `${base}/metadata`, payloadUrl: `${base}/payload` });
  assert.equal(observed.runtime.payloadSha256, digest);
  assert.notEqual(observed.runtime.payloadSha256, '0'.repeat(64));
  assert.notEqual(digest, createHash('sha256').update(observed.payload.body).digest('hex'));
});

test('an HTML fallback cannot become release identity just because HTTP succeeded', async t => {
  const base = await serve(t, (req, res) => res.end('<html>Application shell</html>'));
  const observed = await observeRelease({ metadataUrl: base });
  assert.equal(observed.metadata.status, 200);
  assert.equal(observed.runtime, null);
});

test('observations do not reuse an earlier runtime identity after the target changes', async t => {
  let release = 'release-a';
  const base = await serve(t, (req, res) => res.end(JSON.stringify({ release, sourceRevision: release })));
  const first = await observeRelease({ metadataUrl: base });
  release = 'release-b';
  const second = await observeRelease({ metadataUrl: base });
  assert.equal(first.runtime.release, 'release-a');
  assert.equal(second.runtime.release, 'release-b');
});
