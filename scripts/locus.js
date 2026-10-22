#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createTasks } from '@locus/tasks';

const help = `Locus: trusted engineering tasks from ./locus.tasks.js

pnpm locus list
pnpm locus show <task>
pnpm locus run <task> [--input '<JSON>'] [--grant <permission>] [--allow <effect>]

Output: JSON. Exit codes: 0 success, 1 execution failed, 2 blocked/invalid.
Task modules and local package scripts are trusted code, not sandboxed.
Reading task descriptions imports the module; grants govern invocation only.`;

function printResult(result) {
  let output;
  try {
    output = JSON.stringify(result, null, 2);
  } catch (error) {
    // Reporting failure must not erase the fact that a task already executed.
    process.exitCode = 1;
    output = JSON.stringify({
      task: result.task,
      status: 'failed',
      phase: 'report',
      executionStatus: result.status ?? 'not-started',
      error: { message: `Result cannot be encoded as JSON: ${error.message}` },
    }, null, 2);
  }
  console.log(output);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      input: { type: 'string' },
      grant: { type: 'string', multiple: true, default: [] },
      allow: { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  const [command, name, ...extra] = positionals;
  if (!['list', 'show', 'run'].includes(command) || extra.length ||
      (command === 'list' ? name !== undefined : name === undefined)) {
    throw new Error('Expected list, show <task>, or run <task>; see --help');
  }
  if (command !== 'run' && (values.input !== undefined || values.grant.length || values.allow.length)) {
    throw new Error('--input, --grant and --allow belong to run');
  }
  const root = process.cwd();
  const modulePath = resolve(root, 'locus.tasks.js');
  const { default: defineTasks } = await import(pathToFileURL(modulePath).href);
  if (typeof defineTasks !== 'function') throw new Error('locus.tasks.js must default-export a function ({ root }) => definitions');
  const tasks = createTasks(await defineTasks({ root }));
  let result;
  if (command === 'list') {
    result = tasks.list();
  } else if (command === 'show') {
    result = tasks.show(name);
  } else {
    const input = values.input === undefined ? {} : JSON.parse(values.input);
    result = await tasks.run(name, input, {
      permissions: values.grant,
      allowedEffects: values.allow,
    });
    process.exitCode = result.status === 'succeeded' ? 0 : result.status === 'failed' ? 1 : 2;
  }
  printResult(result);
}

try {
  await main();
} catch (error) {
  console.log(JSON.stringify({ status: 'blocked', error: { message: error.message } }, null, 2));
  process.exitCode = 2;
}
