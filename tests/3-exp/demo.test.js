/**
 * 实验 3：经验改变选择，而非只写日志
 *
 * 运行：`pnpm test` 或 `node --test tests/3-exp/demo.test.js`
 * 结论与证据：`documents/conclusions/1-core.md`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityScope } from '../../src/identity.js';
import { createOperations } from '../../src/operations.js';
import { jsonRoundtrip } from '../lib/json.js';
import { makeJump, makeMachine } from '../lib/machine.js';

const DEFAULT_TTL_MS = 60_000;

function matchesConditions(conditions, machine) {
  return conditions?.machineId === machine.id
    && conditions.connectionRevision === machine.connectionRevision
    && Array.isArray(conditions.routes)
    && conditions.routes.length === machine.routes.length
    && conditions.routes.every((route, index) => route === machine.routes[index]);
}

function findConnectionAdvice(machine, experiences, now) {
  for (let index = experiences.length - 1; index >= 0; index -= 1) {
    const experience = experiences[index];
    if (experience?.source !== 'simulated-execution'
      || !matchesConditions(experience.conditions, machine)
      || experience.revokedAt !== null
      || !Number.isFinite(experience.createdAt)
      || experience.createdAt > now
      || !Number.isFinite(experience.expiresAt)
      || experience.expiresAt <= now
      || experience.advice?.kind !== 'inference'
      || !machine.routes.includes(experience.advice.route)
      || !Array.isArray(experience.evidence)) {
      continue;
    }
    const hasSuccess = experience.evidence.some(evidence =>
      evidence?.kind === 'execution'
      && evidence.outcome === 'success'
      && evidence.route === experience.advice.route
      && Number.isFinite(evidence.at)
      && evidence.at >= experience.createdAt
      && evidence.at <= now);
    if (hasSuccess) return experience;
  }
  return undefined;
}

// This is a local simulated-connection policy, not a general knowledge store.
export async function inspectWithExperience({
  machine, experiences, executor, now, ttlMs = DEFAULT_TTL_MS,
}) {
  if (!machine || typeof machine.id !== 'string' || machine.id.length === 0
    || !(typeof machine.connectionRevision === 'string'
      || Number.isFinite(machine.connectionRevision))
    || !Array.isArray(machine.routes) || machine.routes.length === 0
    || !machine.routes.every(route => typeof route === 'string' && route.length > 0)) {
    throw new Error('A machine needs an ID, connection revision, and nonempty routes');
  }
  if (!Array.isArray(experiences) || typeof executor !== 'function') {
    throw new Error('Experiences must be an array and executor must be a function');
  }
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0
    || !Number.isFinite(now + ttlMs) || now + ttlMs <= now) {
    throw new Error('now must be finite and ttlMs must produce a positive finite lifetime');
  }

  const previous = findConnectionAdvice(machine, experiences, now);
  const record = {
    conditions: {
      machineId: machine.id,
      connectionRevision: machine.connectionRevision,
      routes: [...machine.routes],
    },
    source: 'simulated-execution',
    createdAt: now,
    expiresAt: now + ttlMs,
    revokedAt: null,
    evidence: [],
    advice: null,
  };
  experiences.push(record);
  const routes = [...new Set(previous
    ? [previous.advice.route, ...machine.routes]
    : machine.routes)];

  for (const route of routes) {
    let value;
    try {
      value = await executor({ machine, route });
    } catch (error) {
      // A failed attempt is a fact about this execution, not a permanent ban.
      record.evidence.push({
        kind: 'execution', outcome: 'failure', route, at: now,
        error: typeof error?.message === 'string' ? error.message : String(error),
      });
      if (previous && route === previous.advice.route) previous.revokedAt = now;
      continue;
    }
    record.evidence.push({ kind: 'execution', outcome: 'success', route, at: now });
    // Success supports a revisable suggestion; it does not guarantee future success.
    record.advice = { kind: 'inference', route };
    return { value, route, usedExperience: previous !== undefined && route === previous.advice.route };
  }

  throw new Error(`No connection route succeeded for machine ${machine.id}`);
}

async function learn(machine = makeMachine()) {
  const experiences = [];
  const calls = [];
  const result = await inspectWithExperience({
    machine, experiences, now: 1_000, ttlMs: 100,
    executor: async ({ machine: target, route }) => {
      assert.equal(target, machine);
      calls.push(route);
      if (route === 'direct') throw new Error('Direct connection refused');
      return { name: 'demo' };
    },
  });
  return { machine, experiences, calls, result };
}

test('explores in order, records evidence, then reuses the successful route', async () => {
  const { machine, experiences, calls, result } = await learn();
  assert.deepEqual(calls, ['direct', 'via-jump']);
  assert.deepEqual(result, { value: { name: 'demo' }, route: 'via-jump', usedExperience: false });
  assert.deepEqual(experiences[0], {
    conditions: { machineId: 'machine:a', connectionRevision: 1, routes: ['direct', 'via-jump'] },
    source: 'simulated-execution', createdAt: 1_000, expiresAt: 1_100, revokedAt: null,
    evidence: [
      { kind: 'execution', outcome: 'failure', route: 'direct', at: 1_000, error: 'Direct connection refused' },
      { kind: 'execution', outcome: 'success', route: 'via-jump', at: 1_000 },
    ],
    advice: { kind: 'inference', route: 'via-jump' },
  });
  calls.length = 0;
  const second = await inspectWithExperience({
    machine, experiences, now: 1_001,
    executor: async ({ route }) => { calls.push(route); return 'connected'; },
  });
  assert.deepEqual(calls, ['via-jump']);
  assert.deepEqual(second, { value: 'connected', route: 'via-jump', usedExperience: true });
});

for (const [name, change] of [
  ['expiration boundary', state => { state.now = 1_100; }],
  ['machine identity', state => { state.machine.id = 'machine:b'; }],
  ['connection revision', state => { state.machine.connectionRevision = 2; }],
  ['route addition', state => { state.machine.routes.push('another'); }],
  ['route removal', state => { state.machine.routes = ['direct']; }],
  ['route order', state => { state.machine.routes = ['another', 'via-jump', 'direct']; }],
]) {
  test(`does not reuse advice after ${name}`, async () => {
    const state = { ...await learn(), now: 1_001 };
    change(state);
    const calls = [];
    const result = await inspectWithExperience({
      machine: state.machine, experiences: state.experiences, now: state.now,
      executor: async ({ route }) => { calls.push(route); return 'ok'; },
    });
    assert.deepEqual(calls, [state.machine.routes[0]]);
    assert.equal(result.usedExperience, false);
    assert.deepEqual(state.experiences[0].conditions.routes, ['direct', 'via-jump']);
  });
}

test('ordered route configuration must match even when both configurations contain the same routes', async () => {
  const machine = makeMachine();
  machine.routes.push('alternate');
  const { experiences } = await learn(machine);
  machine.routes = ['direct', 'alternate', 'via-jump'];
  const calls = [];
  const result = await inspectWithExperience({
    machine, experiences, now: 1_001,
    executor: async ({ route }) => { calls.push(route); return 'ok'; },
  });
  assert.deepEqual(calls, ['direct']);
  assert.equal(result.usedExperience, false);
});

for (const [name, invalidate] of [
  ['missing success evidence', record => { record.evidence = record.evidence.slice(0, 1); }],
  ['unverified success claim', record => { record.evidence[1].kind = 'hypothesis'; }],
  ['success for another route', record => { record.evidence[1].route = 'direct'; }],
  ['unknown source', record => { record.source = 'unverified'; }],
  ['revocation', record => { record.revokedAt = 1_000; }],
]) {
  test(`ignores ${name}`, async () => {
    const { machine, experiences } = await learn();
    invalidate(experiences[0]);
    experiences.push(null, { advice: { route: 'via-jump' } });
    const calls = [];
    const result = await inspectWithExperience({
      machine, experiences, now: 1_001,
      executor: async ({ route }) => { calls.push(route); return 'ok'; },
    });
    assert.deepEqual(calls, ['direct']);
    assert.equal(result.usedExperience, false);
  });
}

test('failed recommendation is immediately revoked and falls back without duplicate attempts', async () => {
  const machine = makeMachine();
  machine.routes.push('direct', 'via-jump');
  const { experiences } = await learn(machine);
  const old = experiences[0];
  const calls = [];
  const result = await inspectWithExperience({
    machine, experiences, now: 1_001,
    executor: async ({ route }) => {
      calls.push(route);
      if (route === 'via-jump') throw new Error('Jump is down');
      assert.equal(old.revokedAt, 1_001);
      return 'direct now works';
    },
  });
  assert.deepEqual(calls, ['via-jump', 'direct']);
  assert.deepEqual(result, { value: 'direct now works', route: 'direct', usedExperience: false });
  assert.equal(old.revokedAt, 1_001);
  assert.deepEqual(experiences[1].evidence.map(e => [e.route, e.outcome]), [
    ['via-jump', 'failure'], ['direct', 'success'],
  ]);
  const thirdCalls = [];
  await inspectWithExperience({
    machine, experiences, now: 1_002,
    executor: async ({ route }) => { thirdCalls.push(route); return 'ok'; },
  });
  assert.deepEqual(thirdCalls, ['direct']);
});

test('all failures are retained, throw, and do not create a permanent route rule', async () => {
  const machine = makeMachine();
  machine.routes.push('direct');
  const experiences = [];
  const calls = [];
  await assert.rejects(inspectWithExperience({
    machine, experiences, now: 5,
    executor: async ({ route }) => { calls.push(route); throw new Error(`${route} failed`); },
  }), /No connection route succeeded/);
  assert.deepEqual(calls, ['direct', 'via-jump']);
  assert.deepEqual(experiences[0].evidence, [
    { kind: 'execution', outcome: 'failure', route: 'direct', at: 5, error: 'direct failed' },
    { kind: 'execution', outcome: 'failure', route: 'via-jump', at: 5, error: 'via-jump failed' },
  ]);
  assert.equal(experiences[0].advice, null);
  calls.length = 0;
  const result = await inspectWithExperience({
    machine, experiences, now: 6,
    executor: async ({ route }) => { calls.push(route); return 'recovered'; },
  });
  assert.deepEqual(calls, ['direct']);
  assert.equal(result.usedExperience, false);
});

test('all failures after a recommendation retain evidence and revoke the recommendation', async () => {
  const { machine, experiences } = await learn();
  const calls = [];
  await assert.rejects(inspectWithExperience({
    machine, experiences, now: 1_001,
    executor: async ({ route }) => { calls.push(route); throw new Error('unavailable'); },
  }), /No connection route succeeded/);
  assert.deepEqual(calls, ['via-jump', 'direct']);
  assert.equal(experiences[0].revokedAt, 1_001);
  assert.equal(experiences[1].evidence.length, 2);
  assert.ok(experiences[1].evidence.every(e => e.outcome === 'failure' && e.error === 'unavailable'));
});

test('JSON-restored experience can guide execution', async () => {
  const learned = await learn();
  const { machine, experiences } = jsonRoundtrip(learned);
  const calls = [];
  const result = await inspectWithExperience({
    machine, experiences, now: 1_001,
    executor: async ({ route }) => { calls.push(route); return null; },
  });
  assert.deepEqual(calls, ['via-jump']);
  assert.deepEqual(result, { value: null, route: 'via-jump', usedExperience: true });
});

test('expired failure evidence does not prevent a recovered direct route', async () => {
  const { machine, experiences } = await learn();
  const calls = [];
  const result = await inspectWithExperience({
    machine, experiences, now: 1_100,
    executor: async ({ route }) => { calls.push(route); return 'recovered'; },
  });
  assert.deepEqual(calls, ['direct']);
  assert.equal(result.usedExperience, false);
});

test('rejects empty routes and invalid lifetimes without claiming execution success', async () => {
  for (const overrides of [
    { machine: { ...makeMachine(), routes: [] } },
    ...[0, -1, Infinity, NaN].map(ttlMs => ({ ttlMs })),
  ]) {
    const experiences = [];
    await assert.rejects(inspectWithExperience({
      machine: makeMachine(), experiences, now: 1_000,
      executor: async () => assert.fail('invalid input must not execute'),
      ...overrides,
    }));
    assert.deepEqual(experiences, []);
  }
});

test('demo: identity, operations and experience compose through JSON restore and expiry', async () => {
  const scope = createIdentityScope();
  scope.register('machine:a', makeMachine({ address: 'corrected-address' }));
  scope.register('machine:b', makeJump());
  const connection = {
    kind: 'simulated',
    target: scope.ref('machine:a'),
    via: scope.ref('machine:b'),
  };
  const operations = createOperations();
  const experiences = [];
  const attempts = [];
  let directWorks = false;
  const executor = async ({ machine, route }) => {
    attempts.push(route);
    if (route === 'direct' && !directWorks) throw new Error(`No direct path to ${machine.address}`);
    if (route === 'via-jump') assert.equal(scope.resolve(connection.via).address, 'jump-address');
    return { address: machine.address };
  };
  operations.register('machine.inspect', {
    description: 'Read a machine through a simulated connection, reusing conditional evidence',
    validate(input) {
      if (!input || typeof input.target?.$ref !== 'string') throw new TypeError('target reference required');
    },
    dependencies: ['scope', 'executor', 'experiences', 'now'],
    permissions: ['machine:read'], effects: ['simulated-connect', 'experience-write'],
    run: (input, ctx) => inspectWithExperience({
      machine: ctx.dependencies.scope.resolve(input.target),
      executor: ctx.dependencies.executor,
      experiences: ctx.dependencies.experiences,
      now: ctx.dependencies.now,
    }),
  });
  operations.register('report.format', {
    description: 'Format a connection result without external effects',
    validate(input) {
      if (typeof input?.route !== 'string') throw new TypeError('route required');
    },
    dependencies: [], permissions: [], effects: [],
    run: input => `reachable via ${input.route}: ${input.value.address}`,
  });
  operations.register('machine.report', {
    description: 'Compose machine inspection and pure report formatting',
    validate(input) {
      if (!input || typeof input.target?.$ref !== 'string') throw new TypeError('target reference required');
    },
    dependencies: [], permissions: [], effects: [],
    async run(input, ctx) {
      const result = await operations.call('machine.inspect', input, ctx);
      return operations.call('report.format', result, ctx);
    },
  });
  const context = {
    dependencies: { scope, executor, experiences, now: 1_000 },
    permissions: ['machine:read'],
    allowedEffects: ['simulated-connect', 'experience-write'],
    trace: [],
  };
  assert.equal(operations.list().length, 3);
  assert.equal(
    await operations.call('machine.report', connection, context),
    'reachable via via-jump: corrected-address',
  );
  assert.deepEqual(attempts, ['direct', 'via-jump']);

  attempts.length = 0;
  context.dependencies.experiences = jsonRoundtrip(experiences);
  assert.equal(
    await operations.call('machine.report', connection, context),
    'reachable via via-jump: corrected-address',
  );
  assert.deepEqual(attempts, ['via-jump']);

  attempts.length = 0;
  context.dependencies.now += DEFAULT_TTL_MS + 1;
  directWorks = true;
  assert.equal(
    await operations.call('machine.report', connection, context),
    'reachable via direct: corrected-address',
  );
  assert.deepEqual(attempts, ['direct']);

  const denied = { ...context, permissions: [], trace: [] };
  await assert.rejects(operations.call('machine.report', connection, denied), /Permission denied/);
  assert.deepEqual(attempts, ['direct']);
  assert.equal(denied.trace.at(-1).status, 'failed');
});
