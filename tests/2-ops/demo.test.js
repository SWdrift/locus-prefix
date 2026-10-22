/**
 * 实验 2：操作发现、组合与调用边界
 *
 * 运行：`pnpm test` 或 `node --test tests/2-ops/demo.test.js`
 * 结论与证据：`documents/conclusions/1-core.md`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperations } from '../../src/operations.js';

function setup(run = async (input, ctx) => ctx.dependencies.executor(input)) {
  const operations = createOperations();
  operations.register('inspect', {
    description: 'Read a machine using an injected simulator',
    validate(input) {
      if (typeof input?.machine !== 'string') throw new TypeError('machine required');
    },
    dependencies: ['executor'], permissions: ['read'], effects: ['connect'], run,
  });
  return operations;
}

function context() {
  return {
    dependencies: { executor: async input => `online:${input.machine}` },
    permissions: ['read'], allowedEffects: ['connect'], trace: [],
  };
}

test('discovery and composition preserve child checks and causal traces', async () => {
  const operations = setup();
  operations.register('report', {
    description: 'Inspect and format', validate() {}, dependencies: [], permissions: [], effects: [],
    run: async (input, ctx) => ({ report: await operations.call('inspect', input, ctx) }),
  });
  const discovered = operations.list();
  assert.deepEqual(discovered.map(x => x.name), ['inspect', 'report']);
  discovered[0].permissions.length = 0;
  const ctx = context();
  assert.deepEqual(await operations.call('report', { machine: 'a' }, ctx), { report: 'online:a' });
  assert.deepEqual(ctx.trace.map(x => [x.operation, x.status]), [
    ['report', 'started'], ['inspect', 'started'], ['inspect', 'succeeded'], ['report', 'succeeded'],
  ]);
  assert.equal(ctx.trace[1].parent, ctx.trace[0].id);
  ctx.permissions = [];
  await assert.rejects(operations.call('report', { machine: 'a' }, ctx), /Permission denied/);
  assert.deepEqual(ctx.trace.slice(-2).map(x => x.operation), ['inspect', 'report']);
  assert.ok(ctx.trace.slice(-2).every(x => x.status === 'failed'));
});

test('invalid input, missing dependency, denied permission and effect never execute operation', async () => {
  let executions = 0;
  const operations = setup(async () => { executions++; });
  await assert.rejects(operations.call('inspect', {}, context()), /machine required/);
  const missing = context();
  missing.dependencies = {};
  await assert.rejects(operations.call('inspect', { machine: 'a' }, missing), /Missing dependency/);
  const denied = context();
  denied.permissions = [];
  await assert.rejects(operations.call('inspect', { machine: 'a' }, denied), /Permission denied/);
  const effects = context();
  effects.allowedEffects = [];
  await assert.rejects(operations.call('inspect', { machine: 'a' }, effects), /Effect denied/);
  assert.equal(executions, 0);
});

test('executor failure is preserved and a subsequent corrected dependency succeeds', async () => {
  const operations = setup();
  const ctx = context();
  const failure = new Error('route refused');
  ctx.dependencies.executor = async () => { throw failure; };
  await assert.rejects(operations.call('inspect', { machine: 'a' }, ctx), error => error === failure);
  assert.equal(ctx.trace.at(-1).error, 'route refused');
  ctx.dependencies.executor = async () => 'recovered';
  assert.equal(await operations.call('inspect', { machine: 'a' }, ctx), 'recovered');
  assert.equal(ctx.trace.at(-1).status, 'succeeded');
});

test('unknown operations and duplicate registration are explicit failures', async () => {
  const operations = setup();
  const ctx = context();
  await assert.rejects(operations.call('absent', null, ctx), /Unknown operation/);
  assert.equal(ctx.trace.at(-1).status, 'failed');
  assert.throws(() => operations.register('inspect', {}), /duplicate operation/);
});

test('demo: report composes inspection with pure formatting and checks each child', async () => {
  const operations = createOperations();
  const calls = [];
  operations.register('machine.inspect', {
    description: 'Read a machine through an injected executor',
    validate(input) {
      if (typeof input?.machine !== 'string') throw new TypeError('machine required');
    },
    dependencies: ['executor'], permissions: ['machine:read'], effects: ['simulated-connect'],
    run: async (input, ctx) => ctx.dependencies.executor(input),
  });
  operations.register('report.format', {
    description: 'Format an inspection result without external effects',
    validate(input) {
      if (typeof input?.machine !== 'string') throw new TypeError('machine result required');
    },
    dependencies: [], permissions: [], effects: [],
    run: input => `${input.machine}: online=${input.online}`,
  });
  operations.register('machine.report', {
    description: 'Compose inspection and pure report formatting',
    validate(input) {
      if (typeof input?.machine !== 'string') throw new TypeError('machine required');
    },
    dependencies: [], permissions: [], effects: [],
    async run(input, ctx) {
      const result = await operations.call('machine.inspect', input, ctx);
      return operations.call('report.format', result, ctx);
    },
  });
  const ctx = {
    dependencies: {
      executor: async input => {
        calls.push(input.machine);
        return { machine: input.machine, online: true };
      },
    },
    permissions: ['machine:read'],
    allowedEffects: ['simulated-connect'],
    trace: [],
  };
  assert.equal(operations.list().length, 3);
  assert.equal(await operations.call('machine.report', { machine: 'a' }, ctx), 'a: online=true');
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(ctx.trace.map(x => [x.operation, x.status]), [
    ['machine.report', 'started'], ['machine.inspect', 'started'], ['machine.inspect', 'succeeded'],
    ['report.format', 'started'], ['report.format', 'succeeded'], ['machine.report', 'succeeded'],
  ]);
  const denied = { ...ctx, permissions: [], trace: [] };
  await assert.rejects(operations.call('machine.report', { machine: 'a' }, denied), /Permission denied/);
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(denied.trace.map(x => [x.operation, x.status]), [
    ['machine.report', 'started'], ['machine.inspect', 'started'], ['machine.inspect', 'failed'],
    ['machine.report', 'failed'],
  ]);
});
