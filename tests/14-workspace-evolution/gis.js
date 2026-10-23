/**
 * Evolution 3 fixture: a local, restartable WMS 1.3.0 stand-in plus native
 * consumer evidence.
 *
 * Scope: one local process, one logical service, no TLS/auth, no multi-host or
 * production claim. The protocol surface is bounded and explicitly rejected
 * outside its range (EPSG:4326 only, one layer per GetMap, image/png only).
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertValidGisConfig, defaultGisConfig } from './gis-config.js';
import { getCapabilities, getMap, requestWms } from './wms-client.js';

const WORKER_PATH = fileURLToPath(new URL('./gis-worker.mjs', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;
const ROLE = 'gis';
const PROTOCOL_VERSION = '1.3.0';
const CRS = 'EPSG:4326';
const GOLDEN_BOUNDS = { west: 116.0, south: 39.5, east: 116.8, north: 40.3 };

// Frozen observations for the default configured extent. These are deliberately
// not recomputed from the renderer; they are an independent oracle.
const GOLDEN_FULL_4X3_SEED17 = [
  { name: 'top-left', x: 0, y: 0, rgb: [32, 43, 17] },
  { name: 'top-right', x: 3, y: 0, rgb: [223, 43, 17] },
  { name: 'bottom-left', x: 0, y: 2, rgb: [32, 213, 17] },
  { name: 'bottom-right', x: 3, y: 2, rgb: [223, 213, 17] },
  { name: 'center', x: 2, y: 1, rgb: [159, 128, 17] },
];
const GOLDEN_FULL_2X2_SEED203 = [
  { name: 'top-left', x: 0, y: 0, rgb: [64, 64, 203] },
  { name: 'top-right', x: 1, y: 0, rgb: [191, 64, 203] },
  { name: 'bottom-left', x: 0, y: 1, rgb: [64, 191, 203] },
  { name: 'bottom-right', x: 1, y: 1, rgb: [191, 191, 203] },
  { name: 'center', x: 1, y: 1, rgb: [191, 191, 203] },
];

export { getCapabilities, getMap, requestWms };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    // The process may already be terminating; the wait below is authoritative.
  }
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Fall through to the final wait; close must not hang forever.
  }
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    throw new Error('GIS worker did not exit after SIGTERM/SIGKILL');
  }
}

function validateReadyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('GIS worker announced an invalid URL');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('GIS worker announced a URL outside the expected local http endpoint');
  }
  return { origin: parsed.origin, port: Number(parsed.port) };
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stderrTail = '';
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      finish(new Error('GIS worker did not announce readiness in time'));
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
      finish(new Error(`GIS worker could not be spawned (${error?.code ?? 'spawn-error'})`));
    };
    const onExit = (code, signal) => {
      const detail = stderrTail.trim();
      finish(new Error(
        `GIS worker exited before readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
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

async function readConfigFile(configFile) {
  let bytes;
  try {
    bytes = await readFile(configFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw Object.assign(new Error(`GIS config is not valid JSON: ${error.message}`), {
      code: 'config-invalid',
    });
  }
  try {
    assertValidGisConfig(value);
  } catch (error) {
    throw Object.assign(new Error(error.message), {
      code: 'config-invalid',
      details: error.details,
    });
  }
  return { value, bytes, sha256: sha256(bytes) };
}

async function writeConfigFile(configFile, config) {
  assertValidGisConfig(config);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  try {
    await rename(temporary, configFile);
  } catch (error) {
    // Never delete the only config just because replacement failed. Keep the
    // original file intact and remove only the incomplete temporary file.
    try {
      await rm(temporary, { force: true });
    } catch {
      // The original error is the actionable one.
    }
    throw error;
  }
  return sha256(bytes);
}

/**
 * Start or restart the GIS fixture.
 *
 * The returned object is a live closure. `url` and `instanceId` are getters so
 * they show the current process after `restart()`. Configuration edits do not
 * affect the running process until `restart()` is called.
 *
 * @param {{directory: string, config?: object}} options
 */
