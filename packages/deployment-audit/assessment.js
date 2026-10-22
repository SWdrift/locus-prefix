/**
 * 发布一致性评估：比较期望、制品声明与构建见证、运行现场。
 *
 * 只使用调用方提供的观测，不采集证据、不认证来源，也不重试、部署或补偿。
 * 每一项检查独立给出 pass/fail/unknown：
 * - 已提供的有效观测之间出现不符即 fail；
 * - 缺证据或证据格式非法即 unknown，绝不因同为 undefined/空值而 pass；
 * - 全部检查 pass 才 consistent。
 *
 * consistent 只表示这些受信观测在该范围内一致，不代表来源可信、构建过程
 * 正确或业务功能正确。declared source 是声明，buildSource 才是构建现场见证。
 */

/**
 * @param {{
 *   expected?: {release?: string, sourceRevision?: string},
 *   artifact?: null|{release?: string, sourceRevision?: string, payloadSha256?: string,
 *     buildSource?: {revision?: string, dirty?: boolean}},
 *   runtime?: null|{release?: string, sourceRevision?: string, payloadSha256?: string},
 * }} input
 * @returns {{
 *   verdict: 'consistent'|'mismatch'|'incomplete',
 *   checks: Array<{id: string, status: 'pass'|'fail'|'unknown', reason: string, nextAction: string|null}>,
 * }}
 */
export function assessRelease(input = {}) {
  const request = asRecord(input);
  const expected = asRecord(request.expected);
  const artifact = asRecord(request.artifact);
  const runtime = asRecord(request.runtime);

  const checks = [
    compareThree({
      id: 'release-label',
      subject: 'Release labels',
      observations: [
        { label: 'expected', value: asText(expected.release) },
        { label: 'artifact', value: asText(artifact.release) },
        { label: 'runtime', value: asText(runtime.release) },
      ],
      onMismatch: 'Confirm the intended release by hand, then inspect the published artifact label and the label reported by the running target. A matching health check or a single label is not proof of the other observations.',
      onMissing: 'Collect the release label from the artifact and from the running target directly; do not fill the gap from the expected value. No automatic retry or deployment is performed.',
    }),
    compareThree({
      id: 'declared-source',
      subject: 'Declared source revisions',
      observations: [
        { label: 'expected', value: asText(expected.sourceRevision) },
        { label: 'artifact', value: asText(artifact.sourceRevision) },
        { label: 'runtime', value: asText(runtime.sourceRevision) },
      ],
      onMismatch: 'Reconcile the source revision declared by the artifact with the runtime declaration and the intended commit; labels and declarations alone do not establish what was built.',
      onMissing: 'Read the declared source revision from the artifact metadata and from the running target; do not substitute another declaration or the expected value.',
    }),
    checkBuildSource(expected, artifact),
    checkPayloadBinding(artifact, runtime),
  ];

  const verdict = checks.some(check => check.status === 'fail')
    ? 'mismatch'
    : checks.some(check => check.status === 'unknown')
      ? 'incomplete'
      : 'consistent';

  return { verdict, checks };
}

function compareThree({ id, subject, observations, onMismatch, onMissing }) {
  const valid = observations.filter(item => item.value !== null);
  const distinct = new Set(valid.map(item => item.value));

  if (distinct.size > 1) {
    return {
      id,
      status: 'fail',
      reason: `${subject} disagree between the supplied observations.`,
      nextAction: onMismatch,
    };
  }

  if (valid.length === observations.length) {
    return {
      id,
      status: 'pass',
      reason: `${subject} agree across the expected, artifact, and runtime observations.`,
      nextAction: null,
    };
  }

  const absent = observations.filter(item => item.value === null).map(item => item.label);
  return {
    id,
    status: 'unknown',
    reason: `Cannot establish ${subject.toLowerCase()}: no valid evidence for ${absent.join(', ')}.`,
    nextAction: onMissing,
  };
}

