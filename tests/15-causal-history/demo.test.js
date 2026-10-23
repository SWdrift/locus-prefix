import assert from 'node:assert/strict';
import test from 'node:test';
import { runCausalHistoryScenario } from './scenario.js';

test('并发知识修订：快照不保留冲突，Automerge 保留逐字段冲突但不保证语义正确或授权', async () => {
  const result = await runCausalHistoryScenario();

  // Native snapshot baseline: both offline writes are accepted, but a later
  // online writer is rejected only by the local compare-and-swap.
  assert.equal(result.snapshot.cas.onlineSecondWriter, 'STALE_SNAPSHOT');
  assert.equal(result.snapshot.cas.offlineBothAccepted, true);

  // A naive whole-record merge depends on argument order.
  assert.equal(result.snapshot.lastArgumentWins.orderDependent, true);
  assert.equal(result.snapshot.lastArgumentWins.ab.status, 'rejected');
  assert.equal(result.snapshot.lastArgumentWins.ba.status, 'verified');

  // LWW converges by discarding the other branch, including one observation.
  assert.equal(result.snapshot.lww.converged, true);
  assert.equal(result.snapshot.lww.record.status, 'verified');
  assert.equal(result.snapshot.lww.observations, 2);
  assert.equal(result.snapshot.lww.conflicts, null);
  assert.equal(result.snapshot.lww.lost.actor, 'b1');
  assert.equal(result.snapshot.lww.lost.status, 'rejected');
  assert.equal(result.snapshot.lww.lostReferenced, false);
  assert.equal(result.snapshot.lww.semanticConsistent, true);

  // Field-level LWW also converges, combines fields, and still has no conflict
  // slot. The losing refutation is not referenced by the merged snapshot.
  assert.equal(result.snapshot.fieldMerge.converged, true);
  assert.equal(result.snapshot.fieldMerge.record.status, 'verified');
  assert.equal(result.snapshot.fieldMerge.observations, 2);
  assert.equal(result.snapshot.fieldMerge.parent, null);
  assert.equal(result.snapshot.fieldMerge.conflicts, null);
  assert.equal(result.snapshot.fieldMerge.lost.actor, 'b1');
  assert.equal(result.snapshot.fieldMerge.lostReferenced, false);

  // Three-way detection works only because the scenario retained the base
  // content. The snapshots share a parent hash, but a hash is not the content.
  assert.deepEqual(
    result.snapshot.conflictDetection.withBase.map(item => item.field).sort(),
    ['claim', 'evidence', 'status'],
  );
  assert.equal(result.snapshot.conflictDetection.withoutBase.detectable, false);
  assert.equal(result.snapshot.conflictDetection.withoutBase.reason, 'ANCESTOR_CONTENT_MISSING');

  // Disjoint field edits create an invalid interval with no conflicting field
  // in either arm; only a cross-field invariant catches it.
  assert.equal(result.snapshot.interval.merged.validFrom, 40);
  assert.equal(result.snapshot.interval.merged.validUntil, 30);
  assert.equal(result.snapshot.interval.observations, 2);
  assert.equal(result.snapshot.interval.conflicts.length, 0);
  assert.equal(result.snapshot.interval.validation.reasons.includes('EMPTY_INTERVAL'), true);
  assert.equal(result.snapshot.interval.weakAuthorization.allowed, true);
  assert.equal(result.snapshot.interval.strictAuthorization.reason, 'INVARIANT_VIOLATION');

  // A plain record projection loses the audit metadata; the naive policy allows
  // it, while a policy that needs audit data must fail closed.
  assert.equal(result.snapshot.projection.naive.allowed, true);
  assert.equal(result.snapshot.projection.audited.reason, 'AUDIT_DATA_UNAVAILABLE');

  // The snapshot can be audited only when the caller supplies an external
  // conflict set. Without it, a fail-closed policy rejects; a naive one allows.
  assert.equal(result.snapshot.authorization.beforeEvidence.allowed, true);
  assert.equal(result.snapshot.authorization.afterEvidenceStrict.reason, 'UNRESOLVED_CONFLICT');
  assert.equal(result.snapshot.authorization.afterEvidenceNaive.allowed, true);
  assert.equal(
    result.snapshot.authorization.afterEvidenceWithoutConflictData.reason,
    'AUDIT_DATA_UNAVAILABLE',
  );

  // Automerge: both branches depend on the same base change and merge in either
  // order to the same document; the merged document has two heads.
  assert.equal(result.automerge.base.changes, 1);
  assert.equal(result.automerge.branches.a.heads.length, 1);
  assert.equal(result.automerge.branches.b.heads.length, 1);
  assert.equal(result.automerge.branches.a.change.deps[0], result.automerge.history.baseHash);
  assert.equal(result.automerge.branches.b.change.deps[0], result.automerge.history.baseHash);
  assert.equal(result.automerge.sameKey.mergeOrdersEqual, true);
  assert.equal(result.automerge.sameKey.headCount, 2);
  assert.equal(result.automerge.sameKey.changeCount, 3);

  // Same-key concurrent revisions: the default projection silently chooses a
  // different winner per property, producing a record no agent authored.
  assert.equal(result.automerge.sameKey.record.claim, 'restart reverts startup override');
  assert.equal(result.automerge.sameKey.record.status, 'verified');
  assert.equal(result.automerge.sameKey.record.evidence, 'incident-42b');
  assert.equal(result.automerge.sameKey.observations, 3);
  assert.equal(result.automerge.sameKey.record.claim, result.automerge.sameKey.projection.claim);
  assert.equal(result.automerge.sameKey.validation.valid, true);
  assert.equal(result.automerge.sameKey.claimMatchesStatus, false);
  assert.deepEqual(result.automerge.sameKey.conflictFields, ['claim', 'status', 'evidence']);
  for (const conflict of result.automerge.sameKey.conflicts) {
    assert.equal(conflict.count, 2);
  }
  assert.deepEqual(
    result.automerge.sameKey.projectionLosers.map(item => item.field),
    ['claim', 'status', 'evidence'],
  );

  // Conflicts are visible through getConflicts, not through a plain JSON read.
  assert.equal(result.automerge.sameKey.action.naive.allowed, true);
  assert.equal(result.automerge.sameKey.action.audited.reason, 'UNRESOLVED_CONFLICT');
  assert.deepEqual(
    result.automerge.sameKey.action.audited.conflicts,
    ['claim', 'status', 'evidence'],
  );
  assert.equal(result.automerge.sameKey.action.projectionNaive.allowed, true);
  assert.equal(result.automerge.sameKey.action.projectionAudited.reason, 'AUDIT_DATA_UNAVAILABLE');

  // History: the local document is causally closed before B arrives, yet B's
  // head is unknown to it. The absence of conflicts is not evidence of absence.
  assert.equal(result.automerge.history.changes.length, 3);
  assert.equal(result.automerge.history.beforeMerge.localHeads, 1);
  assert.equal(result.automerge.history.beforeMerge.hasOtherHeads, false);
  assert.equal(result.automerge.history.beforeMerge.missingWithoutKnownHead.length, 0);
  assert.equal(result.automerge.history.beforeMerge.conflicts.length, 0);
  assert.equal(
    result.automerge.history.beforeMerge.missingDeps.includes(result.automerge.history.refuteHash),
    true,
  );
  assert.equal(result.automerge.history.closedButIncomplete, true);
  assert.equal(result.automerge.history.afterMerge.missingDeps.length, 0);
  assert.equal(result.automerge.history.afterMerge.hasOtherHeads, true);
  assert.equal(result.automerge.history.afterMerge.heads, 2);
  assert.equal(result.automerge.history.baseView.record.claim, result.fixture.base.claim);
  assert.equal(result.automerge.history.baseView.record.observations, 1);
  assert.equal(result.automerge.history.changesFromA, 1);
  assert.equal(result.automerge.history.changesFromB, 1);

  // Binary save/load preserves the conflict set, counter type and heads; JSON
  // projection/reimport loses all three and creates one fresh change.
  assert.equal(result.automerge.persistence.loaded.headsPreserved, true);
  assert.equal(result.automerge.persistence.loaded.changeCount, 3);
  assert.equal(result.automerge.persistence.loaded.conflictCount, 3);
  assert.equal(result.automerge.persistence.loaded.counterPreserved, true);
  assert.equal(result.automerge.persistence.reimport.changeCount, 1);
  assert.equal(result.automerge.persistence.reimport.actor, '99');
  assert.equal(result.automerge.persistence.reimport.deps.length, 0);
  assert.equal(result.automerge.persistence.reimport.conflictCount, 0);
  assert.equal(result.automerge.persistence.reimport.counterPreserved, false);
  assert.equal(result.automerge.persistence.reimport.observations, 3);
  assert.equal(result.automerge.persistence.reimport.incrementError, 'TypeError');

  // Disjoint-field edits: no per-property conflict, but the merged record has
  // an empty validity interval. Automerge preserved both writes; it did not
  // enforce the record's schema.
  assert.equal(result.automerge.interval.record.validFrom, 40);
  assert.equal(result.automerge.interval.record.validUntil, 30);
  assert.equal(result.automerge.interval.record.observations, 3);
  assert.equal(result.automerge.interval.conflictCount, 0);
  assert.equal(result.automerge.interval.validation.reasons.includes('EMPTY_INTERVAL'), true);
  assert.equal(result.automerge.interval.weakAuthorization.allowed, true);
  assert.equal(result.automerge.interval.audited.reason, 'INVARIANT_VIOLATION');
  assert.equal(result.automerge.interval.snapshot.observations, 2);

  // Before B arrives the local policy allows; after merging B it refuses.
  // The simulated action log is illustrative, not proof of external effects.
  assert.equal(result.automerge.authorization.beforeEvidence.allowed, true);
  assert.equal(result.automerge.authorization.afterEvidence.reason, 'UNRESOLVED_CONFLICT');

  // An untrusted actor's change merges and becomes visible; policy checks the
  // history. A plain projection cannot, and a naive policy allows it.
  assert.equal(result.automerge.authorization.untrusted.actors.includes('ee'), true);
  assert.equal(result.automerge.authorization.untrusted.naive.allowed, true);
  assert.equal(result.automerge.authorization.untrusted.audited.reason, 'UNTRUSTED_ACTOR');
  assert.equal(result.automerge.authorization.untrusted.projectionNaive.allowed, true);
  assert.equal(
    result.automerge.authorization.untrusted.projectionAudited.reason,
    'AUDIT_DATA_UNAVAILABLE',
  );

  // Actor IDs are self-declared. Reusing the trusted actor ID is accepted by
  // history-based policy; identity authentication is a separate layer.
  assert.equal(result.automerge.authorization.spoof.decodedActor, 'aa');
  assert.equal(result.automerge.authorization.spoof.conflicts.length, 0);
  assert.equal(result.automerge.authorization.spoof.audited.allowed, true);

  // A new authored assignment clears conflicts and returns to one head. It is
  // a decision, not proof that either prior claim was true.
  assert.equal(result.automerge.resolution.changeCount, 4);
  assert.equal(result.automerge.resolution.headCount, 1);
  assert.equal(result.automerge.resolution.conflicts.length, 0);
  assert.equal(result.automerge.resolution.record.status, 'rejected');
  assert.equal(result.automerge.resolution.actor, 'f1');

});