export async function startGis({ directory, config } = {}) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new TypeError('directory must be a non-empty path');
  }
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const configFile = join(root, 'config.json');

  if (config !== undefined) {
    await writeConfigFile(configFile, config);
  } else {
    const existing = await readConfigFile(configFile);
    if (existing === null) await writeConfigFile(configFile, defaultGisConfig());
  }

  const state = {
    child: null,
    url: null,
    instanceId: null,
    configSha256: null,
    closed: false,
    lastError: null,
    lastExit: null,
  };

  function ensureOpen() {
    if (state.closed) throw new Error('GIS fixture is closed');
  }

  async function readConfig() {
    ensureOpen();
    const document = await readConfigFile(configFile);
    if (document === null) {
      throw Object.assign(new Error('GIS config file no longer exists'), { code: 'config-missing' });
    }
    return document.value;
  }

  async function spawnService({ avoidPort = null } = {}) {
    const instanceId = randomUUID();
    const args = [
      WORKER_PATH,
      `--role=${ROLE}`,
      `--instance=${instanceId}`,
      `--config=${configFile}`,
    ];
    if (avoidPort !== null) args.push(`--avoid-port=${avoidPort}`);

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    state.child = child;

    try {
      const ready = await waitForReady(child);
      if (ready.instance !== instanceId) {
        throw new Error('GIS worker announced an unexpected instance id');
      }
      if (ready.role !== ROLE) {
        throw new Error('GIS worker announced an unexpected role');
      }
      if (typeof ready.configSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ready.configSha256)) {
        throw new Error('GIS worker did not announce a valid config digest');
      }
      const endpoint = validateReadyUrl(ready.url);
      child.stdout.resume();
      child.stderr.resume();
      child.once('exit', (code, signal) => {
        if (state.child === child) {
          state.lastExit = { code, signal, at: new Date().toISOString() };
        }
      });
      state.url = endpoint.origin;
      state.instanceId = instanceId;
      state.configSha256 = ready.configSha256;
      state.lastError = null;
      return { child, endpoint };
    } catch (error) {
      await stopChild(child);
      if (state.child === child) state.child = null;
      state.lastError = error;
      throw error;
    }
  }

  async function restart() {
    ensureOpen();
    const previous = state.child;
    const previousPort = state.url ? Number(new URL(state.url).port) : null;
    try {
      await stopChild(previous);
    } catch (error) {
      // Keep the child reference; do not start a replacement while the old
      // process may still be alive.
      state.lastError = error;
      throw error;
    }
    if (state.child === previous) state.child = null;
    state.url = null;
    state.instanceId = null;
    state.configSha256 = null;

    await spawnService({ avoidPort: previousPort });
    return service;
  }

  async function updateConfig(patch) {
    ensureOpen();
    if (!isRecord(patch)) throw new TypeError('config patch must be a JSON object');
    const current = await readConfig();
    const merged = { ...current, ...patch };
    // Validation happens before the write, so an invalid patch cannot leave a
    // half-written config on disk.
    assertValidGisConfig(merged);
    const digest = await writeConfigFile(configFile, merged);
    return { config: merged, configSha256: digest, requiresRestart: true };
  }

  async function close() {
    if (state.closed) return;
    const child = state.child;
    await stopChild(child);
    // Clear the live state only after the process actually stopped, so a
    // failed stop leaves the service retryable and its endpoint observable.
    state.child = null;
    state.url = null;
    state.instanceId = null;
    state.configSha256 = null;
    state.closed = true;
  }

  const service = {
    role: ROLE,
    directory: root,
    configFile,
    get url() {
      return state.url;
    },
    get instanceId() {
      return state.instanceId;
    },
    get configSha256() {
      return state.configSha256;
    },
    get running() {
      return !state.closed && processIsAlive(state.child) && state.url !== null;
    },
    get lastError() {
      return state.lastError;
    },
    get lastExit() {
      return state.lastExit;
    },
    readConfig,
    updateConfig,
    restart,
    close,
  };

  await spawnService({ avoidPort: null });
  return service;
}

function sameBounds(left, right) {
  return left.west === right.west && left.south === right.south &&
    left.east === right.east && left.north === right.north;
}

function isFullExtent(bbox, bounds) {
  return bbox[0] === bounds.south && bbox[1] === bounds.west &&
    bbox[2] === bounds.north && bbox[3] === bounds.east;
}

