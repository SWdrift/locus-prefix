function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Identity ID must be a non-empty string');
  }
}

// Validate while copying, rather than relying on JSON.stringify's silent losses.
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject(value))) {
    throw new Error('Projection must contain only lossless JSON data');
  }
  if (ancestors.has(value)) throw new Error('JSON data must not contain cycles');
  ancestors.add(value);
  try {
    const array = Array.isArray(value);
    const keys = Reflect.ownKeys(value);
    const result = array ? [] : {};
    if (array && keys.length !== value.length + 1) {
      throw new Error('JSON arrays must be dense and have no extra properties');
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('JSON data requires enumerable string-keyed data properties');
      }
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new Error('JSON arrays must have only indexed elements');
      }
      Object.defineProperty(result, key, {
        value: copyJson(descriptor.value, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function createIdentityScope() {
  const objects = new Map();
  const identities = new WeakMap();

  function register(id, object) {
    validateId(id);
    if (typeof object !== 'function' && !isPlainObject(object)) {
      throw new Error('Registered identity must be a plain object or function');
    }
    if (objects.has(id)) throw new Error(`Duplicate identity ID: ${id}`);
    if (identities.has(object)) throw new Error('Object already has an identity in this scope');
    objects.set(id, object);
    identities.set(object, id);
    return object;
  }

  function ref(id) {
    validateId(id);
    if (!objects.has(id)) throw new Error(`Unknown identity ID: ${id}`);
    return { $ref: id };
  }

  function resolve(reference) {
    if (!isPlainObject(reference) || Reflect.ownKeys(reference).length !== 1) {
      throw new Error('Reference must have exactly one $ref property');
    }
    const descriptor = Object.getOwnPropertyDescriptor(reference, '$ref');
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Reference must have a $ref data property');
    }
    const id = descriptor.value;
    validateId(id);
    if (!objects.has(id)) throw new Error(`Unknown identity ID: ${id}`);
    return objects.get(id);
  }

  function snapshot(encode) {
    if (typeof encode !== 'function') throw new Error('Snapshot requires an encode function');
    return Array.from(objects, ([id, object]) => ({ id, value: copyJson(encode(object)) }));
  }

  return { register, ref, resolve, snapshot };
}

export function restoreIdentityScope(entries, decode) {
  if (!Array.isArray(entries)) throw new Error('Restore requires an array of entries');
  if (typeof decode !== 'function') throw new Error('Restore requires a decode function');
  const data = copyJson(entries);
  const scope = createIdentityScope();
  const ids = new Set();
  for (const entry of data) {
    if (!isPlainObject(entry) || Reflect.ownKeys(entry).length !== 2 ||
        !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'value')) {
      throw new Error('Restore entry must have exactly id and value properties');
    }
    validateId(entry.id);
    if (ids.has(entry.id)) throw new Error(`Duplicate identity ID: ${entry.id}`);
    ids.add(entry.id);
  }
  for (const { id, value } of data) scope.register(id, decode(value));
  return scope;
}
