import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Case A: explicit modules + existing package scripts, not a plugin framework.
// See documents/conclusions/2-workspace-tasks.md.
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'scripts/locus.js');
const grants = ['--allow', 'filesystem:read', '--allow', 'process:execute', '--grant', 'process:execute'];

function invoke(cwd, args) {
  const child = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null, child.stderr);
  return { exitCode: child.status, output: JSON.parse(child.stdout) };
}

async function fixture(t) {
  await mkdir(join(root, 'temp'), { recursive: true });
  const dir = await mkdtemp(join(root, 'temp', 'cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'cli-local-experiment', private: true, type: 'module', scripts: { check: 'node check.js' },
  }));
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n");
  await writeFile(join(dir, '.npmrc'), [
    `store-dir=${join(root, '.pnpm-store').replaceAll('\\', '/')}`,
    `cache-dir=${join(root, '.pnpm-cache').replaceAll('\\', '/')}`,
    `state-dir=${join(root, '.pnpm-state').replaceAll('\\', '/')}`,
    'update-notifier=false',
  ].join('\n'));
  await writeFile(join(dir, 'locus.tasks.js'), `
    import { createWorkspaceTasks } from '@locus/workspace';
    export default ({ root }) => createWorkspaceTasks({ root });
  `);
  return dir;
}

test('CLI discovers runnable input and blocks ungranted invocation', () => {
  const listed = invoke(root, ['list']);
  assert.equal(listed.exitCode, 0);
  assert.ok(listed.output.some(x => x.name === 'workspace.check'));
  const shown = invoke(root, ['show', 'workspace.check']);
  assert.equal(shown.exitCode, 0);
  assert.equal(typeof shown.output.input.example.script, 'string');
  assert.ok(shown.output.permissions.includes('process:execute'));
  const denied = invoke(root, ['run', 'workspace.check', '--input', '{"script":"check:baseline"}']);
  assert.equal(denied.exitCode, 2);
  assert.equal(denied.output.status, 'blocked');
  assert.deepEqual(denied.output.steps, []);
});

test('CLI preserves partial results and process evidence, then observes the repaired script', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'check.js'), "console.error('diagnostic: broken check'); process.exitCode = 7;\n");
  const args = ['run', 'workspace.check', '--input', '{"script":"check"}', ...grants];
  const failed = invoke(dir, args);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.output.status, 'failed');
  assert.equal(failed.output.steps[0].status, 'succeeded');
  const execution = failed.output.steps.find(x => x.status === 'failed');
  assert.equal(execution.error.evidence.exitCode, 7);
  assert.match(execution.error.evidence.stderr, /diagnostic: broken check/);
  // No retry/resume guarantee: this is a fresh invocation after an explicit repair.
  await writeFile(join(dir, 'check.js'), "console.log('diagnostic: repaired check');\n");
  const recovered = invoke(dir, args);
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.output.status, 'succeeded');
  const completed = recovered.output.steps.find(x => x.name === 'execute');
  assert.match(JSON.stringify(completed.value), /diagnostic: repaired check/);
});

test('adding a plain module task needs no change to the CLI or package internals', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'locus.tasks.js'), `
    const format = input => 'report:' + input.subject;
    export default () => [{
      name: 'local.report', description: 'Format a local report',
      input: { description: 'A subject string', example: { subject: 'workspace' } },
      permissions: [], effects: [],
      validate(input) { if (typeof input?.subject !== 'string') throw new Error('subject required'); },
      run: input => format(input),
    }];
  `);
  const result = invoke(dir, ['run', 'local.report', '--input', '{"subject":"workspace"}']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.value, 'report:workspace');
});

test('malformed JSON is a blocked request, not an execution failure', () => {
  const result = invoke(root, ['run', 'workspace.inspect', '--input', '{']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.status, 'blocked');
});

test('unserializable output does not misreport completed side effects as blocked', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'locus.tasks.js'), `
    import { writeFileSync } from 'node:fs';
    export default () => [{
      name: 'local.write', description: 'Write a marker and return a native JS value',
      input: { description: 'none', example: {} },
      permissions: [], effects: ['filesystem:write'],
      run() { writeFileSync('completed.txt', 'done'); return 1n; },
    }];
  `);
  const result = invoke(dir, ['run', 'local.write', '--allow', 'filesystem:write']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.phase, 'report');
  assert.equal(result.output.executionStatus, 'succeeded');
  assert.equal(await readFile(join(dir, 'completed.txt'), 'utf8'), 'done');
});
