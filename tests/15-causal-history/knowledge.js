import { createHash } from 'node:crypto';

// A deliberately small native-JS baseline: a knowledge record is a plain JSON
// value plus a version hash and lightweight author/clock metadata. It is not a
// public Locus API and does not claim to be a CRDT.

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function initialFieldClocks(record) {
  return Object.fromEntries(Object.keys(record).map(key => [key, { clock: 0, actor: 'base' }]));
}

export function createSnapshot(record, {
  actor = 'base', clock = 0, parent = null, at = 0, fieldClocks = null,
} = {}) {
  const body = {
    record: structuredClone(record),
    actor,
    clock,
    parent,
    at,
    fieldClocks: structuredClone(fieldClocks ?? initialFieldClocks(record)),
  };
  return deepFreeze({ ...body, version: digest(body) });
}

export function revise(snapshot, patch, { actor, clock = snapshot.clock + 1, at = 0 } = {}) {
  if (!actor) throw new Error('actor is required');
  const record = { ...snapshot.record, ...structuredClone(patch) };
  const fieldClocks = { ...snapshot.fieldClocks };
  for (const key of Object.keys(patch)) fieldClocks[key] = { clock, actor };
  return createSnapshot(record, { actor, clock, parent: snapshot.version, at, fieldClocks });
}

// Optimistic local write: only valid when the caller still holds the version it
// read. This catches a stale writer on one machine; it says nothing about a
// writer that never saw the newer version.
export function reviseIfCurrent(snapshot, expectedVersion, patch, options) {
  if (snapshot.version !== expectedVersion) {
    const error = new Error('STALE_SNAPSHOT');
    error.code = 'STALE_SNAPSHOT';
    throw error;
  }
  return revise(snapshot, patch, options);
}

function compareClock(left, right) {
  if (left.clock !== right.clock) return left.clock - right.clock;
  return left.actor < right.actor ? -1 : left.actor > right.actor ? 1 : 0;
}

// Naive merge: the argument order decides. Kept to expose the failure mode.
export function mergeWholeLastArgumentWins(left, right) {
  return createSnapshot(right.record, {
    actor: right.actor,
    clock: Math.max(left.clock, right.clock) + 1,
    parent: right.version,
    at: Math.max(left.at, right.at),
    fieldClocks: right.fieldClocks,
  });
}

// Convergent whole-record LWW. The winning branch is retained; the losing
// branch is not referenced by the result and its values are gone.
export function mergeWholeLww(left, right) {
  if (left.version === right.version) return left;
  const winner = compareClock(left, right) >= 0 ? left : right;
  return createSnapshot(winner.record, {
    actor: winner.actor,
    clock: Math.max(left.clock, right.clock) + 1,
    parent: winner.version,
    at: Math.max(left.at, right.at),
    fieldClocks: winner.fieldClocks,
  });
}

function fieldWinner(left, right, key) {
  const leftClock = left.fieldClocks[key] ?? { clock: 0, actor: 'base' };
  const rightClock = right.fieldClocks[key] ?? { clock: 0, actor: 'base' };
  const comparison = compareClock(leftClock, rightClock);
  return comparison >= 0 ? left : right;
}

// Per-field LWW: converges, combines fields from different branches, and has no
// place for a losing value. This fixture's single `parent` slot is set to null;
// retaining multiple parents and their content would be a different baseline.
export function mergeFieldsLww(left, right) {
  const keys = [...new Set([...Object.keys(left.record), ...Object.keys(right.record)])].sort();
  const record = {};
  const fieldClocks = {};
  for (const key of keys) {
    const source = fieldWinner(left, right, key);
    record[key] = structuredClone(source.record[key]);
    fieldClocks[key] = { ...source.fieldClocks[key] };
  }
  return createSnapshot(record, {
    actor: 'merge',
    clock: Math.max(left.clock, right.clock) + 1,
    parent: null,
    at: Math.max(left.at, right.at),
    fieldClocks,
  });
}

// Three-way field comparison. Requires the ancestor's *content*, not just its
// hash; this is the extra state a pure latest-snapshot consumer does not have.
export function detectFieldConflicts(base, left, right) {
  const keys = [...new Set([
    ...Object.keys(base.record), ...Object.keys(left.record), ...Object.keys(right.record),
  ])].sort();
  const conflicts = [];
  for (const key of keys) {
    const baseValue = base.record[key];
    const leftValue = left.record[key];
    const rightValue = right.record[key];
    // A write of the same value still has a new field clock; Automerge keeps
    // the operation too. Use the clock, not only value equality, to detect it.
    const baseClock = base.fieldClocks[key]?.clock ?? 0;
    const leftChanged = canonical(leftValue) !== canonical(baseValue) ||
      (left.fieldClocks[key]?.clock ?? 0) > baseClock;
    const rightChanged = canonical(rightValue) !== canonical(baseValue) ||
      (right.fieldClocks[key]?.clock ?? 0) > baseClock;
    if (leftChanged && rightChanged && canonical(leftValue) !== canonical(rightValue)) {
      conflicts.push({
        field: key,
        base: baseValue ?? null,
        left: leftValue ?? null,
        right: rightValue ?? null,
        leftActor: left.actor,
        rightActor: right.actor,
      });
    }
  }
  return conflicts;
}

