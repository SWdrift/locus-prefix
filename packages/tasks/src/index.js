/**
 * @locus/tasks: 可信代码的任务目录与单次执行。
 *
 * 任务定义是普通对象；权限与 effects 是调用方与任务之间的声明式契约，
 * 不是沙箱，也不能约束任务内部的副作用。
 */

const noop = () => {};

/**
 * @typedef {object} TaskDefinition
 * @property {string} name
 * @property {string} description
 * @property {{description: string, example?: unknown}} input
 * @property {string[]} permissions
 * @property {string[]} effects
 * @property {(input: unknown) => unknown | Promise<unknown>} [validate] 抛错式校验
 * @property {(input: unknown, context: object) => unknown | Promise<unknown>} run
 */

/**
 * 创建任务目录。定义在创建时复制，后续修改传入数组/对象不影响目录行为。
 *
 * @param {TaskDefinition[]} definitions
 * @returns {{list: () => object[], show: (name: string) => object, run: (name: string, input?: unknown, context?: object) => Promise<object>}}
 */
export function createTasks(definitions) {
  if (!Array.isArray(definitions)) {
    throw new TypeError('definitions must be an array of task descriptions.');
  }

  const ordered = [];
  const byName = new Map();
  definitions.forEach((raw, index) => {
    const definition = normalizeDefinition(raw, index);
    if (byName.has(definition.name)) {
      throw new TypeError(`Duplicate task name "${definition.name}".`);
    }
    byName.set(definition.name, definition);
    ordered.push(definition);
  });

  function list() {
    return ordered.map(toDescription);
  }

  function show(name) {
    const definition = byName.get(name);
    if (!definition) throw new Error(`Unknown task "${String(name)}".`);
    return toDescription(definition);
  }

  async function run(name, input, context = {}) {
    const definition = byName.get(name);
    if (!definition) {
      return blocked(name, new Error(`Unknown task "${String(name)}".`));
    }

    const permissions = Array.isArray(context?.permissions) ? context.permissions : [];
    const allowedEffects = Array.isArray(context?.allowedEffects) ? context.allowedEffects : [];
    const denial = missingGrant(definition, permissions, allowedEffects);
    if (denial) return blocked(name, denial);

    try {
      await (definition.validate ?? noop)(input);
    } catch (error) {
      return blocked(name, error);
    }

    const steps = [];
    const step = async (stepName, action) => {
      if (typeof stepName !== 'string' || stepName.length === 0) {
        throw new TypeError('step name must be a non-empty string.');
      }
      if (typeof action !== 'function') {
        throw new TypeError(`step "${stepName}" requires a function.`);
      }
      try {
        const value = await action();
        steps.push({ name: stepName, status: 'succeeded', value });
        return value;
      } catch (error) {
        steps.push({ name: stepName, status: 'failed', error: summarizeError(error) });
        throw error;
      }
    };

    try {
      const value = await definition.run(input, { permissions, allowedEffects, step });
      return { task: name, status: 'succeeded', value, steps };
    } catch (error) {
      return { task: name, status: 'failed', error: summarizeError(error), steps };
    }
  }

  return { list, show, run };
}

function normalizeDefinition(raw, index) {
  const fail = reason => {
    throw new TypeError(`Invalid task definition at index ${index}: ${reason}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected an object.');
  }

  const { name, description, input, permissions = [], effects = [], validate, run } = raw;
  if (typeof name !== 'string' || name.length === 0) {
    fail('name must be a non-empty string.');
  }
  if (typeof description !== 'string') {
    fail(`task "${name}" requires a string description.`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(`task "${name}" requires an input description object.`);
  }
  if (typeof input.description !== 'string') {
    fail(`task "${name}" requires input.description.`);
  }
  if (!isNonEmptyStringArray(permissions)) {
    fail(`task "${name}" requires permissions as an array of non-empty strings.`);
  }
  if (!isNonEmptyStringArray(effects)) {
    fail(`task "${name}" requires effects as an array of non-empty strings.`);
  }
  if (validate !== undefined && typeof validate !== 'function') {
    fail(`task "${name}" validate must be a function.`);
  }
  if (typeof run !== 'function') {
    fail(`task "${name}" requires a run function.`);
  }

  return {
    name,
    description,
    input: structuredClone(input),
    permissions: [...permissions],
    effects: [...effects],
    validate,
    run,
  };
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function toDescription(definition) {
  return {
    name: definition.name,
    description: definition.description,
    input: structuredClone(definition.input),
    permissions: [...definition.permissions],
    effects: [...definition.effects],
  };
}

function missingGrant(definition, permissions, allowedEffects) {
  for (const permission of definition.permissions) {
    if (!permissions.includes(permission)) {
      return new Error(`Missing permission "${permission}" for task "${definition.name}".`);
    }
  }
  for (const effect of definition.effects) {
    if (!allowedEffects.includes(effect)) {
      return new Error(`Missing effect "${effect}" for task "${definition.name}".`);
    }
  }
  return null;
}

function blocked(task, error) {
  return { task, status: 'blocked', error: summarizeError(error), steps: [] };
}

/**
 * 将抛出的值转成结果中的普通错误摘要，并保留 evidence 等自有可枚举属性。
 */
function summarizeError(error) {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    const summary = {
      message: typeof error.message === 'string' ? error.message : String(error),
    };
    for (const key of Object.keys(error)) {
      if (key !== 'message') summary[key] = error[key];
    }
    return summary;
  }
  return { message: String(error) };
}

