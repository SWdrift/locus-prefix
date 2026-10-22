/**
 * 实验 9：发布一致性评估的独立契约检查。
 *
 * 运行：`node --test tests/9-release-contract/demo.test.js`
 *
 * 直接提供观测，不启动服务器也不执行发布操作。每个测试只覆盖一条判定边界：
 * 标签、声明提交、构建现场见证、实际 payload 绑定分别判断；缺证据不能变绿，
 * 一处已证不符为 mismatch，其余仍可判断的检查保留各自结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRelease } from '../../packages/deployment-audit/assessment.js';

const RELEASE = 'release-a';
const REVISION_A = 'a'.repeat(40);
const REVISION_B = 'b'.repeat(40);
const PAYLOAD_ONE = '1'.repeat(64);
const PAYLOAD_TWO = '2'.repeat(64);

function complete() {
  return {
    expected: { release: RELEASE, sourceRevision: REVISION_A },
    artifact: {
      release: RELEASE,
      sourceRevision: REVISION_A,
      payloadSha256: PAYLOAD_ONE,
      buildSource: { revision: REVISION_A, dirty: false },
    },
    runtime: { release: RELEASE, sourceRevision: REVISION_A, payloadSha256: PAYLOAD_ONE },
  };
}

function statuses(result) {
  return Object.fromEntries(result.checks.map(check => [check.id, check.status]));
}



test('consistent only when all four independent observations agree', () => {
  const result = assessRelease(complete());

  assert.equal(result.verdict, 'consistent');
  assert.deepEqual(statuses(result), {
    'release-label': 'pass',
    'declared-source': 'pass',
    'build-source': 'pass',
    'payload-binding': 'pass',
  });
  
});

test('matching labels and declarations without a build witness stay incomplete', () => {
  const input = complete();
  delete input.artifact.buildSource;

  const result = assessRelease(input);

  assert.equal(result.verdict, 'incomplete');
  assert.deepEqual(statuses(result), {
    'release-label': 'pass',
    'declared-source': 'pass',
    'build-source': 'unknown',
    'payload-binding': 'pass',
  });
  
});

test('a build witness from another revision is a mismatch despite matching labels', () => {
  const input = complete();
  input.artifact.buildSource = { revision: REVISION_B, dirty: false };

  const result = assessRelease(input);

  assert.equal(result.verdict, 'mismatch');
  assert.deepEqual(statuses(result), {
    'release-label': 'pass',
    'declared-source': 'pass',
    'build-source': 'fail',
    'payload-binding': 'pass',
  });
  
});

test('a dirty build is a proven mismatch even at the expected revision', () => {
  const input = complete();
  input.artifact.buildSource = { revision: REVISION_A, dirty: true };

  const result = assessRelease(input);

  assert.equal(result.verdict, 'mismatch');
  assert.equal(statuses(result)['build-source'], 'fail');
  
});

test('a clean tree must be explicitly reported, not inferred from a matching revision', () => {
  const input = complete();
  input.artifact.buildSource = { revision: REVISION_A };

  const result = assessRelease(input);

  assert.equal(result.verdict, 'incomplete');
  assert.equal(statuses(result)['build-source'], 'unknown');
  
});

test('declared source and build witness are judged separately', () => {
  const input = complete();
  input.artifact.sourceRevision = REVISION_B;

  const result = assessRelease(input);

  assert.equal(result.verdict, 'mismatch');
  assert.deepEqual(statuses(result), {
    'release-label': 'pass',
    'declared-source': 'fail',
    'build-source': 'pass',
    'payload-binding': 'pass',
  });
  
});

test('a build witness contradicting the artifact declaration is a mismatch even without an expectation', () => {
  const input = complete();
  input.expected.sourceRevision = '';
  input.artifact.buildSource = { revision: REVISION_B, dirty: false };

  const result = assessRelease(input);

  assert.equal(result.verdict, 'mismatch');
  assert.equal(statuses(result)['declared-source'], 'unknown');
  assert.equal(statuses(result)['build-source'], 'fail');
  
});

test('payload disagreement is a mismatch while the other checks remain judgeable', () => {
  const input = complete();
  input.runtime.payloadSha256 = PAYLOAD_TWO;

  const result = assessRelease(input);

  assert.equal(result.verdict, 'mismatch');
  assert.deepEqual(statuses(result), {
    'release-label': 'pass',
    'declared-source': 'pass',
    'build-source': 'pass',
    'payload-binding': 'fail',
  });
  
});

test('a runtime release label differing from expectation and artifact is a mismatch', () => {
  const input = complete();
  input.runtime.release = 'release-b';

  const result = assessRelease(input);

  assert.equal(result.verdict, 'mismatch');
  assert.deepEqual(statuses(result), {
    'release-label': 'fail',
    'declared-source': 'pass',
    'build-source': 'pass',
    'payload-binding': 'pass',
  });
  
});

test('absent, blank, or malformed observations cannot agree by undefined equality', () => {
  const absent = assessRelease({
    expected: complete().expected,
    artifact: null,
    runtime: null,
  });
  assert.equal(absent.verdict, 'incomplete');
  assert.deepEqual(statuses(absent), {
    'release-label': 'unknown',
    'declared-source': 'unknown',
    'build-source': 'unknown',
    'payload-binding': 'unknown',
  });
  

  const blank = assessRelease({
    expected: { release: RELEASE, sourceRevision: '   ' },
    artifact: {
      release: RELEASE,
      sourceRevision: '',
      payloadSha256: '',
      buildSource: { revision: '  ', dirty: false },
    },
    runtime: { release: RELEASE, sourceRevision: '', payloadSha256: '' },
  });
  assert.equal(blank.verdict, 'incomplete');
  assert.deepEqual(statuses(blank), {
    'release-label': 'pass',
    'declared-source': 'unknown',
    'build-source': 'unknown',
    'payload-binding': 'unknown',
  });
  

  const malformed = complete();
  malformed.artifact.payloadSha256 = 'not-a-sha256';
  malformed.runtime.payloadSha256 = 'not-a-sha256';
  const malformedResult = assessRelease(malformed);
  assert.equal(malformedResult.verdict, 'incomplete');
  assert.equal(statuses(malformedResult)['payload-binding'], 'unknown');
  

  const empty = assessRelease({ expected: {}, artifact: {}, runtime: {} });
  assert.equal(empty.verdict, 'incomplete');
  assert.ok(Object.values(statuses(empty)).every(status => status === 'unknown'));
  
});
