// A trusted-code invocation boundary, not a JavaScript sandbox.
export function createOperations() {
  const entries = new Map();
  const parentCall = Symbol('parentCall');
  let sequence = 0;

  function strings(value, label) {
    if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x)) {
      throw new TypeError(`${label} must be an array of non-empty strings`);
    }
    return [...new Set(value)];
  }

  function register(name, descriptor) {
    if (typeof name !== 'string' || !name || entries.has(name)) {
      throw new Error(`Invalid or duplicate operation: ${name}`);
    }
    if (!descriptor || typeof descriptor.description !== 'string' || !descriptor.description ||
        typeof descriptor.run !== 'function' || typeof descriptor.validate !== 'function') {
      throw new TypeError('Operation requires description, validate and run');
    }
    const metadata = {
      name,
      description: descriptor.description,
      dependencies: strings(descriptor.dependencies, 'dependencies'),
      permissions: strings(descriptor.permissions, 'permissions'),
      effects: strings(descriptor.effects, 'effects'),
    };
    entries.set(name, { metadata, validate: descriptor.validate, run: descriptor.run });
  }

  function list() {
    return [...entries.values()].map(({ metadata }) => ({
      ...metadata,
      dependencies: [...metadata.dependencies],
      permissions: [...metadata.permissions],
      effects: [...metadata.effects],
    }));
  }

  async function call(name, input, context = {}) {
    const trace = context.trace ?? [];
    if (!Array.isArray(trace)) throw new TypeError('trace must be an array');
    const id = ++sequence;
    const event = { id, parent: context[parentCall] ?? null, operation: name };
    trace.push({ ...event, status: 'started' });
    try {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Unknown operation: ${name}`);
      await entry.validate(input); // Validators throw on invalid input; types are not runtime checks.
      const dependencies = context.dependencies ?? {};
      for (const key of entry.metadata.dependencies) {
        if (!Object.hasOwn(dependencies, key) || dependencies[key] === undefined) {
          throw new Error(`Missing dependency: ${key}`);
        }
      }
      const permissions = strings(context.permissions ?? [], 'permissions');
      const allowedEffects = strings(context.allowedEffects ?? [], 'allowedEffects');
      for (const permission of entry.metadata.permissions) {
        if (!permissions.includes(permission)) throw new Error(`Permission denied: ${permission}`);
      }
      for (const effect of entry.metadata.effects) {
        if (!allowedEffects.includes(effect)) throw new Error(`Effect denied: ${effect}`);
      }
      const value = await entry.run(input, {
        ...context, dependencies, permissions, allowedEffects, trace, [parentCall]: id,
      });
      trace.push({ ...event, status: 'succeeded' });
      return value;
    } catch (error) {
      trace.push({ ...event, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  return { register, list, call };
}
