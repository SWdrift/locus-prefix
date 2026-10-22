import { assessRelease } from '@locus/deployment-audit';

export const inspectContract = Object.freeze({
  summary: '读取网关发布、请求及启动时配置来源',
  input: '无参数',
  effects: '本地HTTP只读',
  limit: '多次请求不是原子快照；不证明远端身份',
});

// Shared domain composition, not a new execution language.
export async function accept(inspect, { expected, artifact }) {
  const observation = await inspect();
  return {
    observation,
    release: assessRelease({ expected, artifact, runtime: observation.runtime }),
    ready: observation.request.status === 200,
  };
}

export function nativeConsumer(connection, release) {
  let current = connection;
  return {
    run: () => accept(current.inspect, release),
    cached: current.inspect,
    replace(next) { current = next; },
    discover: () => ({ inspect: null }),
  };
}

export function describedConsumer(connection, release) {
  const contracts = new WeakMap();
  const exposed = { inspect: connection.inspect };
  const describe = fn => { contracts.set(fn, inspectContract); return fn; };
  describe(exposed.inspect);
  return {
    run: () => accept(exposed.inspect, release),
    cached: exposed.inspect,
    replace(next) { exposed.inspect = describe(next.inspect); },
    // Counterexample: ordinary assignment does not copy function metadata.
    replaceWithoutDescription(next) { exposed.inspect = next.inspect; },
    discover: () => ({ inspect: contracts.get(exposed.inspect) ?? null }),
  };
}

const sameSubject = (a, b) => a.instanceId === b.instanceId && a.connection === b.connection;
const subjectOf = connection => ({ ...connection.subject });

export function requireCurrent(evidence, current) {
  if (evidence.status !== 'succeeded' || !sameSubject(evidence.subject, current)) {
    throw Object.assign(new Error('stale or failed evidence'), { code: 'STALE_EVIDENCE' });
  }
  return evidence.observation;
}

export function witnessedConsumer(connection, release) {
  let current = connection;
  const events = [];
  async function inspect() {
    const selected = current;
    const subject = subjectOf(selected);
    try {
      const observation = await selected.inspect();
      if (!sameSubject(subject, current.subject)) {
        throw Object.assign(new Error('subject changed during observation'), { code: 'SUBJECT_CHANGED' });
      }
      if (observation.instanceId !== subject.instanceId) {
        throw Object.assign(new Error('observed instance differs from subject'), { code: 'INSTANCE_MISMATCH' });
      }
      events.push({ status: 'succeeded', subject, observation });
      return observation;
    } catch (error) {
      events.push({ status: 'failed', subject, error: error.message });
      throw error;
    }
  }
  return {
    run: () => accept(inspect, release),
    cached: inspect,
    replace(next) { current = next; },
    discover: () => ({ inspect: inspectContract }),
    events,
    reuse(evidence) { return requireCurrent(evidence, current.subject); },
  };
}

export function projectedConsumer(connection, release) {
  let current = connection;
  const events = [];
  const view = new Proxy({}, {
    get(_target, key) {
      if (key !== 'inspect') return undefined;
      return async (...args) => {
        const selected = current;
        const subject = subjectOf(selected);
        try {
          const observation = await selected[key](...args);
          events.push({ status: 'succeeded', subject, observation });
          return observation;
        } catch (error) {
          events.push({ status: 'failed', subject, error: error.message });
          throw error;
        }
      };
    },
  });
  return {
    run: () => accept(view.inspect, release),
    cached: view.inspect,
    replace(next) { current = next; },
    // Deliberately no reflection machinery to rescue this candidate.
    discover: () => Object.keys(view),
    events,
  };
}

export function createConsumers(connection, release) {
  return {
    native: nativeConsumer(connection, release),
    described: describedConsumer(connection, release),
    witnessed: witnessedConsumer(connection, release),
    projected: projectedConsumer(connection, release),
  };
}
