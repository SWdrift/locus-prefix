import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SNAPSHOT = 'documents/evidence/snapshot';
const FILES = [
  'knowledge/runbook.before.md',
  'knowledge/runbook.md',
  'evidence/incident.json',
  'evidence/repair.json',
];

// Publish only anonymous knowledge/evidence, not the lab's runtime directories.
export async function publishKnowledge({ directory, workspaceRoot }) {
  const source = join(directory, 'knowledge-repository');
  const target = join(directory, 'knowledge-checkout');
  await mkdir(source);
  await copyFile(join(workspaceRoot, '.gitattributes'), join(source, '.gitattributes'));
  for (const file of FILES) {
    const destination = join(source, SNAPSHOT, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(directory, file), destination);
  }
  const git = async (cwd, args) => {
    const { stdout } = await execute('git', [
      '-c', 'core.hooksPath=.git/disabled-hooks',
      '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Example',
      '-c', 'user.email=author@example.invalid',
      ...args,
    ], { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
    return stdout.trim();
  };
  await git(source, ['init', '--quiet', '--initial-branch=main']);
  await git(source, ['add', '-f', '--', '.gitattributes', SNAPSHOT]);
  await git(source, ['commit', '--quiet', '--no-gpg-sign', '-m', 'docs: retain a verified operational correction']);
  const revision = await git(source, ['rev-parse', 'HEAD']);
  await git(directory, ['-c', 'core.autocrlf=true', 'clone', '--quiet', '--no-hardlinks', source, target]);
  const evidenceRoot = join(target, SNAPSHOT);
  for (const file of FILES) {
    const before = await readFile(join(directory, file));
    const after = await readFile(join(evidenceRoot, file));
    if (!before.equals(after)) throw new Error(`Knowledge checkout changed evidence bytes: ${file}`);
  }
  return {
    revision,
    evidenceRoot,
    file: join(evidenceRoot, 'knowledge/runbook.md'),
    byteIdentical: true,
    checkoutMode: 'core.autocrlf=true',
  };
}
