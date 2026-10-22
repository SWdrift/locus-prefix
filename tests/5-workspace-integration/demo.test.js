/**
 * 实验 5：工作区配置读取与真实 pnpm 脚本执行
 *
 * 运行：`node --test tests/5-workspace-integration/demo.test.js`
 * 结论与证据：`documents/conclusions/2-workspace-tasks.md`
 *
 * 本实验使用 repo/temp 下的唯一临时目录运行真实子进程，并在 finally 中清理。
 * 不在测试中执行 `pnpm test`：fixture 里只放独立的 node 脚本，避免递归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceTasks } from '@locus/workspace';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const probeA = "console.log('fixture-ok'); console.log(JSON.stringify(process.argv.slice(2)));\n";
const probeB = "console.log('fixture-second');\n";
const failing = [
  "console.log('fixture-out');",
  "console.error('fixture-error');",
  'process.exitCode = 3;',
  '',
].join('\n');
const sideEffect = "import { writeFileSync } from 'node:fs';\nwriteFileSync('executed.txt', 'executed');\n";

function packageText(scripts) {
  return JSON.stringify({
    name: 'workspace-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts,
  }, null, 2);
}

function taskNamed(tasks, name) {
  const task = tasks.find(candidate => candidate.name === name);
  assert.ok(task, `missing task ${name}`);
  return task;
}

function summarize(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return { message: String(error) };
  }
  const summary = { message: typeof error.message === 'string' ? error.message : String(error) };
  for (const key of Object.keys(error)) {
    if (key !== 'message') summary[key] = error[key];
  }
  return summary;
}

// 本地最小 runner：只验证本包对 context.step 的使用，不测试 @locus/tasks 的转发语义。
function createContext() {
  const steps = [];
  return {
    steps,
    async step(name, action) {
      try {
        const value = await action();
        steps.push({ name, status: 'succeeded', value });
        return value;
      } catch (error) {
        steps.push({ name, status: 'failed', error: summarize(error) });
        throw error;
      }
    },
  };
}

async function runTask(definition, input) {
  const context = createContext();
  try {
    await definition.validate?.(input);
    const value = await definition.run(input, context);
    return { status: 'succeeded', value, steps: context.steps };
  } catch (error) {
    return { status: 'failed', error: summarize(error), steps: context.steps };
  }
}

// 唯一临时目录；无论断言是否失败都在 finally 清理。
async function withFixture(files, run) {
  const parent = path.join(repoRoot, 'temp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'workspace-integration-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(directory, name), content);
    }
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('invalid workspace inputs are rejected before invocation', () => {
  const tasks = createWorkspaceTasks({ root: repoRoot });
  const inspect = taskNamed(tasks, 'workspace.inspect');
  assert.throws(() => inspect.validate([]), TypeError);
  const check = taskNamed(tasks, 'workspace.check');
  for (const invalid of [{}, { script: '' }, { script: 1 }, null, []]) {
    assert.throws(() => check.validate(invalid), TypeError);
  }
  assert.throws(() => createWorkspaceTasks(), TypeError);
  assert.throws(() => createWorkspaceTasks({ root: '   ' }), TypeError);
});

test('inspect reports workspace: null for a fixture without workspace config', async () => {
  await withFixture({
    'package.json': packageText({ ok: 'node probe.js' }),
    'probe.js': probeA,
  }, async directory => {
    const tasks = createWorkspaceTasks({ root: directory });
    const inspect = taskNamed(tasks, 'workspace.inspect');
    const value = await inspect.run({}, createContext());

    assert.equal(value.root, directory);
    assert.equal(value.package.scripts.ok, 'node probe.js');
    // 祖先目录（仓库根）有 pnpm-workspace.yaml，但任务不向上扫描。
    assert.equal(value.workspace, null);
  });
});

test('check executes selected scripts even with spaces or option-like names', async () => {
  await withFixture({
    'package.json': packageText({
      ok: 'node probe.js',
      'ok with space': 'node probe.js',
      '--help': 'node probe.js',
    }),
    'probe.js': probeA,
  }, async directory => {
    const tasks = createWorkspaceTasks({ root: directory });
    const check = taskNamed(tasks, 'workspace.check');
    const context = createContext();
    const report = await check.run({ script: 'ok' }, context);

    assert.deepEqual(context.steps.map(step => [step.name, step.status]), [
      ['inspect', 'succeeded'],
      ['execute', 'succeeded'],
    ]);
    assert.equal(context.steps[0].value.packagePath, path.join(directory, 'package.json'));
    assert.equal(context.steps[0].value.scriptCommand, 'node probe.js');
    assert.equal(context.steps[1].value.exitCode, 0);

    assert.equal(report.exitCode, 0);
    assert.equal(report.signal, null);
    assert.equal(report.script, 'ok');
    assert.equal(report.scriptCommand, 'node probe.js');
    assert.match(report.stdout, /fixture-ok/);
    assert.match(report.stdout, /\[\]/);
    assert.equal(typeof report.stderr, 'string');
    assert.ok(Number.isFinite(report.durationMs));
    assert.ok(Array.isArray(report.command));

    // 脚本名含空格也作为单个 argv 传递，证明没有拼接到 shell 命令里。
    const spaced = await check.run({ script: 'ok with space' }, createContext());
    assert.equal(spaced.exitCode, 0);
    assert.match(spaced.stdout, /fixture-ok/);

    // 以 "-" 开头的脚本名不会被 pnpm 解析成选项。
    const dashed = await check.run({ script: '--help' }, createContext());
    assert.equal(dashed.exitCode, 0);
    assert.match(dashed.stdout, /fixture-ok/);
    assert.match(dashed.stdout, /\[\]/);
  });
});

test('check preserves exitCode, stdout, and stderr when the script fails', async () => {
  await withFixture({
    'package.json': packageText({ fail: 'node fail.js' }),
    'fail.js': failing,
  }, async directory => {
    const tasks = createWorkspaceTasks({ root: directory });
    const result = await runTask(taskNamed(tasks, 'workspace.check'), { script: 'fail' });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.steps.map(step => [step.name, step.status]), [
      ['inspect', 'succeeded'],
      ['execute', 'failed'],
    ]);
    const failed = result.steps[1];
    assert.equal(failed.error.evidence.exitCode, 3);
    assert.equal(failed.error.evidence.script, 'fail');
    assert.match(failed.error.evidence.stdout, /fixture-out/);
    assert.match(failed.error.evidence.stderr, /fixture-error/);
    assert.equal(result.error.evidence.exitCode, 3);
  });
});

test('check rereads package.json on every run and recovers after edits', async () => {
  const original = packageText({ probe: 'node probe-a.js' });
  const changed = packageText({ probe: 'node probe-b.js' });
  await withFixture({
    'package.json': original,
    'probe-a.js': probeA,
    'probe-b.js': probeB,
  }, async directory => {
    const check = taskNamed(createWorkspaceTasks({ root: directory }), 'workspace.check');

    const first = await runTask(check, { script: 'probe' });
    assert.equal(first.status, 'succeeded');
    assert.match(first.value.stdout, /fixture-ok/);

    await writeFile(path.join(directory, 'package.json'), changed);
    const second = await runTask(check, { script: 'probe' });
    assert.equal(second.status, 'succeeded');
    assert.match(second.value.stdout, /fixture-second/);
    assert.equal(second.steps[0].value.scriptCommand, 'node probe-b.js');

    await writeFile(path.join(directory, 'package.json'), original);
    const restored = await runTask(check, { script: 'probe' });
    assert.equal(restored.status, 'succeeded');
    assert.match(restored.value.stdout, /fixture-ok/);
    assert.doesNotMatch(restored.value.stdout, /fixture-second/);
  });
});

test('unknown script names fail before any process starts', async () => {
  await withFixture({
    'package.json': packageText({ ok: 'node side-effect.js' }),
    'side-effect.js': sideEffect,
  }, async directory => {
    const check = taskNamed(createWorkspaceTasks({ root: directory }), 'workspace.check');

    for (const script of ['missing', 'ok; node side-effect.js', 'ok && node side-effect.js', '../ok']) {
      const result = await runTask(check, { script });
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.steps.map(step => step.name), ['inspect']);
      assert.match(result.error.message, /is not defined/);
      assert.deepEqual(result.error.evidence.availableScripts, ['ok']);
    }

    await assert.rejects(
      readFile(path.join(directory, 'executed.txt')),
      error => error.code === 'ENOENT',
    );
  });
});

test('missing package.json fails at inspect with the source path as evidence', async () => {
  await withFixture({}, async directory => {
    const check = taskNamed(createWorkspaceTasks({ root: directory }), 'workspace.check');
    const result = await runTask(check, { script: 'anything' });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.steps.map(step => [step.name, step.status]), [['inspect', 'failed']]);
    assert.equal(result.error.evidence.path, path.join(directory, 'package.json'));
    assert.match(result.error.message, /Cannot read/);
  });
});
