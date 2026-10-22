/**
 * @locus/workspace: 面向显式工作区目录的任务定义。
 *
 * 只读取 root 下的 package.json 与 pnpm-workspace.yaml，不向上扫描其他工程。
 * 每次调用都重新读取配置；任务定义本身只固定 root，不缓存配置或执行结果。
 * package script 是本机可信代码，不是沙箱。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const READ_EFFECT = 'filesystem:read';
const EXECUTE_EFFECT = 'process:execute';
const EXECUTE_PERMISSION = 'process:execute';

/**
 * 创建 workspace.inspect / workspace.check 两个任务定义。
 * 返回普通对象数组，可直接交给 @locus/tasks 的 createTasks，也可由调用方自行执行。
 *
 * @param {{root: string}} options root 为显式工作区目录（相对路径按创建时 cwd 解析）
 * @returns {object[]}
 */
export function createWorkspaceTasks({ root } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('createWorkspaceTasks requires an explicit non-empty root directory.');
  }
  const workspaceRoot = path.resolve(root);
  return [createInspectTask(workspaceRoot), createCheckTask(workspaceRoot)];
}

function createInspectTask(root) {
  return {
    name: 'workspace.inspect',
    description: '读取当前 package.json 的 scripts 与 workspace 配置，返回配置来源和内容摘要。',
    input: {
      description: '无输入；任务始终读取创建时指定的 root。',
      example: {},
    },
    permissions: [],
    effects: [READ_EFFECT],
    validate(input) {
      if (input !== undefined && input !== null && !isPlainObject(input)) {
        throw new TypeError('workspace.inspect takes no input; omit it or pass {}.');
      }
    },
    async run() {
      return inspectWorkspace(root);
    },
  };
}

function createCheckTask(root) {
  return {
    name: 'workspace.check',
    description: '重新读取当前 package.json，确认脚本存在后用 pnpm 执行，并返回退出码、stdout、stderr 与真实命令。',
    input: {
      description: 'package.json scripts 中已存在的脚本名（精确匹配，不作为命令片段解释）。',
      example: { script: 'test' },
    },
    permissions: [EXECUTE_PERMISSION],
    effects: [READ_EFFECT, EXECUTE_EFFECT],
    validate(input) {
      if (!isPlainObject(input)) {
        throw new TypeError('workspace.check input must be an object with a script string.');
      }
      if (typeof input.script !== 'string' || input.script.length === 0) {
        throw new TypeError('workspace.check requires a non-empty script string.');
      }
    },
    async run(input, context) {
      if (context === null || typeof context !== 'object' || typeof context.step !== 'function') {
        throw new TypeError('workspace.check requires context.step to record inspect and execute.');
      }
      await context.step('inspect', () => selectScript(root, input.script));
      return context.step('execute', () => executeScript(root, input.script));
    },
  };
}

function inspectWorkspace(root) {
  const { source, data } = readPackageJson(root);
  const scripts = readScripts(data);
  const scriptNames = Object.keys(scripts).sort();
  const name = typeof data.name === 'string' ? data.name : null;
  const version = typeof data.version === 'string' ? data.version : null;
  return {
    root,
    package: {
      source,
      name,
      version,
      packageManager: typeof data.packageManager === 'string' ? data.packageManager : null,
      scripts,
      scriptNames,
      summary: `${name ?? '(unnamed)'}${version === null ? '' : `@${version}`}; ${scriptNames.length} script(s)`,
    },
    workspace: readWorkspaceConfig(root, source, data),
  };
}

function selectScript(root, script) {
  const selected = readSelectedScript(root, script);
  return {
    packagePath: selected.source,
    packageName: selected.packageName,
    script,
    scriptCommand: selected.scriptCommand,
    availableScripts: selected.scriptNames,
  };
}

async function executeScript(root, script) {
  // 执行前重读配置：inspect 与 execute 之间文件可能被修改，不能沿用旧结论。
  const selected = readSelectedScript(root, script);
  const launcher = resolvePnpmLauncher();
  // "--" 终止 pnpm 自身选项解析：以 "-" 开头的脚本名不会被当成 pnpm 选项。
  const args = [...launcher.args, 'run', '--', script];
  const startedAt = Date.now();
  const result = await spawnPnpm(launcher.executable, args, root);
  const evidence = {
    script,
    packagePath: selected.source,
    packageName: selected.packageName,
    scriptCommand: selected.scriptCommand,
    command: [launcher.executable, ...args],
    cwd: root,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
    launcher: launcher.source,
  };

  if (result.spawnError) {
    const detail = result.spawnError.code ? ` (${result.spawnError.code})` : '';
    const error = new Error(`Failed to start pnpm for script "${script}"${detail}: ${result.spawnError.message}`);
    error.evidence = {
      ...evidence,
      spawnError: {
        code: result.spawnError.code ?? null,
        message: result.spawnError.message,
      },
    };
    throw error;
  }
  if (result.exitCode !== 0) {
    const outcome = result.signal === null ? `exited with code ${result.exitCode}` : `was terminated by ${result.signal}`;
    const error = new Error(`Script "${script}" ${outcome}.`);
    error.evidence = evidence;
    throw error;
  }
  return evidence;
}