function goldenSamplesFor({ config, layer, bbox, width, height }) {
  if (!sameBounds(config.bounds, GOLDEN_BOUNDS) || !isFullExtent(bbox, config.bounds)) return null;
  if (width === 4 && height === 3 && layer.seed === 17) return GOLDEN_FULL_4X3_SEED17;
  if (width === 2 && height === 2 && layer.seed === 203) return GOLDEN_FULL_2X2_SEED203;
  return null;
}

/**
 * Independent sample oracle: a frozen golden table for the default extent plus
 * channel/order invariants that do not reimplement the renderer formula.
 */
function sampleOracle({ result, layer, golden }) {
  const samples = result?.image?.samples ?? [];
  const byName = new Map(samples.map(sample => [sample.name, sample]));
  const topLeft = byName.get('top-left');
  const topRight = byName.get('top-right');
  const bottomLeft = byName.get('bottom-left');
  const bottomRight = byName.get('bottom-right');

  const blueChannelMatchesLayerSeed = samples.length > 0 &&
    samples.every(sample => sample.rgb[2] === layer.seed);
  const axisOrientation = Boolean(topLeft && topRight && bottomLeft && bottomRight &&
    topLeft.rgb[0] < topRight.rgb[0] && bottomLeft.rgb[0] < bottomRight.rgb[0] &&
    topLeft.rgb[1] < bottomLeft.rgb[1] && topRight.rgb[1] < bottomRight.rgb[1]);
  const goldenMatch = golden
    ? golden.every(expected => {
      const observed = byName.get(expected.name);
      return Boolean(observed) && observed.x === expected.x && observed.y === expected.y &&
        JSON.stringify(observed.rgb) === JSON.stringify(expected.rgb);
    })
    : null;

  return {
    kind: golden ? 'golden + invariants' : 'invariants',
    pass: result?.ok === true && blueChannelMatchesLayerSeed && axisOrientation &&
      (golden ? goldenMatch === true : true),
    blueChannelMatchesLayerSeed,
    axisOrientation,
    goldenSamples: golden,
    goldenMatch,
  };
}

function summarizeMap(result, oracle) {
  return {
    ok: result.ok,
    status: result.status,
    contentType: result.contentType,
    requestUrl: result.requestUrl,
    byteLength: result.byteLength,
    sha256: result.sha256,
    elapsedMs: result.elapsedMs,
    axisOrder: result.axisOrder,
    headerAxisOrder: result.headerAxisOrder,
    headers: result.headers,
    image: result.image,
    oracle,
    exception: result.exception,
    problem: result.problem ?? null,
  };
}

/**
 * Run the phase-3 protocol evidence against a fresh fixture. `keepRunning`
 * leaves the (possibly reconfigured) service alive for later phases; otherwise
 * the service is closed after evidence collection.
 */
