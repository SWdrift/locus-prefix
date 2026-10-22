import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 读取一个 Git 工作树的源码现场：当前 HEAD 提交与工作树是否干净。
 *
 * 只读：`rev-parse` 与 `status` 不修改索引或工作树；`--no-optional-locks`
 * 避免为可选刷新争用 index.lock。`dirty` 以 `status --porcelain` 是否有
 * 输出为准，未跟踪文件也计入。返回值全部来自实际 git 调用，不从期望值复制。
 *
 * @param {string} root Git 工作树内的路径
 * @returns {Promise<{revision: string, dirty: boolean}>}
 */
export async function readGitSource(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('root must be a non-empty path');
  }

  const revision = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (revision.length === 0) {
    throw new Error('git rev-parse HEAD returned an empty revision');
  }

  const status = await git(root, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);

  return { revision, dirty: status.trim().length > 0 };
}

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15000,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error.message;
    throw new Error(`git ${args.join(' ')} failed in the given worktree: ${detail}`, {
      cause: error,
    });
  }
}
