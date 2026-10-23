/**
 * Two native WMS consumer operations plus a raw request probe.
 *
 * The client speaks the same HTTP/XML protocol a real WMS client would use:
 * GetCapabilities returns and parses the service document, GetMap requests an
 * image and decodes the returned PNG. It does not rewrite bbox axis order,
 * inject authentication, retry, or translate ServiceException XML into a
 * private error model.
 */
import { createHash } from 'node:crypto';
import { decodePng, pixelAt } from './png-codec.js';

const HTTP_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBase(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('baseUrl must be a non-empty absolute http(s) URL');
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('baseUrl must use http or https');
  }
  return baseUrl.replace(/\/+$/, '');
}

function buildUrl(baseUrl, params) {
  const url = new URL(`${normalizeBase(baseUrl)}/wms`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function decodeEntities(text) {
  return String(text)
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function tagText(block, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!match) return null;
  return decodeEntities(match[1].replace(/<[^>]*>/g, '')).trim();
}

function allTagText(block, tag) {
  const values = [];
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match;
  while ((match = regex.exec(block)) !== null) {
    values.push(decodeEntities(match[1].replace(/<[^>]*>/g, '')).trim());
  }
  return values;
}

function section(block, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? match[1] : '';
}

function parseBoundingBox(block) {
  const geographic = section(block, 'EX_GeographicBoundingBox');
  if (!geographic) return null;
  const west = Number(tagText(geographic, 'westBoundLongitude'));
  const east = Number(tagText(geographic, 'eastBoundLongitude'));
  const south = Number(tagText(geographic, 'southBoundLatitude'));
  const north = Number(tagText(geographic, 'northBoundLatitude'));
  if (![west, east, south, north].every(Number.isFinite)) return null;
  return { west, east, south, north };
}

/**
 * Parse the bounded subset this fixture emits, while still rejecting a
 * document that is not WMS capabilities at all.
 */
export function parseCapabilities(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new TypeError('capabilities XML must be a non-empty string');
  }
  const root = /<WMS_Capabilities\b([^>]*)>/i.exec(xml) ?? /<WMT_MS_Capabilities\b([^>]*)>/i.exec(xml);
  if (!root) {
    throw Object.assign(new Error('response is not a WMS capabilities document'), {
      code: 'not-capabilities',
    });
  }
  const versionMatch = /\bversion\s*=\s*"([^"]*)"/i.exec(root[1]);
  const service = section(xml, 'Service');
  const requestSection = section(section(xml, 'Capability'), 'Request');
  const getCapabilities = section(requestSection, 'GetCapabilities');
  const getMap = section(requestSection, 'GetMap');

  const layers = [];
  const layerRegex = /<Layer\b([^>]*)>\s*<Name>([\s\S]*?)<\/Name>([\s\S]*?)<\/Layer>/gi;
  let match;
  while ((match = layerRegex.exec(xml)) !== null) {
    const body = match[3];
    const styles = [];
    const styleRegex = /<Style\b[^>]*>\s*<Name>([\s\S]*?)<\/Name>/gi;
    let styleMatch;
    while ((styleMatch = styleRegex.exec(body)) !== null) {
      styles.push(decodeEntities(styleMatch[1].replace(/<[^>]*>/g, '')).trim());
    }
    layers.push({
      name: decodeEntities(match[2].replace(/<[^>]*>/g, '')).trim(),
      title: tagText(body, 'Title'),
      crs: allTagText(body, 'CRS'),
      geographicBounds: parseBoundingBox(body),
      styles,
    });
  }

  return {
    version: versionMatch ? versionMatch[1] : null,
    serviceName: tagText(service, 'Name'),
    serviceTitle: tagText(service, 'Title'),
    operations: {
      getCapabilities: { formats: allTagText(getCapabilities, 'Format') },
      getMap: { formats: allTagText(getMap, 'Format') },
    },
    layers,
  };
}

export function parseServiceException(xml) {
  if (typeof xml !== 'string') return null;
  const match = /<ServiceException\b([^>]*)>([\s\S]*?)<\/ServiceException>/i.exec(xml);
  if (!match) return null;
  const codeMatch = /\bcode\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1]);
  return {
    code: codeMatch ? decodeEntities(codeMatch[1] ?? codeMatch[2]) : null,
    message: decodeEntities(match[2].replace(/<[^>]*>/g, '')).trim(),
    xml,
  };
}

/**
 * Raw WMS GET. No parameter inference and no retry: callers see the actual
 * status, content type, bytes, headers, and ServiceException if present.
 */
async function readBoundedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return { bytes: Buffer.alloc(0), complete: true, tooLarge: false };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(chunks, total), complete: true, tooLarge: false };
      const chunk = Buffer.from(value);
      if (total + chunk.length > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded failure is already known.
        }
        return { bytes: Buffer.concat(chunks, total), complete: false, tooLarge: true };
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reading is already finished or cancelled.
    }
  }
}