export async function runGisEvolution({ directory, keepRunning = false } = {}) {
  const totalStartedAt = Date.now();
  const service = await startGis({ directory });
  const startMs = Date.now() - totalStartedAt;
  const costs = {
    startMs,
    configWriteMs: 0,
    capabilitiesMs: 0,
    mapsMs: 0,
    boundaryProbesMs: 0,
    restartMs: 0,
    httpRequests: 0,
    httpBytes: 0,
    mapBytes: 0,
    mapPixels: 0,
    processStarts: 1,
    configWrites: 0,
    configWriteAttempts: 0,
    filesChanged: [service.configFile],
  };
  const checks = [];
  const boundaries = [];
  let result = null;

  function check(id, status, reason, details = {}) {
    // Keep evidence details nested: a detail such as the observed HTTP status
    // must not overwrite the check's own pass/fail status.
    checks.push({ id, status, reason, details });
  }

  function count(resultOrRaw) {
    costs.httpRequests += 1;
    if (typeof resultOrRaw.byteLength === 'number') costs.httpBytes += resultOrRaw.byteLength;
    return resultOrRaw;
  }

  try {
    const config = await service.readConfig();
    const initialEndpoint = {
      url: service.url,
      instanceId: service.instanceId,
      configSha256: service.configSha256,
    };
    const fullBbox = [config.bounds.south, config.bounds.west, config.bounds.north, config.bounds.east];

    const capabilitiesStarted = Date.now();
    const initialCapabilities = count(await getCapabilities(service.url));
    costs.capabilitiesMs += Date.now() - capabilitiesStarted;
    const parsed = initialCapabilities.capabilities;

    check('capabilities.transport', initialCapabilities.status === 200 ? 'pass' : 'fail',
      `GetCapabilities returned HTTP ${initialCapabilities.status ?? 'none'} (${initialCapabilities.contentType ?? 'no content type'}).`,
      { status: initialCapabilities.status, contentType: initialCapabilities.contentType });
    check('capabilities.version', parsed?.version === PROTOCOL_VERSION ? 'pass' : 'fail',
      `Capabilities version is ${parsed?.version ?? 'missing'}; the fixture implements ${PROTOCOL_VERSION} only.`);
    check('capabilities.title', parsed?.serviceTitle === config.title ? 'pass' : 'fail',
      'Service title in GetCapabilities reflects the configured title.',
      { observed: parsed?.serviceTitle, configured: config.title });
    const offeredLayers = parsed?.layers.map(layer => layer.name) ?? [];
    const configuredLayerNames = config.layers.map(layer => layer.name);
    check('capabilities.layers', offeredLayers.length === configuredLayerNames.length &&
      JSON.stringify(offeredLayers) === JSON.stringify(configuredLayerNames)
      ? 'pass' : 'fail',
      'Layer names in GetCapabilities match the configuration.',
      { observed: offeredLayers, configured: configuredLayerNames });
    check('capabilities.crs', Boolean(parsed?.layers.length) &&
      parsed.layers.every(layer => layer.crs.includes(CRS)) ? 'pass' : 'fail',
      `Every advertised layer lists ${CRS}; no additional CRS is implemented.`);
    check('capabilities.getmap-format', parsed?.operations.getMap.formats.includes('image/png')
      ? 'pass' : 'fail',
      'GetMap advertises image/png.', { formats: parsed?.operations.getMap.formats ?? [] });

    const fullWidth = 4;
    const fullHeight = 3;
    const fullLayer = config.layers[0];
    const mapsStarted = Date.now();
    const fullMap = count(await getMap(service.url, {
      layers: fullLayer.name,
      bbox: fullBbox,
      width: fullWidth,
      height: fullHeight,
    }));
    costs.mapBytes += fullMap.byteLength ?? 0;
    costs.mapsMs += Date.now() - mapsStarted;
    costs.mapPixels += fullWidth * fullHeight;
    const fullGolden = goldenSamplesFor({
      config, layer: fullLayer, bbox: fullBbox, width: fullWidth, height: fullHeight,
    });
    const fullOracle = sampleOracle({ result: fullMap, layer: fullLayer, golden: fullGolden });
    check('getmap.full-extent', fullOracle.pass ? 'pass' : 'fail',
      fullGolden
        ? 'GetMap samples match frozen golden coordinates and independent channel/order invariants.'
        : 'GetMap samples satisfy independent layer-seed and axis-orientation invariants.',
      {
        request: { layers: fullLayer.name, bbox: fullBbox, width: fullWidth, height: fullHeight },
        oracle: fullOracle,
        observedSamples: fullMap.image?.samples ?? null,
        sha256: fullMap.sha256,
      });
    check('getmap.axis-order-header', fullMap.headerAxisOrder === 'lat,lon' ? 'pass' : 'fail',
      'The server declares EPSG:4326 bbox axis order as lat,lon (WMS 1.3.0).',
      { observed: fullMap.headerAxisOrder });

    const subsetLayer = config.layers[1] ?? config.layers[0];
    const latSpan = config.bounds.north - config.bounds.south;
    const lonSpan = config.bounds.east - config.bounds.west;
    const subsetBbox = [
      config.bounds.south + latSpan * 0.2,
      config.bounds.west + lonSpan * 0.2,
      config.bounds.north - latSpan * 0.2,
      config.bounds.east - lonSpan * 0.2,
    ];
    const subsetWidth = 3;
    const subsetHeight = 2;
    const subsetStarted = Date.now();
    const subsetMap = count(await getMap(service.url, {
      layers: subsetLayer.name,
      bbox: subsetBbox,
      width: subsetWidth,
      height: subsetHeight,
    }));
    costs.mapBytes += subsetMap.byteLength ?? 0;
    costs.mapsMs += Date.now() - subsetStarted;
    costs.mapPixels += subsetWidth * subsetHeight;
    const subsetOracle = sampleOracle({ result: subsetMap, layer: subsetLayer, golden: null });
    check('getmap.parameter-effect', subsetOracle.pass && subsetMap.sha256 !== fullMap.sha256
      ? 'pass' : 'fail',
      'A different layer/bbox/size produces different bytes while satisfying independent layer-seed and axis-orientation invariants.',
      {
        request: { layers: subsetLayer.name, bbox: subsetBbox, width: subsetWidth, height: subsetHeight },
        oracle: subsetOracle,
        observedSamples: subsetMap.image?.samples ?? null,
        sha256: subsetMap.sha256,
        previousSha256: fullMap.sha256,
      });

    const repeatStarted = Date.now();
    const repeatMap = count(await getMap(service.url, {
      layers: fullLayer.name,
      bbox: fullBbox,
      width: fullWidth,
      height: fullHeight,
    }));
    costs.mapBytes += repeatMap.byteLength ?? 0;
    costs.mapsMs += Date.now() - repeatStarted;
    costs.mapPixels += fullWidth * fullHeight;
    const repeatOracle = sampleOracle({ result: repeatMap, layer: fullLayer, golden: fullGolden });
    check('getmap.deterministic', repeatOracle.pass && repeatMap.sha256 === fullMap.sha256
      ? 'pass' : 'fail',
      'The same request reproduces the same image bytes for this deterministic stand-in.',
      { sha256: repeatMap.sha256, firstSha256: fullMap.sha256, oracle: repeatOracle });

    const baseProbe = {
      service: 'WMS',
      request: 'GetMap',
      version: '1.3.0',
      layers: fullLayer.name,
      styles: '',
      crs: CRS,
      bbox: fullBbox.join(','),
      width: 2,
      height: 2,
      format: 'image/png',
    };

    async function probe(name, overrides, expectedCode, reason) {
      const started = Date.now();
      const raw = count(await requestWms(service.url, { ...baseProbe, ...overrides }));
      const parsedException = raw.exception;
      const pass = raw.status === 400 &&
        (raw.contentType ?? '').includes('vnd.ogc.se_xml') &&
        parsedException?.code === expectedCode &&
        parsedException.xml.includes('<ServiceExceptionReport');
      const observation = {
        name,
        request: { ...baseProbe, ...overrides },
        status: raw.status,
        contentType: raw.contentType,
        exception: parsedException ? { code: parsedException.code, message: parsedException.message } : null,
        xml: parsedException?.xml ?? (raw.bytes ? raw.bytes.toString('utf8') : null),
        xmlSha256: raw.sha256,
        elapsedMs: raw.elapsedMs,
        pass,
      };
      boundaries.push(observation);
      check(`boundary.${name}`, pass ? 'pass' : 'fail', reason, {
        expectedCode,
        observedCode: parsedException?.code ?? null,
        status: raw.status,
      });
      costs.boundaryProbesMs += Date.now() - started;
      return observation;
    }

    await probe(
      'axis-order',
      { bbox: [config.bounds.west, config.bounds.south, config.bounds.east, config.bounds.north].join(',') },
      'InvalidParameterValue',
      'Supplying bbox in lon,lat order is rejected with ServiceException XML, not silently swapped.',
    );
    await probe('unsupported-crs', { crs: 'EPSG:3857' }, 'InvalidCRS',
      'EPSG:3857 is rejected with InvalidCRS instead of being claimed as supported.');
    await probe('unsupported-version', { version: '1.1.1' }, 'InvalidVersion',
      'WMS 1.1.1 is rejected; this fixture implements only 1.3.0.');
    await probe('width-over-limit', { width: config.maxWidth + 1, height: 1 }, 'InvalidParameterValue',
      'A width above the configured maximum is rejected.');
    await probe('unknown-layer', { layers: 'not-a-layer' }, 'LayerNotDefined',
      'An unknown LAYERS value is rejected with LayerNotDefined.');
    await probe('unsupported-format', { format: 'image/jpeg' }, 'InvalidFormat',
      'image/jpeg is rejected; only image/png is implemented.');
    await probe('missing-bbox', { bbox: undefined }, 'MissingParameterValue',
      'A missing BBOX is rejected with MissingParameterValue.');
    await probe('alpha-not-implemented', { transparent: 'TRUE' }, 'OperationNotSupported',
      'TRANSPARENT=TRUE is rejected rather than returning an opaque image while claiming alpha.');

    const configFileBefore = await readFile(service.configFile);
    const beforeSha = sha256(configFileBefore);
    let invalidConfigError = null;
    costs.configWriteAttempts += 1;
    try {
      await service.updateConfig({ crs: ['EPSG:3857'] });
    } catch (error) {
      invalidConfigError = error;
    }
    const configFileAfterInvalid = await readFile(service.configFile);
    check('config.invalid-rejected',
      invalidConfigError?.code === 'config-invalid' && sha256(configFileAfterInvalid) === beforeSha
        ? 'pass' : 'fail',
      'An unsupported CRS config edit is rejected before writing; the file digest is unchanged.',
      {
        errorCode: invalidConfigError?.code ?? null,
        errorMessage: invalidConfigError?.message ?? null,
        configSha256: beforeSha,
      });

    const revisedTitle = `${config.title} (revision 2)`;
    let revisedName = 'parcels';
    for (let suffix = 2; config.layers.some(layer => layer.name === revisedName); suffix += 1) {
      revisedName = `parcels-${suffix}`;
    }
    const revisedLayer = { name: revisedName, title: 'Synthetic parcel index', seed: 203 };
    const revisedConfig = {
      ...config,
      title: revisedTitle,
      layers: [...config.layers, revisedLayer],
    };
    const writeStarted = Date.now();
    const update = await service.updateConfig({ title: revisedTitle, layers: revisedConfig.layers });
    costs.configWriteMs += Date.now() - writeStarted;
    costs.configWrites += 1;
    costs.configWriteAttempts += 1;
    check('config.write', update.configSha256 === sha256(await readFile(service.configFile))
      ? 'pass' : 'fail',
      'A valid config edit is written to the fixture config file; it does not affect the running process yet.',
      { configSha256: update.configSha256, requiresRestart: update.requiresRestart });

    const oldUrl = service.url;
    const oldInstance = service.instanceId;
    const restartStarted = Date.now();
    await service.restart();
    costs.restartMs += Date.now() - restartStarted;
    costs.processStarts += 1;
    check('restart.new-endpoint',
      service.url !== oldUrl && service.instanceId !== oldInstance && service.running
        ? 'pass' : 'fail',
      'restart() starts a new local process on a new port with a new instance id.',
      { oldUrl, newUrl: service.url, oldInstance, newInstance: service.instanceId });

    const oldUrlProbe = count(await requestWms(oldUrl, {
      service: 'WMS', request: 'GetCapabilities', version: '1.3.0',
    }));
    check('restart.old-url-invalid',
      oldUrlProbe.status === null ? 'pass' : 'fail',
      'The previous instance URL no longer answers after restart.',
      { oldUrl, status: oldUrlProbe.status, error: oldUrlProbe.error });

    const revisedCapabilities = count(await getCapabilities(service.url));
    const revisedParsed = revisedCapabilities.capabilities;
    check('restart.config-effective',
      revisedParsed?.serviceTitle === revisedTitle &&
      revisedParsed.layers.some(layer => layer.name === revisedLayer.name) &&
      revisedCapabilities.status === 200
        ? 'pass' : 'fail',
      'After restart, GetCapabilities serves the edited title and the added layer.',
      {
        title: revisedParsed?.serviceTitle,
        layers: revisedParsed?.layers.map(layer => layer.name) ?? [],
      });

    const revisedBbox = [config.bounds.south, config.bounds.west, config.bounds.north, config.bounds.east];
    const revisedMap = count(await getMap(service.url, {
      layers: revisedLayer.name,
      bbox: revisedBbox,
      width: 2,
      height: 2,
    }));
    const revisedGolden = goldenSamplesFor({
      config: revisedConfig, layer: revisedLayer, bbox: revisedBbox, width: 2, height: 2,
    });
    const revisedOracle = sampleOracle({ result: revisedMap, layer: revisedLayer, golden: revisedGolden });
    check('restart.added-layer-map',
      revisedOracle.pass ? 'pass' : 'fail',
      'The newly configured layer satisfies its seed invariant and, for the default extent, frozen golden samples.',
      {
        oracle: revisedOracle,
        observedSamples: revisedMap.image?.samples ?? null,
        sha256: revisedMap.sha256,
      });
    costs.mapBytes += revisedMap.byteLength ?? 0;
    costs.mapPixels += 4;

    const serviceState = {
      directory: service.directory,
      configFile: service.configFile,
      role: service.role,
      initial: initialEndpoint,
      revised: {
        url: service.url,
        instanceId: service.instanceId,
        configSha256: service.configSha256,
      },
      runningAtCollection: service.running,
      closedByRunner: false,
    };

    result = {
      service,
      evidence: {
        ok: checks.every(entry => entry.status === 'pass'),
        collectedAt: new Date().toISOString(),
        scope: 'single local http://127.0.0.1 process; logical stand-in, not production, multi-host, or ArcGIS',
        implementation: {
          protocol: 'OGC WMS 1.3.0 subset',
          version: PROTOCOL_VERSION,
          crs: [CRS],
          axisOrder: 'lat,lon for EPSG:4326 bbox',
          layersPerRequest: 1,
          formats: ['image/png'],
          png: '8-bit truecolour, filter 0, no interlace (in-repo encoder/decoder)',
          unsupported: ['WMS 1.1.1', 'EPSG:3857', 'image/jpeg', 'TRANSPARENT', 'BGCOLOR'],
        },
        service: serviceState,
        capabilities: {
          initial: {
            status: initialCapabilities.status,
            contentType: initialCapabilities.contentType,
            requestUrl: initialCapabilities.requestUrl,
            xml: initialCapabilities.xml,
            xmlSha256: initialCapabilities.sha256,
            parsed,
          },
          revised: {
            status: revisedCapabilities.status,
            contentType: revisedCapabilities.contentType,
            requestUrl: revisedCapabilities.requestUrl,
            xml: revisedCapabilities.xml,
            xmlSha256: revisedCapabilities.sha256,
            parsed: revisedParsed,
          },
        },
        maps: {
          fullExtent: summarizeMap(fullMap, fullOracle),
          subset: summarizeMap(subsetMap, subsetOracle),
          repeated: summarizeMap(repeatMap, repeatOracle),
          revisedLayer: summarizeMap(revisedMap, revisedOracle),
        },
        boundaries: {
          probes: boundaries,
          serviceExceptionsAreXml: boundaries.every(entry =>
            (entry.contentType ?? '').includes('vnd.ogc.se_xml') && entry.xml?.includes('<ServiceExceptionReport')),
        },
        configChange: {
          invalidEditRejected: {
            errorCode: invalidConfigError?.code ?? null,
            fileSha256Unchanged: sha256(configFileAfterInvalid) === beforeSha,
          },
          applied: {
            configSha256: update.configSha256,
            requiresRestart: update.requiresRestart,
            title: revisedTitle,
            layers: revisedConfig.layers.map(layer => layer.name),
          },
          restart: {
            oldUrl,
            oldInstance,
            newUrl: service.url,
            newInstance: service.instanceId,
            oldUrlStatus: oldUrlProbe.status,
            oldUrlError: oldUrlProbe.error,
          },
        },
        costs: { ...costs, totalMs: Date.now() - totalStartedAt },
        checks,
        limitations: [
          'The fixture is a bounded local WMS 1.3.0 stand-in, not a complete or certified WMS/OGC implementation.',
          'PNG encoding/decoding supports only the subset this fixture produces.',
          'Only one layer per GetMap request; no SLD, GetFeatureInfo, time dimensions, or authentication.',
          'No multi-host, production traffic, or TLS claim is made.',
        ],
      },
      close: service.close,
      gis: service,
    };
    return result;
  } finally {
    // keepRunning applies only to a completed evidence run. If the runner
    // throws before returning, the caller has no service object to close, so
    // the child must be stopped here even when keepRunning was requested.
    if (!keepRunning || result === null) {
      try {
        await service.close();
        if (result) {
          result.evidence.service.closedByRunner = true;
        }
      } catch (error) {
        if (result) {
          result.evidence.cleanupError = error.message;
          result.evidence.service.closedByRunner = false;
          result.evidence.ok = false;
          result.evidence.checks.push({
            id: 'cleanup.close',
            status: 'fail',
            reason: `The GIS service could not be stopped after evidence collection: ${error.message}.`,
            details: { message: error.message },
          });
        }
      }
    }
  }
}
