/**
 * Live acceptance session for stages zero through five.
 *
 * Runs the same unified sequence as runWorkspaceEvolution, keeps the
 * workspaces' processes alive, writes the minimal public inputs to
 * session-receipt.json, and prints READY. An independent consumer can then
 * inspect the real services. SIGTERM, SIGINT, or an "exit"/"quit" line on
 * stdin closes everything.
 *
 * The receipt contains only the current delivery address/instance, the live
 * GIS address/instance, the expected release, and the workspace directory.
 * No lab object, registry, or internal closure is exposed.
 */
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openWorkspaceEvolution, publicSessionInputs, writeClosedReceipt,
} from './scenario.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.startsWith('--')) {
    throw new Error(`${name} requires a path value`);
  }
  return value;
}

function summarizeError(error) {
  const summary = {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : String(error),
  };
  if (typeof error?.code === 'string') summary.code = error.code;
  return summary;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const directoryFlag = readFlag(process.argv.slice(2), '--directory');
let root;
if (directoryFlag) {
  root = resolve(directoryFlag);
} else {
  await mkdir(join(ROOT, 'temp'), { recursive: true });
  root = await mkdtemp(join(ROOT, 'temp', 'workspace-evolution-live-'));
}
const receiptFile = join(root, 'session-receipt.json');

let handle = null;
let stopping = false;
const hold = new Promise(() => {});

async function shutdown(reason) {
  let resources = null;
  try {
    resources = await handle.close();
    try {
      await handle.finalize(resources);
    } catch (error) {
      resources = { ...resources, evidenceError: summarizeError(error) };
    }
  } catch (error) {
    resources = { closed: false, errors: [summarizeError(error)] };
  }

  try {
    await writeClosedReceipt(receiptFile, handle.result, resources, reason);
  } catch {
    // The process still stops even if the receipt cannot be updated.
  }

  process.exit(resources && resources.closed === false ? 1 : 0);
}

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  // A signal during startup is handled after openWorkspaceEvolution returns,
  // so its child processes are closed instead of being orphaned by an exit.
  if (!handle) return;
  await shutdown(reason);
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
if (process.stdin && typeof process.stdin.on === 'function') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    const commands = chunk.split(/\r?\n/).map(line => line.trim().toLowerCase());
    if (commands.includes('exit') || commands.includes('quit')) stop('stdin-exit');
  });
}

try {
  handle = await openWorkspaceEvolution({ directory: root });
  if (stopping) {
    await shutdown('startup-signal');
  } else {
    await writeJson(receiptFile, publicSessionInputs(handle.result, 'running'));
    process.stdout.write(`READY ${receiptFile}\n`);
    await hold;
  }
} catch (error) {
  if (handle) {
    try {
      await handle.close();
    } catch (closeError) {
      error.closeError = summarizeError(closeError);
    }
  }
  try {
    let receiptExists = true;
    try {
      await access(receiptFile);
    } catch {
      receiptExists = false;
    }
    const directoryRejected = new Set([
      'WORKSPACE_DIRECTORY_NOT_EMPTY',
      'WORKSPACE_DIRECTORY_NOT_DIRECTORY',
      'WORKSPACE_DIRECTORY_OUTSIDE_REPO',
      'WORKSPACE_DIRECTORY_IS_REPO_ROOT',
    ]).has(error.code);
    if (!receiptExists && !directoryRejected) {
      await writeJson(receiptFile, {
        schemaVersion: 1,
        status: 'failed',
        directory: root,
        error: summarizeError(error),
        ...(error.resources ? { resources: error.resources } : {}),
        ...(error.acceptanceFile ? { acceptanceFile: error.acceptanceFile } : {}),
      });
    }
  } catch {
    // Report the original failure on stderr even without a receipt.
  }
  process.stderr.write(`${JSON.stringify(summarizeError(error))}\n`);
  process.exit(1);
}
