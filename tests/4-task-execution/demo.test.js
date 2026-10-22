/**
 * 实验 4：任务目录、授权边界与单次执行
 *
 * 运行：`node --test tests/4-task-execution/demo.test.js`
 * 通过 @locus/tasks 的公开入口验证消费者可见行为。
 * 结论：[工程任务闭环](../../documents/conclusions/2-workspace-tasks.md)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTasks } from '@locus/tasks';

function echoDefinitions() {
  return [{
    name: 'demo.echo',
    description: 'Echo the given text.',
    input: { description: 'Text to echo.', example: { text: 'hi' } },
    permissions: [],
    effects: [],
    validate(input) {
      if (typeof input?.text !== 'string') throw new TypeError('text must be a string');
    },
    async run(input, context) {
      return context.step('echo', async () => input.text);
    },
  }];
}

test('list and show return isolated metadata copies without executable functions', () => {
  const definitions = echoDefinitions();
  const tasks = createTasks(definitions);

  definitions[0].description = 'mutated outside the registry';
  definitions[0].input.example.text = 'mutated outside the registry';

  const listed = tasks.list();
  assert.deepEqual(listed.map(item => item.name), ['demo.echo']);
  assert.equal(listed[0].description, 'Echo the given text.');
  assert.equal(listed[0].validate, undefined);
  assert.equal(listed[0].run, undefined);

  listed[0].description = 'mutated copy';
  listed[0].input.description = 'mutated copy';
  listed[0].input.example.text = 'mutated copy';
  listed[0].permissions.push('filesystem:read');
  listed[0].effects.push('filesystem:write');

  const shown = tasks.show('demo.echo');
  assert.equal(shown.name, 'demo.echo');
  assert.equal(shown.description, 'Echo the given text.');
  assert.deepEqual(shown.input, { description: 'Text to echo.', example: { text: 'hi' } });
  assert.deepEqual(shown.permissions, []);
  assert.deepEqual(shown.effects, []);

  shown.input.example.text = 'changed again';
  assert.deepEqual(tasks.show('demo.echo').input.example, { text: 'hi' });
  assert.notEqual(tasks.show('demo.echo').input, tasks.show('demo.echo').input);
  assert.throws(() => tasks.show('demo.missing'), /Unknown task/);
});

test('native mutable values in examples do not leak registry state', () => {
  const definitions = echoDefinitions();
  definitions[0].input.example.at = new Date('2026-01-01T00:00:00Z');
  const tasks = createTasks(definitions);
  definitions[0].input.example.at.setUTCFullYear(2001);
  tasks.show('demo.echo').input.example.at.setUTCFullYear(2000);
  assert.equal(tasks.show('demo.echo').input.example.at.getUTCFullYear(), 2026);
});

test('ordinary function composition succeeds and records each step', async () => {
  const double = value => value * 2;
  const increment = value => value + 1;
  const validateNumber = input => {
    if (typeof input?.value !== 'number') throw new TypeError('value must be a number');
  };

  const tasks = createTasks([
    {
      name: 'math.double',
      description: 'Double a number.',
      input: { description: 'Number.', example: { value: 3 } },
      permissions: [],
      effects: [],
      validate: validateNumber,
      async run(input, context) {
        return context.step('double', async () => double(input.value));
      },
    },
    {
      name: 'math.double-plus-one',
      description: 'Double a number, then increment it.',
      input: { description: 'Number.', example: { value: 3 } },
      permissions: [],
      effects: [],
      validate: validateNumber,
      async run(input, context) {
        const doubled = await context.step('double', async () => double(input.value));
        return context.step('increment', async () => increment(doubled));
      },
    },
  ]);

  const single = await tasks.run('math.double', { value: 3 }, { permissions: [], allowedEffects: [] });
  assert.equal(single.status, 'succeeded');
  assert.equal(single.value, 6);
  assert.deepEqual(single.steps, [{ name: 'double', status: 'succeeded', value: 6 }]);

  const composed = await tasks.run('math.double-plus-one', { value: 3 }, { permissions: [], allowedEffects: [] });
  assert.equal(composed.status, 'succeeded');
  assert.equal(composed.value, 7);
  assert.deepEqual(composed.steps, [
    { name: 'double', status: 'succeeded', value: 6 },
    { name: 'increment', status: 'succeeded', value: 7 },
  ]);
});

test('unknown tasks and invalid input are blocked before run', async () => {
  let runCalls = 0;
  const tasks = createTasks([{
    name: 'demo.strict',
    description: 'Require a numeric value.',
    input: { description: 'Number.', example: { value: 1 } },
    permissions: [],
    effects: [],
    async validate(input) {
      await Promise.resolve();
      if (typeof input?.value !== 'number') throw new TypeError('value must be a number');
    },
    async run() {
      runCalls += 1;
      return 'executed';
    },
  }]);

  const unknown = await tasks.run('demo.missing', {});
  assert.equal(unknown.status, 'blocked');
  assert.equal(unknown.task, 'demo.missing');
  assert.match(unknown.error.message, /Unknown task/);
  assert.deepEqual(unknown.steps, []);

  const invalid = await tasks.run('demo.strict', { value: 'nope' });
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.error.message, 'value must be a number');
  assert.deepEqual(invalid.steps, []);

  assert.equal(runCalls, 0);
});

test('missing permission or effect blocks before run', async () => {
  let runCalls = 0;
  const tasks = createTasks([{
    name: 'demo.risky',
    description: 'Pretend to execute a process.',
    input: { description: 'No parameters.', example: {} },
    permissions: ['process:execute'],
    effects: ['filesystem:read', 'process:execute'],
    validate() {},
    async run(input, context) {
      runCalls += 1;
      return context.step('execute', async () => 'done');
    },
  }]);

  const noGrants = await tasks.run('demo.risky', {});
  assert.equal(noGrants.status, 'blocked');
  assert.match(noGrants.error.message, /Missing permission "process:execute"/);

  const permissionOnly = await tasks.run('demo.risky', {}, {
    permissions: ['process:execute'],
    allowedEffects: ['filesystem:read'],
  });
  assert.equal(permissionOnly.status, 'blocked');
  assert.match(permissionOnly.error.message, /Missing effect "process:execute"/);

  assert.equal(runCalls, 0);

  const allowed = await tasks.run('demo.risky', {}, {
    permissions: ['process:execute'],
    allowedEffects: ['filesystem:read', 'process:execute'],
  });
  assert.equal(allowed.status, 'succeeded');
  assert.equal(allowed.value, 'done');
  assert.equal(runCalls, 1);
});

test('failed steps keep earlier successes and child-process evidence', async () => {
  let laterStepRan = false;
  const tasks = createTasks([{
    name: 'demo.execute',
    description: 'Fail after a successful preparation step.',
    input: { description: 'No parameters.', example: {} },
    permissions: [],
    effects: [],
    validate() {},
    async run(input, context) {
      await context.step('prepare', async () => ({ prepared: true }));
      await context.step('execute', async () => {
        const child = spawnSync(
          process.execPath,
          ['-e', "process.stdout.write('partial-output'); process.stderr.write('boom-detail'); process.exit(7)"],
          { encoding: 'utf8' },
        );
        const error = new Error(`child exited with ${child.status}`);
        error.evidence = {
          exitCode: child.status,
          stdout: child.stdout,
          stderr: child.stderr,
        };
        throw error;
      });
      await context.step('after', async () => {
        laterStepRan = true;
        return 'unreachable';
      });
      return 'unreachable';
    },
  }]);

  const result = await tasks.run('demo.execute', {});
  assert.equal(result.status, 'failed');
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps[0], { name: 'prepare', status: 'succeeded', value: { prepared: true } });
  assert.equal(result.steps[1].name, 'execute');
  assert.equal(result.steps[1].status, 'failed');
  assert.equal(result.steps[1].error.message, 'child exited with 7');
  assert.equal(result.steps[1].error.evidence.exitCode, 7);
  assert.equal(result.steps[1].error.evidence.stdout, 'partial-output');
  assert.match(result.steps[1].error.evidence.stderr, /boom-detail/);

  assert.equal(result.error.message, 'child exited with 7');
  assert.equal(result.error.evidence.exitCode, 7);
  assert.equal(result.error.evidence.stdout, 'partial-output');
  assert.equal(result.error.evidence.stderr, result.steps[1].error.evidence.stderr);
  assert.equal(laterStepRan, false);
});

test('errors thrown by the task body keep completed steps', async () => {
  const tasks = createTasks([{
    name: 'demo.report',
    description: 'Fail after collecting a value.',
    input: { description: 'No parameters.', example: {} },
    permissions: [],
    effects: [],
    validate() {},
    async run(input, context) {
      await context.step('collect', async () => [1, 2]);
      throw new Error('report failed');
    },
  }]);

  const result = await tasks.run('demo.report', {});
  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, 'report failed');
  assert.deepEqual(result.steps, [{ name: 'collect', status: 'succeeded', value: [1, 2] }]);
  assert.equal(result.value, undefined);
});

test('a corrected rerun succeeds without implicit retries', async () => {
  let shouldFail = true;
  let attempts = 0;
  const tasks = createTasks([{
    name: 'demo.flaky',
    description: 'Fail until the external condition is fixed.',
    input: { description: 'No parameters.', example: {} },
    permissions: [],
    effects: [],
    validate() {},
    async run(input, context) {
      attempts += 1;
      return context.step('attempt', async () => {
        if (shouldFail) throw new Error('not ready');
        return 'fixed';
      });
    },
  }]);

  const first = await tasks.run('demo.flaky', {});
  assert.equal(first.status, 'failed');
  assert.equal(first.steps[0].error.message, 'not ready');
  assert.equal(attempts, 1);

  shouldFail = false;
  const second = await tasks.run('demo.flaky', {});
  assert.equal(second.status, 'succeeded');
  assert.equal(second.value, 'fixed');
  assert.deepEqual(second.steps, [{ name: 'attempt', status: 'succeeded', value: 'fixed' }]);
  assert.equal(attempts, 2);

  assert.equal(first.status, 'failed');
  assert.equal(first.steps[0].status, 'failed');
});

test('createTasks rejects malformed metadata', () => {
  assert.throws(() => createTasks('not-an-array'), TypeError);
  assert.throws(() => createTasks([{ name: 'incomplete' }]), TypeError);
  assert.throws(() => createTasks([
    {
      name: 'demo.bad-permissions',
      description: 'Bad permissions.',
      input: { description: 'None.', example: {} },
      permissions: [''],
      effects: [],
      run() {},
    },
  ]), TypeError);
  assert.throws(() => createTasks([
    {
      name: 'demo.duplicate',
      description: 'First.',
      input: { description: 'None.', example: {} },
      permissions: [],
      effects: [],
      run() {},
    },
    {
      name: 'demo.duplicate',
      description: 'Second.',
      input: { description: 'None.', example: {} },
      permissions: [],
      effects: [],
      run() {},
    },
  ]), TypeError);
});