function readSelectedScript(root, script) {
  const { source, data } = readPackageJson(root);
  const scripts = readScripts(data);
  const scriptNames = Object.keys(scripts).sort();
  return {
    source,
    packageName: typeof data.name === 'string' ? data.name : null,
    scriptNames,
    scriptCommand: findScript({ source, scripts, scriptNames }, script),
  };
}

function findScript(pkg, script) {
  if (!Object.hasOwn(pkg.scripts, script) || typeof pkg.scripts[script] !== 'string') {
    const error = new Error(`Script "${script}" is not defined in ${pkg.source}.`);
    error.evidence = {
      packagePath: pkg.source,
      script,
      availableScripts: pkg.scriptNames,
    };
    throw error;
  }
  return pkg.scripts[script];
}

function readPackageJson(root) {
  const source = path.join(root, 'package.json');
  const text = readText(source);
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    const error = new Error(`Invalid package.json at ${source}: ${cause.message}`);
    error.evidence = { path: source };
    throw error;
  }
  if (!isPlainObject(data)) {
    const error = new Error(`package.json at ${source} must contain a JSON object.`);
    error.evidence = { path: source };
    throw error;
  }
  return { source, data };
}

function readScripts(data) {
  return isPlainObject(data.scripts) ? data.scripts : {};
}

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (cause) {
    const error = new Error(`Cannot read ${filePath}: ${cause.message}`);
    error.evidence = { path: filePath, code: cause.code ?? null };
    throw error;
  }
}

// 只读 root 下的 workspace 配置；不向上寻找祖先工程的 pnpm-workspace.yaml。
function readWorkspaceConfig(root, packageSource, data) {
  const yamlPath = path.join(root, 'pnpm-workspace.yaml');
  if (existsSync(yamlPath)) {
    return {
      source: 'pnpm-workspace.yaml',
      path: yamlPath,
      text: readText(yamlPath),
      summary: 'Raw YAML evidence; workspace membership is not interpreted.',
    };
  }
  const workspaces = data.workspaces;
  const patterns = Array.isArray(workspaces)
    ? workspaces.filter(item => typeof item === 'string')
    : isPlainObject(workspaces) && Array.isArray(workspaces.packages)
      ? workspaces.packages.filter(item => typeof item === 'string')
      : null;
  if (patterns === null) return null;
  return {
    source: 'package.json#workspaces',
    path: packageSource,
    packages: patterns,
    summary: `packages: ${patterns.length === 0 ? '(none)' : patterns.join(', ')}`,
  };
}

/**
 * 解析不经过 shell 的 pnpm 启动方式。
 * 顺序：当前 pnpm 执行上下文 → Node 安装目录旁的 pnpm CLI → PNPM_HOME/Path 中的 pnpm.exe。
 * 绝不把脚本名拼进 shell 命令；脚本名只作为独立的 argv 元素传给 pnpm。
 */
function resolvePnpmLauncher() {
  const execPath = typeof process.env.npm_execpath === 'string'
    ? path.resolve(process.env.npm_execpath)
    : null;
  if (execPath !== null && isFile(execPath)
    && /^pnpm(\.|$)/i.test(path.basename(execPath))
    && /\.(cjs|mjs|js)$/i.test(execPath)) {
    return { executable: process.execPath, args: [execPath], source: 'npm_execpath' };
  }

  const binDir = path.join(path.dirname(process.execPath), 'node_modules', 'pnpm', 'bin');
  for (const name of ['pnpm.cjs', 'pnpm.mjs']) {
    const candidate = path.join(binDir, name);
    if (isFile(candidate)) {
      return { executable: process.execPath, args: [candidate], source: 'node_install' };
    }
  }

  const pnpmHome = process.env.PNPM_HOME;
  if (typeof pnpmHome === 'string' && pnpmHome.length > 0) {
    const candidate = path.join(pnpmHome, 'pnpm.exe');
    if (isFile(candidate)) return { executable: candidate, args: [], source: 'pnpm_home' };
  }

  if (process.platform === 'win32') {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (directory.length === 0) continue;
      const candidate = path.join(directory.replace(/^"(.*)"$/, '$1'), 'pnpm.exe');
      if (isFile(candidate)) return { executable: candidate, args: [], source: 'path' };
    }
    const error = new Error(
      'Cannot locate a pnpm launcher without a shell. '
      + 'Run inside a pnpm process (npm_execpath), or install pnpm so pnpm.exe is available.',
    );
    error.evidence = {
      platform: process.platform,
      npmExecpath: process.env.npm_execpath ?? null,
      pnpmHome: pnpmHome ?? null,
    };
    throw error;
  }

  return { executable: 'pnpm', args: [], source: 'path' };
}

function spawnPnpm(executable, args, cwd) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', spawnError: error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({
      exitCode: null,
      signal: null,
      stdout,
      stderr,
      spawnError: error,
    }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, stdout, stderr }));
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
