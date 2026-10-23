#!/usr/bin/env node
/**
 * Bounded local WMS 1.3.0 stand-in.
 *
 * Implemented protocol surface (deliberately narrow):
 * - GetCapabilities for SERVICE=WMS, VERSION absent or 1.3.0.
 * - GetMap for VERSION=1.3.0, CRS=EPSG:4326, FORMAT=image/png, one LAYERS value.
 * - EPSG:4326 axis order is latitude,longitude, per WMS 1.3.0.
 * - Errors are OGC ServiceExceptionReport XML, not a JSON substitute.
 *
 * Pixels are derived from the requested layer seed, bbox, and image size, so
 * the returned PNG changes with those parameters. This is not a complete WMS,
 * not OGC-certified, and not an ArcGIS emulation. It binds 127.0.0.1 only.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { assertValidGisConfig } from './gis-config.js';
import { encodePng } from './png-codec.js';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function startupError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  const values = { config: null, role: null, instance: null, avoidPort: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw startupError('invalid-arguments', 'unexpected worker argument');
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (name === 'config') values.config = value;
    else if (name === 'role') values.role = value;
    else if (name === 'instance') values.instance = value;
    else if (name === 'avoid-port') values.avoidPort = value;
    else throw startupError('invalid-arguments', 'unknown worker argument');
  }
  if (typeof values.config !== 'string' || values.config.length === 0) {
    throw startupError('invalid-arguments', 'config path is required');
  }
  if (typeof values.role !== 'string' || !NAME_PATTERN.test(values.role)) {
    throw startupError('invalid-arguments', 'role must be a short identifier');
  }
  if (typeof values.instance !== 'string' || values.instance.length === 0) {
    throw startupError('invalid-arguments', 'instance is required');
  }
  if (values.avoidPort !== null) {
    if (!/^\d+$/.test(values.avoidPort)) {
      throw startupError('invalid-arguments', 'avoid-port must be an integer');
    }
    values.avoidPort = Number(values.avoidPort);
    if (!Number.isInteger(values.avoidPort) || values.avoidPort < 1 || values.avoidPort > 65535) {
      throw startupError('invalid-arguments', 'avoid-port is outside the TCP port range');
    }
  }
  return values;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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

function sendXml(response, status, xml, contentType = 'text/xml; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(xml),
    'cache-control': 'no-store',
  });
  response.end(xml);
}

function serviceException(code, message, status = 400) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc">`
    + `<ServiceException code="${escapeXml(code)}">${escapeXml(message)}</ServiceException>`
    + '</ServiceExceptionReport>\n';
  return { code, message, status, xml };
}

function readParams(request) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const params = new Map();
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (!params.has(lower)) params.set(lower, value);
  }
  return { pathname: url.pathname, params };
}

function param(params, name) {
  return params.has(name) ? params.get(name) : null;
}

function requireParam(params, name) {
  const value = param(params, name);
  if (value === null || value === '') {
    throw serviceException('MissingParameterValue', `Required parameter ${name.toUpperCase()} is missing or empty.`);
  }
  return value;
}

function parseBbox(text) {
  const parts = text.split(',');
  if (parts.length !== 4) {
    throw serviceException('InvalidParameterValue', 'BBOX must contain exactly four comma-separated numbers.');
  }
  const numbers = parts.map(part => {
    const trimmed = part.trim();
    if (trimmed.length === 0) return Number.NaN;
    return Number(trimmed);
  });
  if (numbers.some(value => !Number.isFinite(value))) {
    throw serviceException('InvalidParameterValue', 'BBOX contains a value that is not a finite number.');
  }
  return numbers;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function renderMap({ config, layer, bbox, width, height }) {
  // bbox is already in EPSG:4326 latitude,longitude axis order.
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const world = config.bounds;
  const worldWidth = world.east - world.west;
  const worldHeight = world.north - world.south;
  const rgb = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    const lat = maxLat - ((y + 0.5) / height) * (maxLat - minLat);
    const green = Math.round(clamp01((world.north - lat) / worldHeight) * 255);
    for (let x = 0; x < width; x += 1) {
      const lon = minLon + ((x + 0.5) / width) * (maxLon - minLon);
      const red = Math.round(clamp01((lon - world.west) / worldWidth) * 255);
      const offset = (y * width + x) * 3;
      rgb[offset] = red;
      rgb[offset + 1] = green;
      rgb[offset + 2] = layer.seed;
    }
  }

  return encodePng({ width, height, rgb });
}

function capabilitiesXml({ config, origin }) {
  const world = config.bounds;
  const layerXml = config.layers.map(layer => `
      <Layer queryable="0" opaque="0" cascaded="0">
        <Name>${escapeXml(layer.name)}</Name>
        <Title>${escapeXml(layer.title)}</Title>
        <CRS>EPSG:4326</CRS>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>${world.west}</westBoundLongitude>
          <eastBoundLongitude>${world.east}</eastBoundLongitude>
          <southBoundLatitude>${world.south}</southBoundLatitude>
          <northBoundLatitude>${world.north}</northBoundLatitude>
        </EX_GeographicBoundingBox>
        <Style>
          <Name>default</Name>
          <Title>Default</Title>
        </Style>
      </Layer>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0"
  xmlns="http://www.opengis.net/wms"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/wms http://schemas.opengis.net/wms/1.3.0/capabilities_1_3_0.xsd">
  <Service>
    <Name>WMS</Name>
    <Title>${escapeXml(config.title)}</Title>
    <OnlineResource xlink:type="simple" xlink:href="${escapeXml(`${origin}/wms?`)}"/>
  </Service>
  <Capability>
    <Request>
      <GetCapabilities>
        <Format>text/xml</Format>
        <DCPType>
          <HTTP>
            <Get><OnlineResource xlink:type="simple" xlink:href="${escapeXml(`${origin}/wms?`)}"/></Get>
          </HTTP>
        </DCPType>
      </GetCapabilities>
      <GetMap>
        <Format>image/png</Format>
        <DCPType>
          <HTTP>
            <Get><OnlineResource xlink:type="simple" xlink:href="${escapeXml(`${origin}/wms?`)}"/></Get>
          </HTTP>
        </DCPType>
      </GetMap>
    </Request>
    <Exception>
      <Format>XML</Format>
    </Exception>
    <Layer queryable="0" opaque="0" cascaded="0">
      <Title>${escapeXml(config.title)}</Title>
      <CRS>EPSG:4326</CRS>
      <EX_GeographicBoundingBox>
        <westBoundLongitude>${world.west}</westBoundLongitude>
        <eastBoundLongitude>${world.east}</eastBoundLongitude>
        <southBoundLatitude>${world.south}</southBoundLatitude>
        <northBoundLatitude>${world.north}</northBoundLatitude>
      </EX_GeographicBoundingBox>${layerXml}
    </Layer>
  </Capability>
</WMS_Capabilities>
`;
}

function checkService(params) {
  const value = param(params, 'service');
  if (value === null) {
    throw serviceException('MissingParameterValue', 'Required parameter SERVICE is missing.');
  }
  if (value.toLowerCase() !== 'wms') {
    throw serviceException('InvalidParameterValue', 'SERVICE must be WMS.');
  }
}

function handleCapabilities({ params, origin, config }) {
  checkService(params);
  const version = param(params, 'version');
  if (version !== null && version !== '1.3.0') {
    throw serviceException('InvalidVersion', `VERSION ${version} is not supported; this fixture implements WMS 1.3.0 only.`);
  }
  return {
    status: 200,
    contentType: 'text/xml; charset=utf-8',
    xml: capabilitiesXml({ config, origin }),
  };
}

function handleMap({ params, origin, config }) {
  checkService(params);

  const version = requireParam(params, 'version');
  if (version !== '1.3.0') {
    throw serviceException('InvalidVersion', `VERSION ${version} is not supported; this fixture implements WMS 1.3.0 only.`);
  }

  const layersValue = requireParam(params, 'layers');
  const layerNames = layersValue.split(',').map(value => value.trim()).filter(value => value.length > 0);
  if (layerNames.length === 0) {
    throw serviceException('MissingParameterValue', 'LAYERS contains no layer name.');
  }
  if (layerNames.length > 1) {
    throw serviceException('InvalidParameterValue', 'This bounded stand-in renders exactly one LAYERS value per request.');
  }
  const layer = config.layers.find(item => item.name === layerNames[0]);
  if (!layer) {
    throw serviceException('LayerNotDefined', `Layer "${layerNames[0]}" is not offered by this service.`);
  }

  // STYLES is mandatory but the empty value is valid in WMS; requireParam
  // would reject it as missing, so presence is checked separately.
  const styles = param(params, 'styles');
  if (styles === null) {
    throw serviceException('MissingParameterValue', 'Required parameter STYLES is missing.');
  }
  if (styles !== '' && styles !== 'default') {
    throw serviceException('StyleNotDefined', `Style "${styles}" is not offered; use an empty STYLES value or "default".`);
  }

  const crs = requireParam(params, 'crs');
  if (crs !== 'EPSG:4326') {
    throw serviceException('InvalidCRS', `CRS "${crs}" is not supported; this fixture implements EPSG:4326 only.`);
  }

  const bboxText = requireParam(params, 'bbox');
  const bbox = parseBbox(bboxText);
  let [minLat, minLon, maxLat, maxLon] = bbox;
  if (!(minLat < maxLat) || !(minLon < maxLon)) {
    throw serviceException(
      'InvalidParameterValue',
      'BBOX bounds are empty or inverted. WMS 1.3.0 EPSG:4326 axis order is minLat,minLon,maxLat,maxLon.',
    );
  }

  const world = config.bounds;
  const outsideCoverage =
    minLon < world.west || maxLon > world.east || minLat < world.south || maxLat > world.north;
  if (outsideCoverage) {
    // Detect the common lon,lat mix-up without correcting it: the request is
    // still rejected, but the message names the likely axis-order mistake.
    const swappedFits =
      minLat >= world.west && maxLat <= world.east &&
      minLon >= world.south && maxLon <= world.north;
    const hint = swappedFits
      ? ' The values appear to be lon,lat; WMS 1.3.0 EPSG:4326 requires lat,lon and no silent swap is performed.'
      : '';
    throw serviceException(
      'InvalidParameterValue',
      `BBOX is outside the configured layer coverage lon[${world.west},${world.east}] lat[${world.south},${world.north}].${hint}`,
    );
  }

  const widthText = requireParam(params, 'width');
  const heightText = requireParam(params, 'height');
  if (!/^\d+$/.test(widthText) || !/^\d+$/.test(heightText)) {
    throw serviceException('InvalidParameterValue', 'WIDTH and HEIGHT must be positive integers.');
  }
  const width = Number(widthText);
  const height = Number(heightText);
  if (width < 1 || width > config.maxWidth) {
    throw serviceException('InvalidParameterValue', `WIDTH must be between 1 and ${config.maxWidth}.`);
  }
  if (height < 1 || height > config.maxHeight) {
    throw serviceException('InvalidParameterValue', `HEIGHT must be between 1 and ${config.maxHeight}.`);
  }

  const format = requireParam(params, 'format');
  if (format.toLowerCase() !== 'image/png') {
    throw serviceException('InvalidFormat', `FORMAT "${format}" is not supported; this fixture returns image/png only.`);
  }

  const transparent = param(params, 'transparent');
  if (transparent !== null && !['false', '0'].includes(transparent.toLowerCase())) {
    throw serviceException('OperationNotSupported', 'TRANSPARENT alpha output is not implemented; returned PNGs are opaque.');
  }
  if (param(params, 'bgcolor') !== null) {
    throw serviceException('OperationNotSupported', 'BGCOLOR is not implemented; returned PNGs have no background colour option.');
  }

  const bytes = renderMap({ config, layer, bbox, width, height });
  return {
    status: 200,
    contentType: 'image/png',
    bytes,
    headers: {
      'x-wms-crs': 'EPSG:4326',
      'x-wms-bbox-order': 'lat,lon',
      'x-wms-request-bbox': bboxText,
      'x-wms-canonical-bbox': `${minLon},${minLat},${maxLon},${maxLat}`,
      'x-wms-layer': layer.name,
      'x-wms-width': String(width),
      'x-wms-height': String(height),
      'x-wms-map-sha256': sha256(bytes),
    },
  };
}

function announceReady({ role, instance, url, configSha256 }) {
  process.stdout.write(`${JSON.stringify({ event: 'ready', role, instance, url, configSha256 })}\n`);
}

function listen(server, avoidPort) {
  return (async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const port = await new Promise((resolve, reject) => {
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
      if (avoidPort === null || port !== avoidPort) return port;
      await new Promise(resolve => server.close(resolve));
    }
    throw startupError('bind-failed', 'could not bind a TCP port different from the previous instance port');
  })();
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

async function readConfig(configPath) {
  let bytes;
  try {
    bytes = await readFile(configPath);
  } catch (error) {
    throw startupError('config-unreadable', `config could not be read: ${error.code ?? 'read-failed'}`);
  }
  let config;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw startupError('config-invalid', 'config is not valid JSON');
  }
  try {
    assertValidGisConfig(config);
  } catch (error) {
    throw startupError('config-invalid', error.message);
  }
  return { config, configSha256: sha256(bytes) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { config, configSha256 } = await readConfig(options.config);
  const counters = { capabilities: 0, maps: 0, exceptions: 0, health: 0, requests: 0 };
  const startedAt = Date.now();

  const server = createServer((request, response) => {
    let parsed;
    try {
      parsed = readParams(request);
    } catch {
      sendJson(response, 400, { error: 'invalid-request-target' });
      return;
    }
    const { pathname, params } = parsed;
    counters.requests += 1;

    try {
      if (request.method !== 'GET') {
        const exception = serviceException('OperationNotSupported', 'Only HTTP GET is supported.');
        counters.exceptions += 1;
        sendXml(response, 405, exception.xml, 'application/vnd.ogc.se_xml; charset=utf-8');
        return;
      }

      if (pathname === '/healthz') {
        counters.health += 1;
        sendJson(response, 200, {
          status: 'ok',
          service: options.role,
          instanceId: options.instance,
          configSha256,
          capabilitiesVersion: '1.3.0',
          counters: { ...counters },
          uptimeMs: Date.now() - startedAt,
        });
        return;
      }

      if (pathname !== '/wms') {
        sendJson(response, 404, { error: 'not-found' });
        return;
      }

      const requestParam = param(params, 'request');
      if (requestParam === null || requestParam === '') {
        const exception = serviceException('MissingParameterValue', 'Required parameter REQUEST is missing or empty.');
        counters.exceptions += 1;
        sendXml(response, exception.status, exception.xml, 'application/vnd.ogc.se_xml; charset=utf-8');
        return;
      }

      const operation = requestParam.toLowerCase();
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (operation === 'getcapabilities') {
        counters.capabilities += 1;
        const result = handleCapabilities({ params, origin, config });
        sendXml(response, result.status, result.xml, result.contentType);
        return;
      }
      if (operation === 'getmap') {
        counters.maps += 1;
        const result = handleMap({ params, origin, config });
        response.writeHead(result.status, {
          'content-type': result.contentType,
          'content-length': result.bytes.length,
          'cache-control': 'no-store',
          ...result.headers,
        });
        response.end(result.bytes);
        return;
      }

      throw serviceException('OperationNotSupported', `REQUEST ${requestParam} is not implemented; GetCapabilities and GetMap are offered.`);
    } catch (error) {
      const exception = error && typeof error.code === 'string' && error.xml
        ? error
        : serviceException('NoApplicableCode', 'The request could not be processed by this service.');
      counters.exceptions += 1;
      if (pathname === '/wms') {
        sendXml(response, exception.status ?? 500, exception.xml, 'application/vnd.ogc.se_xml; charset=utf-8');
      } else if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { error: 'request-failed' });
      }
    }
  });

  server.on('clientError', (error, socket) => socket.destroy());
  const port = await listen(server, options.avoidPort);
  installShutdown(server);
  announceReady({
    role: options.role,
    instance: options.instance,
    url: `http://127.0.0.1:${port}`,
    configSha256,
  });
}

main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'startup-failed';
  const message = typeof error?.message === 'string'
    ? error.message.replaceAll('\n', ' ').slice(0, 500)
    : 'worker failed to start';
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
});