export function explainMissingAncestor(left, right) {
  if (left.parent !== right.parent) {
    return { detectable: false, reason: 'NO_COMMON_ANCESTOR' };
  }
  return {
    detectable: false,
    reason: 'ANCESTOR_CONTENT_MISSING',
    sharedParent: left.parent,
  };
}

export function validateRecord(record) {
  const reasons = [];
  if (typeof record.claim !== 'string' || record.claim.length === 0) reasons.push('MISSING_CLAIM');
  if (typeof record.evidence !== 'string' || record.evidence.length === 0) reasons.push('MISSING_EVIDENCE');
  if (!['verified', 'rejected'].includes(record.status)) reasons.push('INVALID_STATUS');
  if (!Number.isFinite(record.validFrom) || !Number.isFinite(record.validUntil)) {
    reasons.push('INVALID_INTERVAL');
  } else if (record.validFrom > record.validUntil) {
    reasons.push('EMPTY_INTERVAL');
  }
  if (!Number.isFinite(record.observations) || record.observations < 1) {
    reasons.push('INVALID_OBSERVATIONS');
  }
  return { valid: reasons.length === 0, reasons };
}

// Fixture-local semantic check: "reverts/unsafe" wording must not coexist with
// a verified status. This is application policy, not a CRDT or JSON rule.
export function claimMatchesStatus(record) {
  const saysUnsafe = /revert|override|unsafe|not safe/i.test(record.claim);
  return record.status === 'rejected' ? saysUnsafe : !saysUnsafe;
}

function decision(allowed, reason, checks) {
  return { allowed, reason, checks };
}

// A snapshot has no conflict set. Callers may supply externally computed
// conflicts; if a policy requires them and they are absent, fail closed.
export function authorizeSnapshot(snapshot, {
  action = 'restart', now = 25, trustedActors = null,
  requireNoConflicts = false, requireAudit = false, conflicts,
} = {}) {
  const checks = [];
  if (requireAudit) {
    return decision(false, 'AUDIT_DATA_UNAVAILABLE', ['snapshot cannot prove all competing branches were seen']);
  }
  if (requireNoConflicts) {
    if (!Array.isArray(conflicts)) {
      return decision(false, 'AUDIT_DATA_UNAVAILABLE', ['conflict set was not supplied by the caller']);
    }
    if (conflicts.length > 0) {
      return decision(false, 'UNRESOLVED_CONFLICT', conflicts.map(item => item.field));
    }
    checks.push('no externally detected field conflicts');
  }
  if (trustedActors && !trustedActors.includes(snapshot.actor)) {
    return decision(false, 'UNTRUSTED_ACTOR', [snapshot.actor]);
  }
  checks.push(`actor=${snapshot.actor}`);
  const validation = validateRecord(snapshot.record);
  if (!validation.valid) return decision(false, 'INVARIANT_VIOLATION', validation.reasons);
  checks.push('record invariant');
  if (snapshot.record.status !== 'verified') {
    return decision(false, 'NOT_VERIFIED', [snapshot.record.status]);
  }
  checks.push('status=verified');
  if (now < snapshot.record.validFrom || now > snapshot.record.validUntil) {
    return decision(false, 'OUT_OF_VALIDITY', [snapshot.record.validFrom, snapshot.record.validUntil]);
  }
  checks.push('within validity window');
  if (action !== 'restart') return decision(false, 'UNSUPPORTED_ACTION', [action]);
  return decision(true, null, checks);
}

// A plain JSON record has neither history nor conflict candidates. A policy
// that needs either cannot be satisfied by this input.
export function authorizeRecord(record, {
  action = 'restart', now = 25, trustedActors = null,
  requireNoConflicts = false, requireAudit = false,
} = {}) {
  if (requireAudit || requireNoConflicts) {
    return decision(false, 'AUDIT_DATA_UNAVAILABLE', ['plain record has no change history or conflict set']);
  }
  if (trustedActors) {
    return decision(false, 'AUDIT_DATA_UNAVAILABLE', ['plain record has no authenticated actor']);
  }
  const validation = validateRecord(record);
  if (!validation.valid) return decision(false, 'INVARIANT_VIOLATION', validation.reasons);
  if (record.status !== 'verified') return decision(false, 'NOT_VERIFIED', [record.status]);
  if (now < record.validFrom || now > record.validUntil) {
    return decision(false, 'OUT_OF_VALIDITY', [record.validFrom, record.validUntil]);
  }
  if (action !== 'restart') return decision(false, 'UNSUPPORTED_ACTION', [action]);
  return decision(true, null, ['status=verified', 'within validity window']);
}
