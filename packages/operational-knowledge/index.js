/**
 * @locus/operational-knowledge
 *
 * 把一条被证据绑定的操作发现追加到单个 Markdown 文档，并在读取时重新验证
 * 适用条件和证据字节。存储格式是供人阅读的章节加上一个可解析的 fenced
 * JSON 记录；这里不做知识图、自动推理或语义真值认证。
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const OPEN_FENCE = '```operational-finding';
const CLOSE_FENCE = '```';
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const FINDING_KEYS = new Set([
  'id',
  'originalClaim',
  'correction',
  'steps',
  'conditions',
  'evidence',
  'expiresAt',
  'recordedAt',
]);
const APPEND_KEYS = new Set([...FINDING_KEYS].filter(key => key !== 'recordedAt'));
const CONDITION_KEYS = new Set(['artifactSha256', 'configModel']);
const EVIDENCE_KEYS = new Set(['path', 'sha256']);
const CONTEXT_KEYS = new Set(['artifactSha256', 'configModel']);

/**
 * 向 file 追加一条发现。所有输入和证据都先验证；任何失败都不会写文件。
 * 成功时通过同目录临时文件 + rename 替换，返回实际写入的记录。
 */
export async function appendFinding(options = {}) {
  const { file, evidenceRoot, finding, now } = options;
  const filePath = requirePath(file, 'file');
  const evidenceRootPath = requirePath(evidenceRoot, 'evidenceRoot');
  const recordedAt = readTimestamp(now);
  const normalized = normalizeFinding(finding);
  const root = await resolveEvidenceRoot(evidenceRootPath);
  await verifyEvidence(root, normalized.evidence);
  const record = { ...normalized, recordedAt };

  let existing = Buffer.alloc(0);
  try {
    existing = await readFile(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const section = renderRecord(record, { documentPath: filePath, evidenceRoot: evidenceRootPath });
  const separator = separation(existing.toString('utf8'));
  const next = Buffer.concat([existing, Buffer.from(separator + section, 'utf8')]);
  await replaceAtomically(filePath, next);
  return structuredClone(record);
}

/**
 * 读取 file 中的记录，只返回条件精确匹配、未过期且证据仍能通过校验的记录。
 * 格式错误、缺少条件、字段不受支持或证据失效的记录整条跳过。
 * file 不存在时返回空数组；evidenceRoot 不可用时抛出错误，因为它无法验证任何记录。
 */
export async function findApplicableFindings(options = {}) {
  const { file, evidenceRoot, context, now } = options;
  const filePath = requirePath(file, 'file');
  const expected = normalizeContext(context);
  const checkedAt = readTimestamp(now);
  const root = await resolveEvidenceRoot(evidenceRoot);

  let markdown;
  try {
    markdown = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const findings = [];
  for (const candidate of parseRecordBlocks(markdown)) {
    let record;
    try {
      record = normalizeFinding(candidate, { allowRecordedAt: true });
    } catch {
      continue;
    }
    if (record.conditions.artifactSha256 !== expected.artifactSha256) continue;
    if (record.conditions.configModel !== expected.configModel) continue;
    if (record.expiresAt !== undefined && checkedAt >= record.expiresAt) continue;
    try {
      await verifyEvidence(root, record.evidence);
    } catch {
      continue;
    }
    findings.push(record);
  }
  return findings;
}

function normalizeFinding(value, { allowRecordedAt = false } = {}) {
  assertObject(value, 'finding');
  assertKnownKeys(value, allowRecordedAt ? FINDING_KEYS : APPEND_KEYS, 'finding');

  const record = {
    id: requireSingleLine(value.id, 'finding.id'),
    originalClaim: requireText(value.originalClaim, 'finding.originalClaim'),
    correction: requireText(value.correction, 'finding.correction'),
    steps: normalizeSteps(value.steps),
    conditions: normalizeConditions(value.conditions),
    evidence: normalizeEvidence(value.evidence),
  };
  if (value.expiresAt !== undefined) {
    record.expiresAt = requireFiniteNumber(value.expiresAt, 'finding.expiresAt');
  }
  if (allowRecordedAt && value.recordedAt !== undefined) {
    record.recordedAt = requireFiniteNumber(value.recordedAt, 'finding.recordedAt');
  }
  return record;
}

function normalizeSteps(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('finding.steps must be a non-empty array');
  }
  return value.map((step, index) => requireText(step, `finding.steps[${index}]`));
}

function normalizeConditions(value) {
  assertObject(value, 'finding.conditions');
  assertKnownKeys(value, CONDITION_KEYS, 'finding.conditions');
  return {
    artifactSha256: requireHash(value.artifactSha256, 'finding.conditions.artifactSha256'),
    configModel: requireSingleLine(value.configModel, 'finding.conditions.configModel'),
  };
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('finding.evidence must be a non-empty array');
  }
  return value.map((entry, index) => {
    const label = `finding.evidence[${index}]`;
    assertObject(entry, label);
    assertKnownKeys(entry, EVIDENCE_KEYS, label);
    const relativePath = requireSingleLine(entry.path, `${label}.path`);
    if (relativePath.trim() === '') throw new TypeError(`${label}.path must not be blank`);
    return {
      path: relativePath,
      sha256: requireHash(entry.sha256, `${label}.sha256`),
    };
  });
}

function normalizeContext(context) {
  assertObject(context, 'context');
  assertKnownKeys(context, CONTEXT_KEYS, 'context');
  return {
    artifactSha256: requireHash(context.artifactSha256, 'context.artifactSha256'),
    configModel: requireSingleLine(context.configModel, 'context.configModel'),
  };
}

async function resolveEvidenceRoot(evidenceRoot) {
  const rootPath = requirePath(evidenceRoot, 'evidenceRoot');
  let resolved;
  try {
    resolved = await realpath(rootPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw evidenceError('EVIDENCE_ROOT_MISSING', `evidenceRoot does not exist: ${rootPath}`);
    }
    throw error;
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw evidenceError('EVIDENCE_ROOT_NOT_DIRECTORY', `evidenceRoot is not a directory: ${rootPath}`);
  }
  return resolved;
}

async function verifyEvidence(root, evidence) {
  for (let index = 0; index < evidence.length; index += 1) {
    const entry = evidence[index];
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) {
      throw evidenceError(
        'EVIDENCE_PATH',
        `evidence[${index}] must be a relative path inside evidenceRoot: ${entry.path}`,
      );
    }

    const candidate = path.resolve(root, entry.path);
    let actual;
    try {
      actual = await realpath(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw evidenceError('EVIDENCE_MISSING', `evidence[${index}] file is missing: ${entry.path}`);
      }
      throw error;
    }

    const relativeToRoot = path.relative(root, actual);
    if (
      relativeToRoot === '..' ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw evidenceError(
        'EVIDENCE_OUTSIDE_ROOT',
        `evidence[${index}] resolves outside evidenceRoot: ${entry.path}`,
      );
    }

    const info = await stat(actual);
    if (!info.isFile()) {
      throw evidenceError('EVIDENCE_NOT_FILE', `evidence[${index}] is not a regular file: ${entry.path}`);
    }

    const bytes = await readFile(actual);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) {
      throw evidenceError(
        'EVIDENCE_HASH_MISMATCH',
        `evidence[${index}] bytes do not match the recorded hash: ${entry.path}`,
      );
    }
  }
}

function parseRecordBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() !== OPEN_FENCE) continue;
    const body = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      if (lines[cursor].trimEnd() === CLOSE_FENCE) {
        closed = true;
        break;
      }
      body.push(lines[cursor]);
      cursor += 1;
    }
    if (!closed) break;
    try {
      records.push(JSON.parse(body.join('\n')));
    } catch {
      // 损坏的记录整条忽略，不影响文档中的其他记录。
    }
    index = cursor;
  }
  return records;
}

function renderRecord(record, { documentPath, evidenceRoot }) {
  const lines = [
    `## Finding: ${record.id}`,
    '',
    `Recorded at: ${new Date(record.recordedAt).toISOString()}`,
    '',
    '**原判断状态：在下述适用条件内已被修正，不再作为有效操作规则。**',
    '',
    '这是记录者的判断；证据哈希绑定文件字节，不自动认证结论的语义。',
    '',
    '**Original claim**',
    '',
    quote(record.originalClaim),
    '',
    '**Correction**',
    '',
    quote(record.correction),
    '',
    '**Steps**',
    '',
    ...record.steps.map((step, index) => `${index + 1}. ${oneLine(step)}`),
    '',
    '**Conditions**',
    '',
    `- artifact SHA-256: ${record.conditions.artifactSha256}`,
    `- config model: ${oneLine(record.conditions.configModel)}`,
    `- expires at: ${
      record.expiresAt === undefined ? 'not declared' : new Date(record.expiresAt).toISOString()
    }`,
    '',
    '**Evidence**',
    '',
    ...record.evidence.map(
      item =>
        `- [${markdownLabel(item.path)}](${evidenceLink(
          documentPath,
          evidenceRoot,
          item.path,
        )}) (SHA-256 ${item.sha256})`,
    ),
    '',
    OPEN_FENCE,
    JSON.stringify(record, null, 2),
    CLOSE_FENCE,
    '',
  ];
  return lines.join('\n');
}

function quote(value) {
  return value
    .split(/\r?\n/)
    .map(line => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

function oneLine(value) {
  return value.replace(/\s+/g, ' ').trim();
}

// 记录里的 path 相对 evidenceRoot；人读部分按文档所在目录生成可点击链接。
function evidenceLink(documentPath, evidenceRoot, relativePath) {
  const target = path.relative(
    path.dirname(documentPath),
    path.resolve(evidenceRoot, relativePath),
  );
  return target
    .split(/[\\/]/)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function markdownLabel(value) {
  return oneLine(value).replace(/[\\[\]]/g, '\\$&');
}

function separation(existingText) {
  if (existingText.length === 0) return '';
  if (existingText.endsWith('\n\n')) return '';
  if (existingText.endsWith('\n')) return '\n';
  return '\n\n';
}

async function replaceAtomically(filePath, bytes) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // 关闭失败也不能掩盖原始写入/rename 错误。
      }
    }
    try {
      await unlink(tempPath);
    } catch {
      // rename 成功后临时文件已不存在。
    }
  }
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has an unsupported field: ${key}`);
  }
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL`);
  return value;
}

function requireSingleLine(value, label) {
  const text = requireText(value, label);
  if (/[\r\n]/.test(text)) throw new TypeError(`${label} must be a single line`);
  return text;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 64-character hexadecimal SHA-256`);
  }
  return value.toLowerCase();
}

function requireFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number of milliseconds`);
  }
  return value;
}

function readTimestamp(value, label = 'now') {
  if (value === undefined) return Date.now();
  return requireFiniteNumber(value, label);
}

function requirePath(value, label) {
  const text = requireText(value, label);
  return path.resolve(text);
}

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
