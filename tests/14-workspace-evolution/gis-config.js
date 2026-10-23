/**
 * Configuration contract for the bounded local WMS 1.3.0 stand-in.
 *
 * The contract is intentionally strict: unknown keys, additional CRS values,
 * or additional formats are rejected instead of silently ignored, so a config
 * edit cannot make the fixture claim protocol support it does not implement.
 */

const CONFIG_KEYS = new Set(['title', 'layers', 'bounds', 'crs', 'formats', 'maxWidth', 'maxHeight']);
const LAYER_KEYS = new Set(['name', 'title', 'seed']);
const BOUND_KEYS = new Set(['west', 'south', 'east', 'north']);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_IMAGE_DIMENSION = 1024;

export function defaultGisConfig() {
  return {
    title: 'Locus local WMS stand-in',
    layers: [
      { name: 'terrain', title: 'Synthetic terrain gradient', seed: 17 },
      { name: 'population', title: 'Synthetic population gradient', seed: 41 },
    ],
    bounds: { west: 116.0, south: 39.5, east: 116.8, north: 40.3 },
    crs: ['EPSG:4326'],
    formats: ['image/png'],
    maxWidth: 1024,
    maxHeight: 1024,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(errors, message) {
  errors.push(message);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate without normalising or filling defaults. Returns nothing; throws a
 * `config-invalid` error listing every violation found in one pass.
 */
export function assertValidGisConfig(value) {
  const errors = [];
  if (!isRecord(value)) {
    throw Object.assign(new Error('GIS config must be a JSON object'), { code: 'config-invalid' });
  }

  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) fail(errors, `unknown config key "${key}"`);
  }

  if (typeof value.title !== 'string' || value.title.trim().length === 0 || value.title.length > 200) {
    fail(errors, 'title must be a non-empty string of at most 200 characters');
  }

  if (!Array.isArray(value.crs) || value.crs.length !== 1 || value.crs[0] !== 'EPSG:4326') {
    fail(errors, 'crs must be exactly ["EPSG:4326"]; no other CRS is implemented');
  }

  if (!Array.isArray(value.formats) || value.formats.length !== 1 || value.formats[0] !== 'image/png') {
    fail(errors, 'formats must be exactly ["image/png"]; no other image format is implemented');
  }

  if (!Number.isInteger(value.maxWidth) || value.maxWidth < 1 || value.maxWidth > MAX_IMAGE_DIMENSION) {
    fail(errors, `maxWidth must be an integer from 1 to ${MAX_IMAGE_DIMENSION}`);
  }
  if (!Number.isInteger(value.maxHeight) || value.maxHeight < 1 || value.maxHeight > MAX_IMAGE_DIMENSION) {
    fail(errors, `maxHeight must be an integer from 1 to ${MAX_IMAGE_DIMENSION}`);
  }

  const bounds = value.bounds;
  if (!isRecord(bounds)) {
    fail(errors, 'bounds must be an object with west, south, east, north');
  } else {
    for (const key of Object.keys(bounds)) {
      if (!BOUND_KEYS.has(key)) fail(errors, `unknown bounds key "${key}"`);
    }
    if (!finiteNumber(bounds.west) || !finiteNumber(bounds.east) ||
        !finiteNumber(bounds.south) || !finiteNumber(bounds.north)) {
      fail(errors, 'bounds west, south, east, north must be finite numbers');
    } else {
      if (bounds.west < -180 || bounds.east > 180) {
        fail(errors, 'bounds longitudes must stay within [-180, 180]');
      }
      if (bounds.south < -90 || bounds.north > 90) {
        fail(errors, 'bounds latitudes must stay within [-90, 90]');
      }
      if (!(bounds.west < bounds.east)) {
        fail(errors, 'bounds west must be less than east (antimeridian crossings are not supported)');
      }
      if (!(bounds.south < bounds.north)) {
        fail(errors, 'bounds south must be less than north');
      }
    }
  }

  if (!Array.isArray(value.layers) || value.layers.length < 1 || value.layers.length > 8) {
    fail(errors, 'layers must be an array with 1 to 8 entries');
  } else {
    const seen = new Set();
    value.layers.forEach((layer, index) => {
      const label = `layers[${index}]`;
      if (!isRecord(layer)) {
        fail(errors, `${label} must be an object`);
        return;
      }
      for (const key of Object.keys(layer)) {
        if (!LAYER_KEYS.has(key)) fail(errors, `${label} has unknown key "${key}"`);
      }
      if (typeof layer.name !== 'string' || !NAME_PATTERN.test(layer.name)) {
        fail(errors, `${label}.name must be a short identifier`);
      } else if (seen.has(layer.name)) {
        fail(errors, `${label}.name "${layer.name}" is duplicated`);
      } else {
        seen.add(layer.name);
      }
      if (typeof layer.title !== 'string' || layer.title.trim().length === 0 || layer.title.length > 200) {
        fail(errors, `${label}.title must be a non-empty string of at most 200 characters`);
      }
      if (!Number.isInteger(layer.seed) || layer.seed < 0 || layer.seed > 255) {
        fail(errors, `${label}.seed must be an integer from 0 to 255`);
      }
    });
  }

  if (errors.length > 0) {
    throw Object.assign(new Error(`GIS config is invalid: ${errors.join('; ')}`), {
      code: 'config-invalid',
      details: errors,
    });
  }
}