function checkBuildSource(expected, artifact) {
  const build = artifact.buildSource;
  const id = 'build-source';

  if (!isRecord(build)) {
    return {
      id,
      status: 'unknown',
      reason: 'No build-site witness was supplied; a declared source revision is not evidence of what was actually built.',
      nextAction: 'Capture the revision checked out at the build site and an explicit dirty state (false means a clean tree). Do not substitute the declared source revision for the build witness.',
    };
  }

  const expectedRevision = asText(expected.sourceRevision);
  const revision = asText(build.revision);
  const dirty = build.dirty === true ? true : build.dirty === false ? false : null;
  const revisionMismatch =
    expectedRevision !== null && revision !== null && expectedRevision !== revision;

  if (dirty === true) {
    return {
      id,
      status: 'fail',
      reason: revisionMismatch
        ? 'The build witness violates the expected revision and clean-tree requirements; a payload difference still needs content evidence.'
        : 'The build site reports a dirty working tree, violating the clean-build contract; this alone does not prove the payload bytes differ.',
      nextAction: 'Rebuild from a clean checkout of the expected commit and collect a fresh build witness by hand. Updating a label or redeploying the current payload would not establish source binding.',
    };
  }

  if (revision === null) {
    return {
      id,
      status: 'unknown',
      reason: 'The build-site witness has no valid revision.',
      nextAction: 'Read the revision actually checked out at the build site and record it together with an explicit dirty state.',
    };
  }

  if (expectedRevision === null) {
    const declaredRevision = asText(artifact.sourceRevision);
    if (declaredRevision !== null && declaredRevision !== revision) {
      return {
        id,
        status: 'fail',
        reason: 'The expected source revision is unavailable, but the build witness revision differs from the source revision declared by the artifact.',
        nextAction: 'Recover the intended commit, rebuild from a clean checkout, and compare the build witness with both the artifact declaration and the intended commit; the current declaration does not describe the built payload.',
      };
    }

    return {
      id,
      status: 'unknown',
      reason: 'The expected source revision is missing or invalid, so the build revision cannot be compared.',
      nextAction: 'State the intended source revision, then compare it with the build-site witness. Do not infer the revision from the artifact label.',
    };
  }

  if (revisionMismatch) {
    return {
      id,
      status: 'fail',
      reason: 'The build witness reports a different revision than expected; this violates source binding even if the payload bytes happen to match.',
      nextAction: 'Rebuild from a clean checkout of the expected commit and re-collect the build witness. Changing only the label or metadata would not fix the mismatch.',
    };
  }

  if (dirty === null) {
    return {
      id,
      status: 'unknown',
      reason: 'The build revision matches the expected commit, but the build site did not explicitly report dirty=false.',
      nextAction: 'Record the build-site dirty state explicitly; a matching revision alone does not prove the working tree was clean.',
    };
  }

  return {
    id,
    status: 'pass',
    reason: 'The build-site witness reports the expected revision from an explicitly clean working tree.',
    nextAction: null,
  };
}

function checkPayloadBinding(artifact, runtime) {
  const id = 'payload-binding';
  const artifactPayload = asSha256(artifact.payloadSha256);
  const runtimePayload = asSha256(runtime.payloadSha256);

  if (artifactPayload !== null && runtimePayload !== null) {
    if (artifactPayload !== runtimePayload) {
      return {
        id,
        status: 'fail',
        reason: 'The artifact payload SHA-256 and the SHA-256 of the deployed payload differ.',
        nextAction: 'Read the actual artifact payload bytes and the deployed file bytes, then compare their SHA-256 values by hand. Release labels or metadata hashes are not substitutes.',
      };
    }

    return {
      id,
      status: 'pass',
      reason: 'The artifact payload and the runtime payload have the same SHA-256.',
      nextAction: null,
    };
  }

  const absent = [];
  if (artifactPayload === null) absent.push('artifact payload SHA-256');
  if (runtimePayload === null) absent.push('runtime payload SHA-256');

  return {
    id,
    status: 'unknown',
    reason: `Cannot bind the artifact payload to the deployed payload: no valid ${absent.join(' or ')}.`,
    nextAction: 'Compute SHA-256 over the actual artifact payload bytes and over the deployed file bytes. Do not copy a hash from release metadata or use a label hash as a substitute.',
  };
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asSha256(value) {
  const text = asText(value);
  return text !== null && /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : null;
}