export async function requestWms(baseUrl, params = {}) {
  if (!isRecord(params)) throw new TypeError('WMS parameters must be a plain object');
  const requestUrl = buildUrl(baseUrl, params);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { accept: 'text/xml, application/xml, image/png;q=0.9, */*;q=0.1' },
    });
  } catch (error) {
    return {
      requestUrl,
      status: null,
      contentType: null,
      headers: {},
      bytes: null,
      byteLength: 0,
      sha256: null,
      complete: false,
      tooLarge: false,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: { kind: 'network', message: error instanceof Error ? error.message : String(error) },
      exception: null,
    };
  }

  const headers = {};
  for (const [key, value] of response.headers) headers[key.toLowerCase()] = value;
  const contentType = headers['content-type'] ?? null;

  let read;
  try {
    read = await readBoundedBody(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    return {
      requestUrl,
      status: response.status,
      contentType,
      headers,
      bytes: null,
      byteLength: 0,
      sha256: null,
      complete: false,
      tooLarge: false,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: { kind: 'response-read-failed', message: error instanceof Error ? error.message : String(error) },
      exception: null,
    };
  }

  const bytes = read.bytes;
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8');
  const exception = /<ServiceException\b/i.test(head) ? parseServiceException(head) : null;
  const error = read.tooLarge
    ? { kind: 'response-too-large', message: `response exceeded ${MAX_RESPONSE_BYTES} bytes` }
    : null;

  return {
    requestUrl,
    status: response.status,
    contentType,
    headers,
    bytes,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    complete: read.complete,
    tooLarge: read.tooLarge,
    elapsedMs: Date.now() - startedAt,
    ok: response.status >= 200 && response.status < 300 && exception === null && error === null,
    error,
    exception,
  };
}

function samplePoints(width, height) {
  return [
    { name: 'top-left', x: 0, y: 0 },
    { name: 'top-right', x: width - 1, y: 0 },
    { name: 'bottom-left', x: 0, y: height - 1 },
    { name: 'bottom-right', x: width - 1, y: height - 1 },
    { name: 'center', x: Math.floor(width / 2), y: Math.floor(height / 2) },
  ];
}

export function sampleImage(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new TypeError('image must be a decoded PNG');
  }
  return samplePoints(image.width, image.height).map(point => ({
    ...point,
    rgb: pixelAt(image, point.x, point.y),
  }));
}

/**
 * Native GetCapabilities consumer. Returns the protocol observations and a
 * parsed view; it does not assert that the document is complete or valid
 * beyond the bounded parser.
 */
export async function getCapabilities(baseUrl) {
  const raw = await requestWms(baseUrl, {
    service: 'WMS',
    request: 'GetCapabilities',
    version: '1.3.0',
  });
  if (!raw.ok) {
    return { ...raw, ok: false, xml: raw.bytes ? raw.bytes.toString('utf8') : null, capabilities: null };
  }
  const xml = raw.bytes.toString('utf8');
  try {
    return { ...raw, ok: true, xml, capabilities: parseCapabilities(xml) };
  } catch (error) {
    return {
      ...raw,
      ok: false,
      xml,
      capabilities: null,
      error: { kind: error.code ?? 'capabilities-parse-failed', message: error.message },
    };
  }
}

/**
 * Native GetMap consumer.
 *
 * bbox follows the WMS 1.3.0 EPSG:4326 axis order [minLat, minLon, maxLat,
 * maxLon]. The client does not infer or swap it. Protocol failures are
 * returned as observations (ok:false + ServiceException XML) so callers can
 * retain the failure instead of losing it in an exception.
 */
export async function getMap(baseUrl, options = {}) {
  if (!isRecord(options)) throw new TypeError('getMap options must be a plain object');
  const layers = Array.isArray(options.layers) ? options.layers.join(',') : options.layers;
  if (typeof layers !== 'string' || layers.trim().length === 0) {
    throw new TypeError('getMap requires a layer name');
  }
  if (!Array.isArray(options.bbox) || options.bbox.length !== 4 || !options.bbox.every(Number.isFinite)) {
    throw new TypeError('getMap bbox must be four finite numbers in [minLat, minLon, maxLat, maxLon] order');
  }
  const width = options.width ?? 256;
  const height = options.height ?? 256;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new TypeError('getMap width and height must be positive integers');
  }

  const raw = await requestWms(baseUrl, {
    service: 'WMS',
    request: 'GetMap',
    version: options.version ?? '1.3.0',
    layers: layers.trim(),
    styles: options.styles ?? '',
    crs: options.crs ?? 'EPSG:4326',
    bbox: options.bbox.join(','),
    width,
    height,
    format: options.format ?? 'image/png',
  });

  const axisOrder = 'lat,lon';
  if (!raw.ok || raw.bytes === null) {
    return {
      ...raw,
      ok: false,
      axisOrder,
      image: null,
      xml: raw.bytes ? raw.bytes.toString('utf8') : null,
    };
  }
  if (!(raw.contentType ?? '').toLowerCase().includes('image/png')) {
    return {
      ...raw,
      ok: false,
      axisOrder,
      image: null,
      problem: `expected image/png, received ${raw.contentType ?? 'no content type'}`,
    };
  }

  let decoded;
  try {
    decoded = decodePng(raw.bytes);
  } catch (error) {
    return {
      ...raw,
      ok: false,
      axisOrder,
      image: null,
      error: { kind: error.code ?? 'png-decode-failed', message: error.message },
    };
  }

  const dimensionMatches = decoded.width === width && decoded.height === height;
  const headerAxisOrder = raw.headers['x-wms-bbox-order'] ?? null;

  return {
    ...raw,
    ok: raw.error === null && dimensionMatches,
    axisOrder,
    headerAxisOrder,
    image: {
      width: decoded.width,
      height: decoded.height,
      channels: 3,
      dimensionMatches,
      samples: sampleImage(decoded),
    },
    problem: dimensionMatches
      ? raw.error
      : `server image dimensions ${decoded.width}x${decoded.height} do not match requested ${width}x${height}`,
  };
}
