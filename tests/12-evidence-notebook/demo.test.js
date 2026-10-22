/**
 * 实验 12：证据绑定的操作知识笔记本。
 *
 * 运行：`node --test tests/12-evidence-notebook/demo.test.js`（需先安装 workspace 链接）
 *
 * 全部 fixture 位于仓库 temp 下，结束时删除。测试只通过公开 API 和真实
 * Markdown/证据文件观察行为：追加保留手写内容、条件匹配才复用、证据字节
 * 变化或丢失后失效、过期后失效、坏证据不修改文档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendFinding,
  findApplicableFindings,
} from '@locus/operational-knowledge';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const tempRoot = path.join(repoRoot, 'temp');
const artifactSha = 'a'.repeat(64);
const configModel = 'environment-over-file-at-startup-v1';

async function withFixture(run) {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, 'notebook-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeEvidence(root, relativePath, content) {
  const absolute = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return sha256(content);
}

async function createRunbook(root, text = '# Runbook\n\n手写旧判断：健康检查成功即说明上游正常。\n') {
  const file = path.join(root, 'knowledge', 'runbook.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

function sampleFinding(overrides = {}) {
  return {
    id: 'gateway-upstream-410',
    originalClaim: '原判断：/check 失败时只需修改 gateway 的 config.json。',
    correction:
      'environment.json 的 UPSTREAM_URL 在启动时覆盖 config.json；先看有效上游来源，再删除旧覆盖并重启。',
    steps: [
      'inspect-effective-configuration',
      'clear-environment-override',
      'restart-instance',
      'verify-request',
    ],
    conditions: { artifactSha256: artifactSha, configModel },
    evidence: [{ path: 'evidence/incident.json', sha256: '0'.repeat(64) }],
    ...overrides,
  };
}

function readRecords(markdown) {
  const records = [];
  const pattern = /^```operational-finding\r?\n([\s\S]*?)\r?\n```$/gm;
  for (const match of markdown.matchAll(pattern)) {
    records.push(JSON.parse(match[1]));
  }
  return records;
}

function context() {
  return { artifactSha256: artifactSha, configModel };
}

test('appending a finding keeps the handwritten runbook and can be read back as a record', async () => {
  await withFixture(async root => {
    const evidenceSha = await writeEvidence(root, 'evidence/incident.json', '{"status":502}\n');
    const secondSha = await writeEvidence(root, 'evidence/restart.json', '{"check":200}\n');
    const original = '# Runbook\n\n旧判断：健康检查成功就说明上游正常。\n\n这段手写历史必须保留。\n';
    const file = await createRunbook(root, original);
    const finding = sampleFinding({
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
    });

    const stored = await appendFinding({
      file,
      evidenceRoot: root,
      finding,
      now: 1_700_000_000_000,
    });

    assert.equal(stored.id, finding.id);
    assert.equal(stored.recordedAt, 1_700_000_000_000);
    assert.deepEqual(stored.steps, finding.steps);

    let markdown = await readFile(file, 'utf8');
    assert.ok(markdown.startsWith(original), '手写内容必须原样保留在文档开头');
    assert.ok(markdown.includes(finding.originalClaim), '原始错误断言必须保留');
    assert.ok(markdown.includes(finding.correction), '修正必须可读');
    for (const step of finding.steps) assert.ok(markdown.includes(step), `步骤 ${step} 必须可读`);
    assert.ok(markdown.includes(evidenceSha), '证据哈希必须可读');
    assert.ok(
      markdown.includes('(../evidence/incident.json)'),
      '人读部分必须提供相对文档所在目录的可点击证据链接',
    );

    let records = readRecords(markdown);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, finding.id);
    assert.equal(records[0].originalClaim, finding.originalClaim);
    assert.equal(records[0].correction, finding.correction);
    assert.deepEqual(records[0].steps, finding.steps);
    assert.deepEqual(records[0].conditions, finding.conditions);
    assert.equal(records[0].evidence[0].path, 'evidence/incident.json');
    assert.equal(records[0].evidence[0].sha256, evidenceSha);

    let found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_000_100,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, finding.id);
    assert.deepEqual(found[0].steps, finding.steps);
    assert.equal(found[0].recordedAt, stored.recordedAt);

    const second = sampleFinding({
      id: 'gateway-restart-check',
      evidence: [{ path: 'evidence/restart.json', sha256: secondSha }],
      steps: ['restart-instance', 'verify-request'],
    });
    await appendFinding({ file, evidenceRoot: root, finding: second, now: 1_700_000_001_000 });

    markdown = await readFile(file, 'utf8');
    assert.ok(markdown.startsWith(original), '再次追加后旧手写内容仍必须原样保留');
    assert.ok(markdown.includes(finding.originalClaim));
    records = readRecords(markdown);
    assert.deepEqual(records.map(record => record.id), [finding.id, second.id]);

    found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_001_100,
    });
    assert.deepEqual(found.map(record => record.id), [finding.id, second.id]);

    const leftovers = (await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '原子替换后不应留下同目录临时文件');
  });
});

test('invalid evidence or findings are rejected without changing the existing document', async () => {
  await withFixture(async root => {
    const evidenceRoot = path.join(root, 'evidence');
    const evidenceSha = await writeEvidence(evidenceRoot, 'incident.json', '{"status":502}\n');
    const outsideSha = await writeEvidence(root, 'outside.json', '{"secret":"not evidence"}\n');
    const original = '# Runbook\n\n这条手写记录在失败追加后必须逐字节不变。\n';
    const file = await createRunbook(root, original);
    const before = await readFile(file);

    const cases = [
      {
        name: 'hash mismatch',
        evidence: [{ path: 'incident.json', sha256: 'b'.repeat(64) }],
        code: 'EVIDENCE_HASH_MISMATCH',
      },
      {
        name: 'missing file',
        evidence: [{ path: 'missing.json', sha256: 'b'.repeat(64) }],
        code: 'EVIDENCE_MISSING',
      },
      {
        name: 'parent traversal',
        evidence: [{ path: '../outside.json', sha256: outsideSha }],
        code: 'EVIDENCE_PATH',
      },
      {
        name: 'absolute path',
        evidence: [{ path: path.join(root, 'outside.json'), sha256: outsideSha }],
        code: 'EVIDENCE_PATH',
      },
    ];

    for (const item of cases) {
      await assert.rejects(
        appendFinding({
          file,
          evidenceRoot,
          finding: sampleFinding({ evidence: item.evidence }),
        }),
        error => {
          assert.equal(error.code, item.code, `${item.name} must fail with ${item.code}`);
          return true;
        },
      );
      assert.deepEqual(await readFile(file), before, `${item.name} must not modify the document`);
    }

    await assert.rejects(
      appendFinding({
        file,
        evidenceRoot,
        finding: sampleFinding({
          conditions: { artifactSha256: artifactSha },
          evidence: [{ path: 'incident.json', sha256: evidenceSha }],
        }),
      }),
      TypeError,
    );
    assert.deepEqual(await readFile(file), before, 'invalid conditions must not modify the document');

    const absentFile = path.join(root, 'knowledge', 'absent.md');
    await assert.rejects(
      appendFinding({
        file: absentFile,
        evidenceRoot,
        finding: sampleFinding({
          evidence: [{ path: 'incident.json', sha256: 'c'.repeat(64) }],
        }),
      }),
      error => error.code === 'EVIDENCE_HASH_MISMATCH',
    );
    await assert.rejects(readFile(absentFile), error => error.code === 'ENOENT');
  });
});

test('changed, missing, or restored evidence controls whether a finding is reused', async () => {
  await withFixture(async root => {
    const evidencePath = path.join(root, 'evidence', 'incident.json');
    const originalEvidence = '{"status":502,"upstream":"retired"}\n';
    const evidenceSha = await writeEvidence(root, 'evidence/incident.json', originalEvidence);
    const file = await createRunbook(root);
    const finding = sampleFinding({
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
    });
    await appendFinding({ file, evidenceRoot: root, finding, now: 1_700_000_000_000 });
    const notebook = await readFile(file);

    let found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_000_100,
    });
    assert.equal(found.length, 1);

    await writeFile(evidencePath, '{"status":502,"upstream":"other"}\n');
    found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_000_100,
    });
    assert.deepEqual(found, [], 'changed evidence bytes must invalidate the record');

    await writeFile(evidencePath, originalEvidence);
    found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_000_100,
    });
    assert.equal(found.length, 1, 'restored identical bytes satisfy the byte binding again');

    await unlink(evidencePath);
    found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_000_100,
    });
    assert.deepEqual(found, [], 'missing evidence must invalidate the record');

    assert.deepEqual(await readFile(file), notebook, 'lookup must never rewrite the notebook');
  });
});

test('artifact or config model changes make the finding inapplicable', async () => {
  await withFixture(async root => {
    const evidenceSha = await writeEvidence(root, 'evidence/incident.json', '{"status":502}\n');
    const file = await createRunbook(root);
    const finding = sampleFinding({
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
    });
    await appendFinding({ file, evidenceRoot: root, finding, now: 1_700_000_000_000 });

    const base = { file, evidenceRoot: root, now: 1_700_000_000_100 };
    assert.equal((await findApplicableFindings({ ...base, context: context() })).length, 1);
    assert.deepEqual(
      await findApplicableFindings({
        ...base,
        context: { artifactSha256: 'b'.repeat(64), configModel },
      }),
      [],
      'a different artifact must not reuse the finding',
    );
    assert.deepEqual(
      await findApplicableFindings({
        ...base,
        context: { artifactSha256: artifactSha, configModel: 'other-model' },
      }),
      [],
      'a different config model must not reuse the finding',
    );
    await assert.rejects(
      findApplicableFindings({
        ...base,
        context: { artifactSha256: artifactSha },
      }),
      TypeError,
    );
  });
});

test('unconditional, partial, and malformed stored records are skipped whole', async () => {
  await withFixture(async root => {
    const evidenceSha = await writeEvidence(root, 'evidence/incident.json', '{"status":502}\n');
    const file = await createRunbook(root);
    const valid = sampleFinding({
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
    });
    await appendFinding({ file, evidenceRoot: root, finding: valid, now: 1_700_000_000_000 });

    const shared = {
      originalClaim: '旧规则',
      correction: '没有明确条件时不得当作全局规则。',
      steps: ['do-something'],
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
      recordedAt: 1_700_000_000_000,
    };
    const unconditional = { ...shared, id: 'unconditional', conditions: {} };
    const partial = {
      ...shared,
      id: 'partial',
      conditions: { artifactSha256: artifactSha },
    };
    const unknownField = {
      ...shared,
      id: 'unknown-field',
      conditions: { artifactSha256: artifactSha, configModel },
      wildcard: true,
    };

    await appendFile(
      file,
      [
        '',
        '```operational-finding',
        JSON.stringify(unconditional),
        '```',
        '',
        '```operational-finding',
        JSON.stringify(partial),
        '```',
        '',
        '```operational-finding',
        JSON.stringify(unknownField),
        '```',
        '',
        '```operational-finding',
        '{ this is not json',
        '```',
        '',
      ].join('\n'),
    );

    const found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: 1_700_000_000_100,
    });
    assert.deepEqual(found.map(record => record.id), [valid.id]);

    const markdown = await readFile(file, 'utf8');
    assert.ok(markdown.includes('"unconditional"'), '被跳过的历史记录仍保留在文档中');
    assert.ok(markdown.includes('{ this is not json'), '损坏的手写块不被重写');
  });
});

test('expired findings are not reused but remain in the Markdown history', async () => {
  await withFixture(async root => {
    const evidenceSha = await writeEvidence(root, 'evidence/incident.json', '{"status":502}\n');
    const file = await createRunbook(root);
    const now = 1_700_000_000_000;
    const expiresAt = now + 60_000;
    const expiring = sampleFinding({
      id: 'expiring',
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
      expiresAt,
    });
    const permanent = sampleFinding({
      id: 'permanent',
      evidence: [{ path: 'evidence/incident.json', sha256: evidenceSha }],
    });
    await appendFinding({ file, evidenceRoot: root, finding: expiring, now });
    await appendFinding({ file, evidenceRoot: root, finding: permanent, now });

    let found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: expiresAt - 1,
    });
    assert.deepEqual(found.map(record => record.id), ['expiring', 'permanent']);

    found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: expiresAt,
    });
    assert.deepEqual(
      found.map(record => record.id),
      ['permanent'],
      'expiry is exclusive: now === expiresAt is no longer applicable',
    );

    found = await findApplicableFindings({
      file,
      evidenceRoot: root,
      context: context(),
      now: expiresAt + 365 * 24 * 60 * 60 * 1000,
    });
    assert.deepEqual(found.map(record => record.id), ['permanent'], 'records without expiry stay valid');

    const markdown = await readFile(file, 'utf8');
    assert.equal(readRecords(markdown).length, 2, 'expired records are skipped, not deleted');
  });
});
