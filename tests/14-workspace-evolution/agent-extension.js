/**
 * Read-only operations handoff for the live workspace.
 *
 * Input is exactly the public session receipt plus an empty output directory.
 * The consumer observes the receipt's delivery target and GIS over their
 * current HTTP interfaces, derives GIS layer names and bounds from the live
 * capabilities document, and evaluates the persisted troubleshooting records
 * without mutating them. It never reads the lab/registry closure, never writes
 * target configuration, and never restarts or deploys anything.
 *
 * Output is a self-contained directory:
 *   handoff.json                 overall verdict, facility summaries, file digests
 *   handoff.md                   operator-facing notes derived from the same run
 *   gateway.json                 fresh health/readiness/release/upstream evidence
 *   gis.json                     capabilities, advertised layers and map evidence
 *   gis/capabilities.xml         the raw capabilities document read at run time
 *   maps/<NN>-<layer>.png        one small map per advertised layer
 *   knowledge.json               applicability/refusal assessment, no mutations
 *   failure.json                 only when the receipt cannot be read at all
 *
 * A facility that fails keeps its own evidence; `ok` is true only when the
 * live gateway, the live GIS and the knowledge assessment all complete.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { observeRelease } from '@locus/deployment-audit';
import { getCapabilities, getMap } from './wms-client.js';
import { evaluateKnowledgeFile } from './knowledge.js';

const HTTP_TIMEOUT_MS = 8000;
const MAX_HTTP_BYTES = 8 * 1024 * 1024;
const MAP_WIDTH = 48;
const MAP_HEIGHT = 36;
const KNOWLEDGE_FILE_NAME = 'operational-knowledge.json';
const WMS_VERSION = '1.3.0';
const WMS_CRS = 'EPSG:4326';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

function endpoint(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function addCheck(checks, id, pass, reason, details = {}) {
  checks.push({
    id,
    status: pass ? 'pass' : 'fail',
    reason,
    details,
  });
}

function allChecksPass(checks) {
  return checks.length > 0 && checks.every(check => check.status === 'pass');
}

async function readHttp(url, options = {}) {
  const startedAt = Date.now();
  const accept = options.accept ?? 'application/json';
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept },
    });
  } catch (error) {
    return {
      url,
      status: null,
      contentType: null,
      byteLength: 0,
      sha256: null,
      text: null,
      body: null,
      bytes: null,
      error: {
        kind: error?.name === 'TimeoutError' ? 'timeout' : 'network',
        message: error?.message ?? String(error),
      },
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      elapsedMs: Date.now() - startedAt,
    };
  }

  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return {
      url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      byteLength: 0,
      sha256: null,
      text: null,
      body: null,
      bytes: null,
      error: { kind: 'response-read-failed', message: error?.message ?? String(error) },
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      elapsedMs: Date.now() - startedAt,
    };
  }

  const tooLarge = bytes.length > MAX_HTTP_BYTES;
  const text = tooLarge ? null : bytes.toString('utf8');
  let body = null;
  if (options.parseJson === true && !tooLarge) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  return {
    url,
    status: response.status,
    contentType: response.headers.get('content-type'),
    byteLength: bytes.length,
    sha256: sha256(bytes),
    text,
    body,
    bytes,
    error: tooLarge
      ? { kind: 'response-too-large', message: `response exceeded ${MAX_HTTP_BYTES} bytes` }
      : null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    elapsedMs: Date.now() - startedAt,
  };
}

// Keep raw bytes out of the persisted JSON while preserving the observation.
function httpSummary(observation) {
  return {
    url: observation.url,
    status: observation.status,
    contentType: observation.contentType,
    byteLength: observation.byteLength,
    sha256: observation.sha256,
    elapsedMs: observation.elapsedMs,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
    error: observation.error,
    body: observation.body,
  };
}

// Adapt the deployment-audit transport observation without re-implementing
// its release/payload collection. Metadata is parsed for evidence; payload
// text is deliberately not persisted.
function releaseObservationSummary(observation, parseBody) {
  if (!isRecord(observation)) return null;
  let body = null;
  if (parseBody && typeof observation.body === 'string') {
    try {
      body = JSON.parse(observation.body);
    } catch {
      body = null;
    }
  }
  return {
    url: observation.url,
    status: observation.status,
    contentType: observation.contentType,
    byteLength: Buffer.byteLength(observation.body ?? '', 'utf8'),
    sha256: observation.sha256,
    complete: observation.complete === true,
    elapsedMs: observation.elapsedMs,
    observedAt: observation.observedAt ?? null,
    startedAt: observation.observedAt ?? null,
    finishedAt: null,
    error: observation.error,
    body,
    source: 'deployment-audit.observeRelease',
  };
}

async function readReceipt(receiptFile) {
  const bytes = await readFile(receiptFile);
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw Object.assign(new Error(`receipt is not valid JSON: ${error.message}`), {
      code: 'RECEIPT_INVALID',
    });
  }
  if (!isRecord(document)) {
    throw Object.assign(new Error('receipt is not a JSON object'), { code: 'RECEIPT_INVALID' });
  }
  if (!isRecord(document.delivery) || !isHttpUrl(document.delivery.url)) {
    throw Object.assign(new Error('receipt lacks a usable delivery.url'), { code: 'RECEIPT_INVALID' });
  }
  if (!isRecord(document.gis) || !isHttpUrl(document.gis.url)) {
    throw Object.assign(new Error('receipt lacks a usable gis.url'), { code: 'RECEIPT_INVALID' });
  }
  return {
    file: receiptFile,
    bytes,
    sha256: sha256(bytes),
    document,
  };
}

async function ensureEmptyDirectory(directory) {
  let entries = null;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (entries !== null && entries.length > 0) {
    throw Object.assign(new Error('output directory must be empty for a coherent handoff'), {
      code: 'OUTPUT_NOT_EMPTY',
    });
  }
  await mkdir(directory, { recursive: true });
}

// --------------------------------------------------------------- gateway

async function collectGateway(receiptDocument) {
  const delivery = isRecord(receiptDocument.delivery) ? receiptDocument.delivery : {};
  const expected = isRecord(receiptDocument.expected) ? receiptDocument.expected : {};
  const role = typeof delivery.role === 'string' ? delivery.role : null;
  const url = typeof delivery.url === 'string' ? delivery.url : null;
  const instanceId = typeof delivery.instanceId === 'string' ? delivery.instanceId : null;
  const checks = [];
  const observations = {};
  const collectedAt = nowIso();

  addCheck(checks, 'receipt.running', receiptDocument.status === 'running',
    `The receipt status is ${receiptDocument.status ?? 'missing'}; a handoff is only valid for a running session.`,
    { status: receiptDocument.status ?? null, updatedAt: receiptDocument.updatedAt ?? null });
  addCheck(checks, 'gateway.endpoint',
    Boolean(url && role && instanceId),
    url && role && instanceId
      ? 'The receipt exposes the live delivery role, URL and instance id.'
      : 'The receipt does not expose a usable delivery role, URL and instance id.',
    { role, instanceId, hasUrl: Boolean(url) });

  if (!url) {
    return {
      ok: false,
      status: 'failed',
      role,
      url,
      instanceId,
      collectedAt,
      checks,
      observations,
      expected,
    };
  }

  const [health, diagnostics, releaseObservation, request] = await Promise.all([
    readHttp(endpoint(url, '/healthz'), { parseJson: true }),
    readHttp(endpoint(url, '/diagnostics'), { parseJson: true }),
    observeRelease({
      metadataUrl: endpoint(url, '/_release.json'),
      payloadUrl: endpoint(url, '/payload'),
      timeoutMs: HTTP_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    }),
    readHttp(endpoint(url, '/check'), { parseJson: true }),
  ]);
  const release = releaseObservation.metadata;
  const payload = releaseObservation.payload;
  observations.health = httpSummary(health);
  observations.diagnostics = httpSummary(diagnostics);
  observations.release = releaseObservationSummary(release, true);
  observations.payload = releaseObservationSummary(payload, false);
  observations.request = httpSummary(request);

  const healthBody = isRecord(health.body) ? health.body : null;
  const diagnosticsBody = isRecord(diagnostics.body) ? diagnostics.body : null;
  const releaseRuntime = isRecord(releaseObservation.runtime) ? releaseObservation.runtime : null;
  const requestBody = isRecord(request.body) ? request.body : null;
  const configuration = isRecord(diagnosticsBody?.configuration) ? diagnosticsBody.configuration : null;

  addCheck(checks, 'gateway.health',
    health.status === 200 && healthBody?.status === 'ok' &&
      healthBody?.service === role && healthBody?.instanceId === instanceId,
    health.status === 200
      ? 'The delivery target reports ok for the receipt role and instance id.'
      : `The delivery target /healthz did not return 200 (observed ${health.status ?? 'no response'}).`,
    { observed: healthBody, expected: { role, instanceId } });

  const healthInstance = healthBody?.instanceId ?? null;
  const diagnosticsInstance = diagnosticsBody?.instanceId ?? null;
  const identityPass = Boolean(instanceId) && healthInstance === instanceId &&
    diagnosticsInstance === instanceId && healthInstance === diagnosticsInstance;
  addCheck(checks, 'gateway.instance-consistency', identityPass,
    identityPass
      ? 'The receipt, /healthz and /diagnostics agree on one instance id.'
      : 'The receipt and live endpoints do not agree on the instance id.',
    { receiptInstanceId: instanceId, healthInstanceId: healthInstance, diagnosticsInstanceId: diagnosticsInstance });

  addCheck(checks, 'gateway.diagnostics',
    diagnostics.status === 200 && diagnosticsBody?.role === role &&
      diagnosticsBody?.instanceId === instanceId,
    diagnostics.status === 200 && diagnosticsBody?.role === role &&
      diagnosticsBody?.instanceId === instanceId
      ? 'The delivery target /diagnostics reports the receipt role and instance.'
      : `The delivery target /diagnostics does not report the receipt role and instance (HTTP ${diagnostics.status ?? 'none'}).`,
    { status: diagnostics.status, body: diagnosticsBody });

  addCheck(checks, 'gateway.release-metadata',
    releaseRuntime !== null && release?.error === null && release?.complete === true &&
      releaseRuntime.release === expected.release &&
      releaseRuntime.sourceRevision === expected.sourceRevision,
    releaseRuntime !== null && release?.error === null && release?.complete === true &&
      releaseRuntime.release === expected.release &&
      releaseRuntime.sourceRevision === expected.sourceRevision
      ? 'The live release metadata matches the receipt expected release and source revision.'
      : `The live release metadata does not match the receipt expected release and source revision (HTTP ${release?.status ?? 'none'}).`,
    {
      status: release?.status ?? null,
      observed: releaseRuntime,
      interpretationError: releaseObservation.interpretationError ?? null,
      transportError: release?.error ?? null,
      expected: { release: expected.release ?? null, sourceRevision: expected.sourceRevision ?? null },
    });

  addCheck(checks, 'gateway.diagnostics-release',
    diagnostics.status === 200 && diagnosticsBody?.release === expected.release &&
      diagnosticsBody?.sourceRevision === expected.sourceRevision,
    diagnostics.status === 200 && diagnosticsBody?.release === expected.release &&
      diagnosticsBody?.sourceRevision === expected.sourceRevision
      ? 'The live diagnostics release fields match the receipt expected release and source revision.'
      : `The live diagnostics release fields do not match the receipt expected release and source revision (HTTP ${diagnostics.status ?? 'none'}).`,
    {
      observed: {
        release: diagnosticsBody?.release ?? null,
        sourceRevision: diagnosticsBody?.sourceRevision ?? null,
      },
      expected: { release: expected.release ?? null, sourceRevision: expected.sourceRevision ?? null },
    });

  const payloadByteLength = observations.payload?.byteLength ?? 0;
  const payloadMatches = payload !== null && payload.status === 200 &&
    payloadByteLength > 0 && payload.error === null && payload.complete === true &&
    payload.sha256 === expected.payloadSha256;
  addCheck(checks, 'gateway.payload', payloadMatches,
    payloadMatches
      ? 'The bytes served by /payload match the receipt expected payload digest.'
      : `The bytes served by /payload do not match the receipt expected digest (HTTP ${payload?.status ?? 'none'}).`,
    {
      status: payload?.status ?? null,
      contentType: payload?.contentType ?? null,
      byteLength: payloadByteLength,
      complete: payload?.complete ?? false,
      observedSha256: payload?.sha256 ?? null,
      expectedSha256: expected.payloadSha256 ?? null,
    });

  const upstreamConfigPass = diagnostics.status === 200 && configuration !== null &&
    typeof configuration.model === 'string' && configuration.model.length > 0 &&
    isHttpUrl(configuration.effectiveUpstreamUrl);
  addCheck(checks, 'gateway.upstream-config', upstreamConfigPass,
    upstreamConfigPass
      ? 'The running process exposes a configuration model and a valid effective upstream URL.'
      : 'The running process does not expose a usable effective upstream configuration.',
    { status: diagnostics.status, configuration });

  const upstreamPass = request.status === 200 && requestBody?.status === 'ok' &&
    Number.isInteger(requestBody?.upstreamStatus) &&
    requestBody.upstreamStatus >= 200 && requestBody.upstreamStatus <= 299;
  addCheck(checks, 'gateway.upstream-request', upstreamPass,
    upstreamPass
      ? 'The target completed a real request to its configured upstream.'
      : `The target upstream request is not healthy (HTTP ${request.status ?? 'none'}, upstream ${requestBody?.upstreamStatus ?? 'unknown'}).`,
    { status: request.status, body: requestBody });

  const probesComplete = [health, diagnostics, request]
    .every(observation => observation.status !== null) &&
    release?.complete === true && release?.error === null &&
    payload?.complete === true && payload?.error === null;
  addCheck(checks, 'gateway.probe-completeness', probesComplete,
    probesComplete
      ? 'Every readiness probe returned an HTTP response rather than a network error.'
      : 'At least one readiness probe ended in a network error instead of an HTTP response.',
    {
      errors: [health, diagnostics, request]
        .map(observation => observation.error)
        .concat([release?.error, payload?.error])
        .filter(Boolean),
      releaseComplete: release?.complete === true,
      payloadComplete: payload?.complete === true,
    });

  return {
    ok: allChecksPass(checks),
    status: allChecksPass(checks) ? 'ready' : 'not-ready',
    role,
    url,
    instanceId,
    collectedAt,
    checks,
    observations,
    expected,
    configurationModel: configuration?.model ?? null,
    effectiveUpstreamUrl: configuration?.effectiveUpstreamUrl ?? null,
    upstreamStatus: Number.isInteger(requestBody?.upstreamStatus) ? requestBody.upstreamStatus : null,
  };
}

async function recheckGateway(gateway) {
  if (!gateway || !gateway.url) return;
  const observation = await readHttp(endpoint(gateway.url, '/healthz'), { parseJson: true });
  gateway.observations.healthAtEnd = httpSummary(observation);
  const body = isRecord(observation.body) ? observation.body : null;
  const pass = observation.status === 200 && body?.status === 'ok' &&
    body?.service === gateway.role && body?.instanceId === gateway.instanceId;
  addCheck(gateway.checks, 'gateway.health-at-end', pass,
    pass
      ? 'The delivery target still reports the same healthy identity after the handoff was assembled.'
      : 'The delivery target is not healthy at the end of the handoff observation.',
    { status: observation.status, body });
  gateway.observedUntil = observation.finishedAt;
  gateway.ok = allChecksPass(gateway.checks);
  gateway.status = gateway.ok ? 'ready' : 'not-ready';
}

// ------------------------------------------------------------------- GIS

function validBounds(bounds) {
  return isRecord(bounds) &&
    [bounds.west, bounds.east, bounds.south, bounds.north].every(Number.isFinite) &&
    bounds.west < bounds.east && bounds.south < bounds.north;
}

function safeLayerFile(index, name) {
  const normalized = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `maps/${String(index + 1).padStart(2, '0')}-${normalized || 'layer'}.png`;
}

async function collectGis(receiptDocument) {
  const receiptGis = isRecord(receiptDocument.gis) ? receiptDocument.gis : {};
  const role = typeof receiptGis.role === 'string' ? receiptGis.role : 'gis';
  const url = typeof receiptGis.url === 'string' ? receiptGis.url : null;
  const instanceId = typeof receiptGis.instanceId === 'string' ? receiptGis.instanceId : null;
  const configSha256 = typeof receiptGis.configSha256 === 'string' ? receiptGis.configSha256 : null;
  const checks = [];
  const maps = [];
  const collectedAt = nowIso();

  addCheck(checks, 'gis.endpoint',
    Boolean(url && instanceId && configSha256),
    url && instanceId && configSha256
      ? 'The receipt exposes the live GIS URL, instance id and configuration digest.'
      : 'The receipt does not expose a usable GIS URL, instance id and configuration digest.',
    { role, instanceId, hasUrl: Boolean(url), configSha256 });

  if (!url) {
    return {
      ok: false,
      status: 'failed',
      role,
      url,
      instanceId,
      configSha256,
      collectedAt,
      checks,
      maps,
      capabilities: null,
    };
  }

  const health = await readHttp(endpoint(url, '/healthz'), { parseJson: true });
  const capabilities = await getCapabilities(url);
  const healthBody = isRecord(health.body) ? health.body : null;
  const parsed = capabilities.capabilities;

  addCheck(checks, 'gis.health',
    health.status === 200 && healthBody?.status === 'ok' &&
      healthBody?.service === role && healthBody?.instanceId === instanceId,
    health.status === 200
      ? 'The GIS target reports ok for the receipt role and instance id.'
      : `The GIS /healthz did not return 200 (observed ${health.status ?? 'no response'}).`,
    { status: health.status, body: healthBody, expected: { role, instanceId } });

  addCheck(checks, 'gis.config-identity',
    health.status === 200 && typeof healthBody?.configSha256 === 'string' &&
      healthBody.configSha256 === configSha256,
    health.status === 200 && typeof healthBody?.configSha256 === 'string' &&
      healthBody.configSha256 === configSha256
      ? 'The running GIS reports the same configuration digest as the receipt.'
      : 'The running GIS configuration digest does not match the receipt (or is unavailable).',
    { receiptConfigSha256: configSha256, observedConfigSha256: healthBody?.configSha256 ?? null });

  addCheck(checks, 'gis.capabilities-transport',
    capabilities.status === 200 && capabilities.ok === true && isRecord(parsed),
    capabilities.status === 200
      ? 'GetCapabilities returned a parseable WMS capabilities document.'
      : `GetCapabilities did not return 200 (observed ${capabilities.status ?? 'no response'}).`,
    {
      status: capabilities.status,
      contentType: capabilities.contentType,
      byteLength: capabilities.byteLength,
      error: capabilities.error ?? null,
    });

  addCheck(checks, 'gis.capabilities-version',
    parsed?.version === WMS_VERSION &&
      (typeof healthBody?.capabilitiesVersion !== 'string' ||
        healthBody.capabilitiesVersion === parsed?.version),
    `The live capabilities version is ${parsed?.version ?? 'missing'}; this consumer speaks ${WMS_VERSION}.`,
    { observed: parsed?.version ?? null, healthVersion: healthBody?.capabilitiesVersion ?? null });

  addCheck(checks, 'gis.capabilities-title',
    typeof parsed?.serviceTitle === 'string' && parsed.serviceTitle.length > 0,
    typeof parsed?.serviceTitle === 'string' && parsed.serviceTitle.length > 0
      ? 'The live capabilities document names the service instead of relying on a historical title.'
      : 'The live capabilities document does not name the service.',
    { serviceTitle: parsed?.serviceTitle ?? null });

  const layers = Array.isArray(parsed?.layers) ? parsed.layers : [];
  const layerNames = layers.map(layer => layer?.name);
  const advertisedPass = layers.length > 0 &&
    layerNames.every(name => typeof name === 'string' && name.trim().length > 0) &&
    new Set(layerNames).size === layerNames.length;
  addCheck(checks, 'gis.layers-advertised', advertisedPass,
    advertisedPass
      ? 'Every layer in the live capabilities document is named and unique.'
      : 'The live capabilities document does not advertise a usable layer list.',
    { layerNames });

  addCheck(checks, 'gis.getmap-format',
    Array.isArray(parsed?.operations?.getMap?.formats) &&
      parsed.operations.getMap.formats.includes('image/png'),
    Array.isArray(parsed?.operations?.getMap?.formats) &&
      parsed.operations.getMap.formats.includes('image/png')
      ? 'The live capabilities document advertises image/png for GetMap.'
      : 'The live capabilities document does not advertise image/png for GetMap.',
    { formats: parsed?.operations?.getMap?.formats ?? [] });

  addCheck(checks, 'gis.layers-crs',
    layers.length > 0 && layers.every(layer =>
      Array.isArray(layer?.crs) && layer.crs.includes(WMS_CRS)),
    layers.length > 0 && layers.every(layer =>
      Array.isArray(layer?.crs) && layer.crs.includes(WMS_CRS))
      ? `Every advertised layer lists ${WMS_CRS}; this consumer does not infer another CRS.`
      : `At least one advertised layer does not list ${WMS_CRS}.`,
    { requiredCrs: WMS_CRS, layers: layers.map(layer => ({ name: layer?.name ?? null, crs: layer?.crs ?? [] })) });

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    const name = typeof layer?.name === 'string' ? layer.name : `layer-${index + 1}`;
    const bounds = layer?.geographicBounds ?? null;
    const boundsPass = validBounds(bounds);
    addCheck(checks, `gis.layer.${name}.bounds`, boundsPass,
      boundsPass
        ? 'The layer bounds come from the live capabilities document and are ordered.'
        : 'The live capabilities document does not provide usable bounds for this layer.',
      { bounds });

    const record = {
      layer: name,
      title: layer?.title ?? null,
      crs: layer?.crs ?? [],
      styles: layer?.styles ?? [],
      bounds,
      request: null,
      ok: false,
      status: null,
      contentType: null,
      byteLength: 0,
      sha256: null,
      elapsedMs: null,
      image: null,
      file: null,
      problem: null,
      exception: null,
    };

    if (!boundsPass) {
      record.problem = 'advertised bounds are missing or not ordered';
      maps.push(record);
      continue;
    }

    const bbox = [bounds.south, bounds.west, bounds.north, bounds.east];
    const map = await getMap(url, {
      layers: name,
      bbox,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
    });
    record.request = {
      service: 'WMS',
      request: 'GetMap',
      version: WMS_VERSION,
      layers: name,
      crs: WMS_CRS,
      bbox,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      format: 'image/png',
    };
    record.status = map.status;
    record.contentType = map.contentType;
    record.byteLength = map.byteLength ?? 0;
    record.sha256 = map.sha256 ?? null;
    record.elapsedMs = map.elapsedMs ?? null;
    record.image = map.image
      ? {
        width: map.image.width,
        height: map.image.height,
        dimensionMatches: map.image.dimensionMatches,
        samples: map.image.samples,
      }
      : null;
    record.problem = map.problem ?? null;
    record.exception = map.exception
      ? { code: map.exception.code ?? null, message: map.exception.message ?? null }
      : null;

    const mapPass = map.ok === true && map.byteLength > 0 &&
      typeof map.contentType === 'string' && map.contentType.toLowerCase().includes('image/png');
    record.ok = mapPass;
    addCheck(checks, `gis.layer.${name}.map`, mapPass,
      mapPass
        ? 'GetMap returned a decodable PNG of the requested size for this advertised layer.'
        : `GetMap did not return a usable PNG for this layer (HTTP ${map.status ?? 'none'}).`,
      {
        request: record.request,
        status: map.status,
        contentType: map.contentType ?? null,
        byteLength: map.byteLength ?? 0,
        sha256: map.sha256 ?? null,
        problem: record.problem,
        exception: record.exception,
      });

    if (mapPass) {
      // Keep the bytes on the record; the package writer places them under the
      // caller's output directory after the whole observation has completed.
      record.file = safeLayerFile(index, name);
      record.bytes = map.bytes;
    }
    maps.push(record);
  }

  return {
    ok: allChecksPass(checks),
    status: allChecksPass(checks) ? 'ready' : 'not-ready',
    role,
    url,
    instanceId,
    configSha256,
    collectedAt,
    serviceTitle: parsed?.serviceTitle ?? null,
    capabilitiesVersion: parsed?.version ?? null,
    layers: layers.map(layer => ({
      name: layer?.name ?? null,
      title: layer?.title ?? null,
      crs: layer?.crs ?? [],
      bounds: layer?.geographicBounds ?? null,
    })),
    maps,
    capabilities: {
      status: capabilities.status,
      contentType: capabilities.contentType,
      byteLength: capabilities.byteLength,
      sha256: capabilities.sha256,
      requestUrl: capabilities.requestUrl,
      xml: typeof capabilities.xml === 'string' ? capabilities.xml : null,
      parsed: parsed ?? null,
      error: capabilities.error ?? null,
    },
    health: httpSummary(health),
    checks,
  };
}

async function recheckGis(gis) {
  if (!gis || !gis.url) return;
  const observation = await readHttp(endpoint(gis.url, '/healthz'), { parseJson: true });
  gis.healthAtEnd = httpSummary(observation);
  const body = isRecord(observation.body) ? observation.body : null;
  const pass = observation.status === 200 && body?.status === 'ok' &&
    body?.service === gis.role && body?.instanceId === gis.instanceId;
  addCheck(gis.checks, 'gis.health-at-end', pass,
    pass
      ? 'The GIS target still reports the same healthy identity after the handoff was assembled.'
      : 'The GIS target is not healthy at the end of the handoff observation.',
    { status: observation.status, body });
  const startRequests = Number.isInteger(gis.health?.body?.counters?.requests)
    ? gis.health.body.counters.requests
    : null;
  const endRequests = Number.isInteger(body?.counters?.requests)
    ? body.counters.requests
    : null;
  gis.observedUntil = observation.finishedAt;
  gis.activity = {
    requestsAtStart: startRequests,
    requestsAtEnd: endRequests,
    observedDuringHandoff: startRequests !== null && endRequests !== null && endRequests > startRequests,
  };
  gis.ok = allChecksPass(gis.checks);
  gis.status = gis.ok ? 'ready' : 'not-ready';
}

// ------------------------------------------------------------- knowledge

async function readKnowledgeCandidates(directory) {
  const knowledgeDir = join(directory, 'knowledge');
  let entries;
  try {
    entries = await readdir(knowledgeDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { directory: null, files: [], errors: [] };
    throw error;
  }
  const names = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => entry.name)
    .sort((left, right) => {
      if (left === KNOWLEDGE_FILE_NAME) return -1;
      if (right === KNOWLEDGE_FILE_NAME) return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const files = [];
  const errors = [];
  for (const name of names) {
    const file = join(knowledgeDir, name);
    const relativeFile = `knowledge/${name}`;
    try {
      const bytes = await readFile(file);
      const document = JSON.parse(bytes.toString('utf8'));
      if (!isRecord(document) || !Array.isArray(document.records)) {
        errors.push({ file: relativeFile, reason: 'document has no records array' });
        continue;
      }
      files.push({ file, relativeFile, bytes, sha256: sha256(bytes), document });
    } catch (error) {
      errors.push({ file: relativeFile, reason: error.message });
    }
  }
  return { directory: knowledgeDir, files, errors };
}

function knowledgePolicy() {
  return {
    readOnly: true,
    automaticRepair: 'forbidden',
    mutationsPerformed: { environmentWrites: 0, configWrites: 0, restarts: 0, deployments: 0 },
    usableFor: 'A human operator may use an authorized procedure only after action-time re-evaluation.',
    humanPreconditions: [
      'The record status is verified.',
      'The record conditions match the current artifact digest and the live configuration model.',
      'The record is not expired at action time.',
      'Every evidence file still matches its recorded SHA-256.',
      'No applicable refuted record targets the same procedure.',
      'No two applicable procedures are in conflict.',
      'The live incident matches the incident the procedure was verified against.',
    ],
    refusalReasons: {
      EXPIRED: 'The record is past its expiry; do not execute it from this handoff.',
      CONDITION_MISMATCH: 'Artifact or configuration-model conditions differ; do not reuse the record.',
      EVIDENCE_UNVERIFIED: 'A referenced evidence file is missing or its bytes changed; do not trust the record.',
      INVALID_RECORD: 'The record is malformed; fail closed.',
      REFUTED_PROCEDURE: 'An applicable record refutes this procedure; do not execute it.',
      CONFLICT: 'More than one procedure is active; a human must resolve the conflict first.',
      NO_APPLICABLE_KNOWLEDGE: 'No applicable record authorizes the procedure.',
    },
    executeDoesNotAuthorizeAutomaticRepair:
      'An execute decision only means the persisted procedure is conditionally eligible for a human; this package never writes configuration, restarts, or deploys.',
    doNotApplyWhileHealthy:
      'When the live gateway upstream request is healthy, an execute decision is a reference only; do not apply a repair preemptively.',
  };
}

async function collectKnowledge(receiptDocument, gateway) {
  const now = Date.now();
  const directory = typeof receiptDocument.directory === 'string'
    ? resolve(receiptDocument.directory)
    : null;
  const policy = knowledgePolicy();
  const incident = knowledgeIncident(gateway);
  const applicationNow = incident.observed === 'gateway-upstream-ready'
    ? 'not-needed-healthy'
    : incident.observed === 'gateway-upstream-not-ready'
      ? 'incident-observed-review-before-use'
      : 'unknown';

  if (!directory) {
    return {
      ok: false,
      status: 'context-unavailable',
      file: null,
      recordCount: 0,
      context: null,
      contextComplete: false,
      records: [],
      decisions: [],
      currentIncident: { ...incident, applicationNow },
      evaluatedAt: new Date(now).toISOString(),
      earliestExpiry: null,
      policy,
      summary: 'The receipt has no directory, so persisted knowledge cannot be located.',
      errors: [{ code: 'RECEIPT_DIRECTORY_MISSING', message: 'receipt.directory is missing' }],
    };
  }

  const discovered = await readKnowledgeCandidates(directory);
  if (discovered.files.length === 0) {
    return {
      ok: true,
      status: 'absent',
      file: null,
      recordCount: 0,
      context: null,
      contextComplete: false,
      records: [],
      decisions: [],
      currentIncident: { ...incident, applicationNow },
      evaluatedAt: new Date(now).toISOString(),
      earliestExpiry: null,
      policy,
      summary: discovered.errors.length > 0
        ? 'No readable persisted knowledge file was found; do not auto-repair from this handoff.'
        : 'No persisted knowledge file was discovered; do not auto-repair from this handoff.',
      errors: [],
      warnings: discovered.errors,
    };
  }

  const primary = discovered.files[0];
  const records = primary.document.records;
  if (records.length === 0) {
    return {
      ok: true,
      status: 'empty',
      file: primary.relativeFile,
      fileSha256: primary.sha256,
      recordCount: 0,
      context: null,
      contextComplete: false,
      records: [],
      decisions: [],
      currentIncident: { ...incident, applicationNow },
      evaluatedAt: new Date(now).toISOString(),
      earliestExpiry: null,
      policy,
      summary: 'The knowledge file has no records; do not auto-repair from this handoff.',
      errors: [],
      warnings: discovered.errors,
    };
  }

  const livePayloadSha256 = gateway?.observations?.payload?.status === 200
    ? gateway.observations.payload.sha256
    : null;
  const expectedPayloadSha256 = isRecord(receiptDocument.expected) &&
    typeof receiptDocument.expected.payloadSha256 === 'string'
    ? receiptDocument.expected.payloadSha256
    : null;
  const artifactSha256 = livePayloadSha256 ?? expectedPayloadSha256;
  const artifactSource = livePayloadSha256 !== null ? 'live-payload' : expectedPayloadSha256 !== null
    ? 'receipt-expected'
    : null;
  const configModel = typeof gateway?.configurationModel === 'string'
    ? gateway.configurationModel
    : null;
  const context = { artifactSha256, configModel };
  const contextComplete = typeof artifactSha256 === 'string' && typeof configModel === 'string';

  let classification;
  const decisions = [];
  const errors = [];
  const decisionErrors = [];
  try {
    classification = await evaluateKnowledgeFile({
      file: primary.file,
      evidenceRoot: directory,
      context,
      now,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'evaluation-failed',
      file: primary.relativeFile,
      fileSha256: primary.sha256,
      recordCount: records.length,
      context: { ...context, artifactSource, contextComplete },
      contextComplete,
      records: [],
      decisions: [],
      currentIncident: { ...incident, applicationNow },
      evaluatedAt: new Date(now).toISOString(),
      earliestExpiry: null,
      policy,
      summary: 'The knowledge file could not be evaluated; do not auto-repair from this handoff.',
      errors: [{ code: error.code ?? 'KNOWLEDGE_EVALUATION_FAILED', message: error.message }],
      warnings: discovered.errors,
    };
  }

  const invalidReasons = new Map(
    (Array.isArray(classification.invalid) ? classification.invalid : [])
      .map(item => [item.id, item.reason]),
  );
  const applicable = new Set(classification.applicable ?? []);
  const expired = new Set(classification.expired ?? []);
  const conditionMismatch = new Set(classification.conditionMismatch ?? []);
  const evidenceInvalid = new Set(classification.evidenceInvalid ?? []);

  const recordViews = records.map(record => {
    let verdict = 'unknown';
    if (invalidReasons.has(record.id)) verdict = 'invalid';
    else if (conditionMismatch.has(record.id)) verdict = 'condition-mismatch';
    else if (expired.has(record.id)) verdict = 'expired';
    else if (evidenceInvalid.has(record.id)) verdict = 'evidence-invalid';
    else if (applicable.has(record.id)) verdict = 'applicable';
    return {
      id: record.id ?? null,
      status: record.status ?? null,
      procedure: record.procedure ?? null,
      recordedAt: Number.isFinite(record.recordedAt) ? record.recordedAt : null,
      expiresAt: Number.isFinite(record.expiresAt) ? record.expiresAt : null,
      expiredNow: Number.isFinite(record.expiresAt) && now >= record.expiresAt,
      evidenceCount: Array.isArray(record.evidence) ? record.evidence.length : 0,
      verdict,
      invalidReason: invalidReasons.get(record.id) ?? null,
    };
  });

  const procedures = [...new Set(
    records
      .map(record => record.procedure)
      .filter(procedure => typeof procedure === 'string' && procedure.length > 0),
  )];
  for (const procedure of procedures) {
    try {
      const decision = await evaluateKnowledgeFile({
        file: primary.file,
        evidenceRoot: directory,
        context,
        now,
        proposal: procedure,
      });
      decisions.push({
        procedure,
        decision: decision.decision,
        primaryReason: decision.primaryReason,
        authorizedBy: decision.authorizedBy,
        applicable: decision.applicable,
        expired: decision.expired,
        conditionMismatch: decision.conditionMismatch,
        evidenceInvalid: decision.evidenceInvalid,
        activeProcedures: decision.activeProcedures,
      });
    } catch (error) {
      const decisionError = {
        code: error.code ?? 'KNOWLEDGE_DECISION_FAILED',
        procedure,
        message: error.message,
      };
      errors.push(decisionError);
      decisionErrors.push(decisionError);
    }
  }

  const authorized = decisions
    .filter(decision => decision.decision === 'execute')
    .map(decision => decision.procedure);
  const refused = decisions
    .filter(decision => decision.decision === 'refuse')
    .map(decision => ({ procedure: decision.procedure, reason: decision.primaryReason }));
  const summary = `${records.length} persisted record(s) from ${primary.relativeFile}; `
    + `${authorized.length} procedure(s) conditionally authorized for human use `
    + `(${authorized.join(', ') || 'none'}); `
    + `${refused.length} refused (${refused.map(item => `${item.procedure}: ${item.reason}`).join('; ') || 'none'}). `
    + 'No repair was executed.';

  const evaluationComplete = contextComplete && decisionErrors.length === 0;
  const expiryValues = records
    .map(record => record.expiresAt)
    .filter(value => Number.isFinite(value));
  const earliestExpiryMs = expiryValues.length > 0 ? Math.min(...expiryValues) : null;
  return {
    ok: evaluationComplete,
    status: evaluationComplete ? 'assessed' : 'context-unavailable',
    file: primary.relativeFile,
    fileSha256: primary.sha256,
    recordCount: records.length,
    context: { ...context, artifactSource, contextComplete },
    contextComplete,
    records: recordViews,
    decisions,
    currentIncident: { ...incident, applicationNow },
    evaluatedAt: new Date(now).toISOString(),
    earliestExpiry: earliestExpiryMs === null
      ? null
      : { epochMs: earliestExpiryMs, iso: new Date(earliestExpiryMs).toISOString() },
    policy,
    summary,
    errors: [
      ...(contextComplete ? [] : [{
        code: 'KNOWLEDGE_CONTEXT_INCOMPLETE',
        message: 'artifact digest or live configuration model is unavailable',
      }]),
      ...errors,
    ],
    warnings: discovered.errors,
    otherKnowledgeFiles: discovered.files.slice(1).map(item => item.relativeFile),
  };
}

function knowledgeIncident(gateway) {
  const request = gateway?.observations?.request;
  const status = typeof request?.status === 'number' ? request.status : null;
  const upstreamStatus = Number.isInteger(request?.body?.upstreamStatus)
    ? request.body.upstreamStatus
    : null;
  let observed = 'gateway-not-observed';
  if (status === 200) {
    observed = upstreamStatus !== null && upstreamStatus >= 200 && upstreamStatus <= 299
      ? 'gateway-upstream-ready'
      : 'gateway-upstream-not-ready';
  } else if (status !== null) {
    observed = 'gateway-upstream-not-ready';
  }
  return {
    gatewayRequestStatus: status,
    upstreamStatus,
    observed,
  };
}

// ---------------------------------------------------------------- package

function renderHandoffMarkdown({ generatedAt, receipt, gateway, gis, knowledge, overallOk, files }) {
  const lines = [];
  lines.push('# Operations handoff (read-only observation)');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Overall: ${overallOk ? 'READY' : 'NOT READY'}`);
  lines.push('');
  lines.push('This package was produced by reading the public session receipt and the live loopback services.');
  lines.push('It did not write target configuration, restart, or deploy anything.');
  lines.push('');
  lines.push('## Gateway');
  lines.push('');
  lines.push(`- Role: ${gateway.role ?? 'missing'}`);
  lines.push(`- Instance: ${gateway.instanceId ?? 'missing'}`);
  lines.push(`- Readiness: ${gateway.ok ? 'ready' : 'not ready'} (${gateway.checks.filter(check => check.status === 'pass').length}/${gateway.checks.length} checks passed)`);
  lines.push(`- Expected release: ${receipt.document.expected?.release ?? 'missing'} / ${receipt.document.expected?.sourceRevision ?? 'missing'}`);
  lines.push(`- Observed release: ${gateway.observations.release?.body?.release ?? 'missing'} / ${gateway.observations.release?.body?.sourceRevision ?? 'missing'}`);
  lines.push(`- Expected payload SHA-256: ${receipt.document.expected?.payloadSha256 ?? 'missing'}`);
  lines.push(`- Observed payload SHA-256: ${gateway.observations.payload?.sha256 ?? 'missing'}`);
  lines.push(`- Upstream request status: ${gateway.observations.request?.status ?? 'missing'} (upstream ${gateway.upstreamStatus ?? 'unknown'})`);
  const failedGatewayChecks = gateway.checks.filter(check => check.status !== 'pass');
  if (failedGatewayChecks.length > 0) {
    lines.push(`- Failed checks: ${failedGatewayChecks.map(check => check.id).join(', ')}`);
  }
  lines.push('');
  lines.push('## GIS');
  lines.push('');
  lines.push(`- Role: ${gis.role ?? 'missing'}`);
  lines.push(`- Instance: ${gis.instanceId ?? 'missing'}`);
  lines.push(`- Configuration SHA-256: ${gis.configSha256 ?? 'missing'}`);
  lines.push(`- Service title: ${gis.serviceTitle ?? 'missing'}`);
  lines.push(`- Capabilities version: ${gis.capabilitiesVersion ?? 'missing'}`);
  lines.push(`- Layers advertised live: ${gis.layers.length}`);
  for (const map of gis.maps) {
    const file = map.file ? ` -> ${map.file}` : '';
    const bounds = map.bounds
      ? `bounds w${map.bounds.west} s${map.bounds.south} e${map.bounds.east} n${map.bounds.north}`
      : 'bounds missing';
    lines.push(`  - ${map.layer}: ${map.ok ? 'map ok' : 'map failed'}, ${bounds}${file} (sha256 ${map.sha256 ?? 'missing'})`);
  }
  const failedGisChecks = gis.checks.filter(check => check.status !== 'pass');
  if (failedGisChecks.length > 0) {
    lines.push(`- Failed checks: ${failedGisChecks.map(check => check.id).join(', ')}`);
  }
  lines.push('');
  lines.push('## Troubleshooting knowledge');
  lines.push('');
  lines.push(`- File: ${knowledge.file ?? 'not found'}`);
  lines.push(`- Records: ${knowledge.recordCount}`);
  lines.push(`- Assessment: ${knowledge.status}`);
  if (knowledge.context) {
    lines.push(`- Context artifact: ${knowledge.context.artifactSha256 ?? 'missing'} (${knowledge.context.artifactSource ?? 'unknown'})`);
    lines.push(`- Context config model: ${knowledge.context.configModel ?? 'missing'}`);
  }
  for (const decision of knowledge.decisions) {
    lines.push(`  - ${decision.procedure}: ${decision.decision}${decision.primaryReason ? ` (${decision.primaryReason})` : ''}`);
  }
  lines.push(`- Incident: ${knowledge.currentIncident?.observed ?? 'unknown'} (application now: ${knowledge.currentIncident?.applicationNow ?? 'unknown'})`);
  if (knowledge.earliestExpiry?.iso) {
    lines.push(`- Earliest record expiry: ${knowledge.earliestExpiry.iso}`);
  }
  if ((knowledge.warnings ?? []).length > 0) {
    lines.push(`- Warnings: ${knowledge.warnings.length} unreadable knowledge file(s)`);
  }
  lines.push('');
  lines.push('Use knowledge only when all recorded conditions, evidence hashes and expiry still hold at action time.');
  lines.push('Refused procedures and conflicts must not be auto-repaired; this package performs no repair at all.');
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const file of files) {
    lines.push(`- ${file.path} (${file.byteLength} bytes, sha256 ${file.sha256})`);
  }
  lines.push('');
  lines.push('handoff.json lists every generated file, including this note, with its digest.');
  lines.push('');
  lines.push('Scope: one local loopback host, bounded demo services, not production and not multi-host.');
  lines.push('');
  return `${lines.join('\n')}`;
}

async function writePackageFile(outputDirectory, relativePath, content, files) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  await writeFile(join(outputDirectory, ...relativePath.split('/')), bytes);
  files.push({ path: relativePath, byteLength: bytes.length, sha256: sha256(bytes) });
}

function failureSummary(facility, value) {
  const failures = [];
  if (value?.error) {
    failures.push({
      facility,
      check: 'facility',
      reason: value.error.message ?? String(value.error),
      code: value.error.code ?? null,
    });
  }
  for (const check of value?.checks ?? []) {
    if (check.status !== 'pass') {
      failures.push({
        facility,
        check: check.id,
        reason: check.reason,
        details: check.details ?? null,
      });
    }
  }
  for (const error of value?.errors ?? []) {
    failures.push({
      facility,
      check: error.code ?? 'error',
      reason: error.message ?? String(error),
      details: error.procedure ? { procedure: error.procedure } : null,
    });
  }
  return failures;
}

export async function runAgentExtension(input) {
  if (!isRecord(input)) throw new TypeError('runAgentExtension input must be a plain object');
  const { receiptFile, outputDirectory } = input;
  if (typeof receiptFile !== 'string' || receiptFile.length === 0) {
    throw new TypeError('receiptFile must be a non-empty path');
  }
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new TypeError('outputDirectory must be a non-empty path');
  }

  const receiptPath = resolve(receiptFile);
  const outputPath = resolve(outputDirectory);
  await ensureEmptyDirectory(outputPath);

  let receipt;
  try {
    receipt = await readReceipt(receiptPath);
  } catch (error) {
    const generatedAt = nowIso();
    const failureFile = join(outputPath, 'failure.json');
    const failureMessage = typeof error.message === 'string'
      ? error.message.replaceAll(receiptPath, basename(receiptPath))
      : String(error);
    const failure = {
      schemaVersion: 1,
      kind: 'operations-handoff-failure',
      generatedAt,
      ok: false,
      receipt: { name: basename(receiptPath) },
      error: { code: error.code ?? 'RECEIPT_UNREADABLE', message: failureMessage },
    };
    await writeFile(failureFile, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    return {
      ok: false,
      status: 'not-ready',
      generatedAt,
      outputDirectory: outputPath,
      handoffFile: null,
      failureFile: 'failure.json',
      receipt: null,
      facilities: null,
      failures: [{
        facility: 'receipt',
        check: 'read',
        reason: failureMessage,
        code: error.code ?? 'RECEIPT_UNREADABLE',
      }],
      files: ['failure.json'],
    };
  }

  const startedAt = nowIso();
  let gateway;
  try {
    gateway = await collectGateway(receipt.document);
  } catch (error) {
    gateway = {
      ok: false,
      status: 'error',
      role: receipt.document.delivery?.role ?? null,
      url: receipt.document.delivery?.url ?? null,
      instanceId: receipt.document.delivery?.instanceId ?? null,
      collectedAt: nowIso(),
      checks: [],
      observations: {},
      error: { code: error.code ?? 'GATEWAY_COLLECTION_FAILED', message: error.message },
    };
  }

  let gis;
  try {
    gis = await collectGis(receipt.document);
  } catch (error) {
    gis = {
      ok: false,
      status: 'error',
      role: receipt.document.gis?.role ?? null,
      url: receipt.document.gis?.url ?? null,
      instanceId: receipt.document.gis?.instanceId ?? null,
      configSha256: receipt.document.gis?.configSha256 ?? null,
      collectedAt: nowIso(),
      checks: [],
      maps: [],
      layers: [],
      capabilities: null,
      error: { code: error.code ?? 'GIS_COLLECTION_FAILED', message: error.message },
    };
  }

  let knowledge;
  try {
    knowledge = await collectKnowledge(receipt.document, gateway);
  } catch (error) {
    knowledge = {
      ok: false,
      status: 'error',
      file: null,
      recordCount: 0,
      context: null,
      contextComplete: false,
      records: [],
      decisions: [],
      currentIncident: knowledgeIncident(gateway),
      policy: knowledgePolicy(),
      summary: 'The persisted knowledge assessment failed.',
      error: { code: error.code ?? 'KNOWLEDGE_COLLECTION_FAILED', message: error.message },
      errors: [{ code: error.code ?? 'KNOWLEDGE_COLLECTION_FAILED', message: error.message }],
    };
  }

  if (gateway.ok || gateway.url) {
    try {
      await recheckGateway(gateway);
    } catch (error) {
      addCheck(gateway.checks, 'gateway.health-at-end', false,
        'The final gateway re-check could not be completed.', { message: error.message });
      gateway.ok = false;
      gateway.status = 'not-ready';
    }
  }
  if (gis.ok || gis.url) {
    try {
      await recheckGis(gis);
    } catch (error) {
      addCheck(gis.checks, 'gis.health-at-end', false,
        'The final GIS re-check could not be completed.', { message: error.message });
      gis.ok = false;
      gis.status = 'not-ready';
    }
  }

  const overallOk = gateway.ok === true && gis.ok === true && knowledge.ok === true;
  const failures = [
    ...failureSummary('gateway', gateway),
    ...failureSummary('gis', gis),
    ...failureSummary('knowledge', knowledge),
  ];
  const generatedAt = nowIso();

  const gatewayEvidence = {
    schemaVersion: 1,
    kind: 'gateway-readiness',
    generatedAt,
    collectedAt: gateway.collectedAt,
    observedUntil: gateway.observedUntil ?? null,
    endpoint: {
      role: gateway.role ?? null,
      url: gateway.url ?? null,
      instanceId: gateway.instanceId ?? null,
    },
    expected: isRecord(receipt.document.expected) ? receipt.document.expected : null,
    ok: gateway.ok === true,
    status: gateway.status ?? (gateway.ok ? 'ready' : 'not-ready'),
    checks: gateway.checks ?? [],
    observations: gateway.observations ?? {},
    error: gateway.error ?? null,
    scope: 'single local loopback HTTP target; readiness read at run time, not copied from prior evidence',
    limitations: [
      'The target is a local demo gateway child process, not production or multi-host.',
      'The observation is a point-in-time snapshot; the final health re-check only narrows the gap until handoff.',
      'Release/identity fields are self-reported by the target and are bound to the receipt but not signed.',
    ],
  };

  const gisEvidence = {
    schemaVersion: 1,
    kind: 'gis-readiness',
    generatedAt,
    collectedAt: gis.collectedAt,
    observedUntil: gis.observedUntil ?? null,
    endpoint: {
      role: gis.role ?? null,
      url: gis.url ?? null,
      instanceId: gis.instanceId ?? null,
      configSha256: gis.configSha256 ?? null,
    },
    ok: gis.ok === true,
    status: gis.status ?? (gis.ok ? 'ready' : 'not-ready'),
    service: {
      title: gis.serviceTitle ?? null,
      capabilitiesVersion: gis.capabilitiesVersion ?? null,
    },
    health: gis.health ?? null,
    healthAtEnd: gis.healthAtEnd ?? null,
    activity: gis.activity ?? null,
    capabilities: gis.capabilities
      ? {
        status: gis.capabilities.status,
        contentType: gis.capabilities.contentType,
        byteLength: gis.capabilities.byteLength,
        sha256: gis.capabilities.sha256,
        requestUrl: gis.capabilities.requestUrl,
        xmlFile: gis.capabilities.xml ? 'gis/capabilities.xml' : null,
        version: gis.capabilities.parsed?.version ?? null,
        serviceTitle: gis.capabilities.parsed?.serviceTitle ?? null,
        operations: gis.capabilities.parsed?.operations ?? null,
        layers: gis.capabilities.parsed?.layers ?? [],
        error: gis.capabilities.error ?? null,
      }
      : null,
    layers: gis.layers ?? [],
    maps: (gis.maps ?? []).map(map => ({
      layer: map.layer,
      title: map.title,
      crs: map.crs,
      styles: map.styles,
      bounds: map.bounds,
      request: map.request,
      ok: map.ok,
      status: map.status,
      contentType: map.contentType,
      byteLength: map.byteLength,
      sha256: map.sha256,
      elapsedMs: map.elapsedMs,
      image: map.image,
      file: map.file,
      problem: map.problem,
      exception: map.exception,
    })),
    checks: gis.checks ?? [],
    error: gis.error ?? null,
    scope: 'one local loopback WMS 1.3.0 stand-in; advertised layers and bounds are read from the live document',
    limitations: [
      'The WMS implementation is a bounded local stand-in, not a certified OGC service.',
      'Maps are small diagnostic thumbnails, not cartographic products.',
      'The consumer requests one layer per map and EPSG:4326 in WMS 1.3.0 lat,lon order.',
    ],
  };

  const knowledgeEvidence = {
    schemaVersion: 1,
    kind: 'knowledge-applicability',
    generatedAt,
    ok: knowledge.ok === true,
    status: knowledge.status,
    file: knowledge.file ?? null,
    fileSha256: knowledge.fileSha256 ?? null,
    recordCount: knowledge.recordCount ?? 0,
    context: knowledge.context ?? null,
    contextComplete: knowledge.contextComplete ?? false,
    records: knowledge.records ?? [],
    decisions: knowledge.decisions ?? [],
    currentIncident: knowledge.currentIncident ?? null,
    evaluatedAt: knowledge.evaluatedAt ?? null,
    earliestExpiry: knowledge.earliestExpiry ?? null,
    policy: knowledge.policy ?? knowledgePolicy(),
    summary: knowledge.summary ?? null,
    errors: knowledge.errors ?? [],
    warnings: knowledge.warnings ?? [],
    error: knowledge.error ?? null,
    scope: 'read-only evaluation of persisted records; no record, evidence file, configuration or process was modified',
    limitations: [
      'Record status is an author claim; SHA-256 binds bytes, not meaning.',
      'Evidence and records are trusted inputs; this assessment does not authenticate their author.',
      'An execute decision is an operator reference, not permission for automatic repair.',
      'Expiry is evaluated at the time shown; re-evaluate at action time.',
    ],
  };

  const files = [];
  await mkdir(join(outputPath, 'gis'), { recursive: true });
  await mkdir(join(outputPath, 'maps'), { recursive: true });

  if (gisEvidence.capabilities?.xmlFile && typeof gis.capabilities?.xml === 'string') {
    await writePackageFile(outputPath, 'gis/capabilities.xml', gis.capabilities.xml, files);
  }
  for (const map of gis.maps ?? []) {
    if (map.bytes && map.file) {
      await writePackageFile(outputPath, map.file, map.bytes, files);
    }
  }
  await writePackageFile(outputPath, 'gateway.json', `${JSON.stringify(gatewayEvidence, null, 2)}\n`, files);
  await writePackageFile(outputPath, 'gis.json', `${JSON.stringify(gisEvidence, null, 2)}\n`, files);
  await writePackageFile(outputPath, 'knowledge.json', `${JSON.stringify(knowledgeEvidence, null, 2)}\n`, files);
  await writePackageFile(outputPath, 'handoff.md',
    renderHandoffMarkdown({
      generatedAt,
      receipt,
      gateway,
      gis,
      knowledge,
      overallOk,
      files,
    }),
    files);

  const handoff = {
    schemaVersion: 1,
    kind: 'operations-handoff',
    generatedAt,
    startedAt,
    ok: overallOk,
    status: overallOk ? 'ready' : 'not-ready',
    scope: 'single local loopback host; read-only observations of a running delivery target and GIS; no production claim',
    receipt: {
      name: basename(receiptPath),
      sha256: receipt.sha256,
      status: receipt.document.status ?? null,
      updatedAt: receipt.document.updatedAt ?? null,
      expected: isRecord(receipt.document.expected) ? receipt.document.expected : null,
    },
    facilities: {
      gateway: {
        ok: gateway.ok === true,
        status: gateway.status ?? (gateway.ok ? 'ready' : 'not-ready'),
        role: gateway.role ?? null,
        instanceId: gateway.instanceId ?? null,
        url: gateway.url ?? null,
        checks: {
          total: gateway.checks?.length ?? 0,
          passed: (gateway.checks ?? []).filter(check => check.status === 'pass').length,
          failed: (gateway.checks ?? []).filter(check => check.status !== 'pass').length,
        },
        evidenceFile: 'gateway.json',
      },
      gis: {
        ok: gis.ok === true,
        status: gis.status ?? (gis.ok ? 'ready' : 'not-ready'),
        role: gis.role ?? null,
        instanceId: gis.instanceId ?? null,
        url: gis.url ?? null,
        layerCount: gis.layers?.length ?? 0,
        mapCount: (gis.maps ?? []).filter(map => map.ok).length,
        maps: (gis.maps ?? []).map(map => ({
          layer: map.layer,
          ok: map.ok,
          file: map.file,
          sha256: map.sha256,
          byteLength: map.byteLength,
        })),
        checks: {
          total: gis.checks?.length ?? 0,
          passed: (gis.checks ?? []).filter(check => check.status === 'pass').length,
          failed: (gis.checks ?? []).filter(check => check.status !== 'pass').length,
        },
        evidenceFile: 'gis.json',
        capabilitiesFile: gis.capabilities?.xml ? 'gis/capabilities.xml' : null,
      },
      knowledge: {
        ok: knowledge.ok === true,
        status: knowledge.status,
        file: knowledge.file ?? null,
        recordCount: knowledge.recordCount ?? 0,
        contextComplete: knowledge.contextComplete ?? false,
        applicationNow: knowledge.currentIncident?.applicationNow ?? 'unknown',
        earliestExpiry: knowledge.earliestExpiry ?? null,
        warnings: (knowledge.warnings ?? []).length,
        decisions: (knowledge.decisions ?? []).map(decision => ({
          procedure: decision.procedure,
          decision: decision.decision,
          primaryReason: decision.primaryReason,
        })),
        evidenceFile: 'knowledge.json',
      },
    },
    retained: {
      gateway: gateway.ok === true,
      gis: gis.ok === true,
      knowledge: knowledge.ok === true,
    },
    failures,
    files,
    operatorNote: 'handoff.md',
  };

  await writeFile(join(outputPath, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return {
    ok: overallOk,
    status: overallOk ? 'ready' : 'not-ready',
    generatedAt,
    outputDirectory: outputPath,
    handoffFile: 'handoff.json',
    failureFile: null,
    receipt: {
      sha256: receipt.sha256,
      status: receipt.document.status ?? null,
      updatedAt: receipt.document.updatedAt ?? null,
    },
    facilities: handoff.facilities,
    failures,
    files: [...files.map(file => file.path), 'handoff.json'],
  };
}

// -------------------------------------------------------------------- CLI

const USAGE = 'Usage: node tests/14-workspace-evolution/agent-extension.js --receipt <session-receipt.json> --output <empty-directory>\n';

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--')) {
      throw Object.assign(new Error(`unexpected argument: ${argument}`), { code: 'CLI_ARGUMENT_INVALID' });
    }
    let name;
    let value;
    const equals = argument.indexOf('=');
    if (equals === -1) {
      name = argument.slice(2);
      value = argv[index + 1];
      index += 1;
    } else {
      name = argument.slice(2, equals);
      value = argument.slice(equals + 1);
    }
    if (name !== 'receipt' && name !== 'output') {
      throw Object.assign(new Error(`unknown option: --${name}`), { code: 'CLI_ARGUMENT_INVALID' });
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error(`option --${name} requires a value`), { code: 'CLI_ARGUMENT_INVALID' });
    }
    values[name] = value;
  }
  if (!values.receipt || !values.output) {
    throw Object.assign(new Error(USAGE.trim()), { code: 'CLI_ARGUMENT_MISSING' });
  }
  return values;
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(USAGE);
      return;
    }
    const result = await runAgentExtension({
      receiptFile: args.receipt,
      outputDirectory: args.output,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: error.code ?? null, message: error.message },
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
