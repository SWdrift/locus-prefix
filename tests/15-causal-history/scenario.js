import * as Automerge from '@automerge/automerge';
import { pathToFileURL } from 'node:url';
import {
  authorizeRecord, authorizeSnapshot, canonical, claimMatchesStatus,
  createSnapshot, detectFieldConflicts, explainMissingAncestor, mergeFieldsLww,
  mergeWholeLastArgumentWins, mergeWholeLww, revise, reviseIfCurrent,
  validateRecord,
} from './knowledge.js';

// Case 1, situations 5 and 7: two agents revise the same knowledge record while
// offline, based on different observations. The fixture is a bounded knowledge
// record, not a deployment engine.
const BASE_ACTOR = 'aa';
const SUPPORT_ACTOR = 'a1';
const REFUTE_ACTOR = 'b1';
const UNTRUSTED_ACTOR = 'ee';
const IMPOSTOR_ACTOR = 'aa';
const TRUSTED_ACTORS = ['aa', 'a1', 'b1'];
const FIELDS = ['claim', 'status', 'evidence', 'observations', 'validFrom', 'validUntil'];

const baseRecord = () => ({
  id: 'gateway-restart',
  claim: 'restart after config flush preserves effective config',
  status: 'verified',
  evidence: 'incident-42',
  validFrom: 1,
  validUntil: 50,
  observations: 1,
});

const supportPatch = () => ({
  claim: 'restart after flush preserves effective config',
  status: 'verified',
  evidence: 'incident-42b',
  observations: 2,
});

const refutePatch = () => ({
  claim: 'restart reverts startup override',
  status: 'rejected',
  evidence: 'incident-43',
  observations: 2,
});

function readRecord(doc) {
  return {
    id: doc.id,
    claim: doc.claim,
    status: doc.status,
    evidence: doc.evidence,
    validFrom: doc.validFrom,
    validUntil: doc.validUntil,
    observations: Number(doc.observations),
  };
}

function conflictsFor(doc, keys = FIELDS) {
  const found = [];
  for (const field of keys) {
    const conflicts = Automerge.getConflicts(doc, field);
    if (!conflicts) continue;
    const values = Object.values(conflicts).map(value => String(value)).sort();
    found.push({ field, values, count: values.length });
  }
  return found;
}

function conflictFieldNames(doc) {
  return conflictsFor(doc).map(item => item.field);
}

function sorted(values) {
  return [...values].sort();
}

function weakAuthorize(record) {
  return record.status === 'verified'
    ? { allowed: true, reason: null, checks: ['status=verified (weak policy)'] }
    : { allowed: false, reason: 'NOT_VERIFIED', checks: ['status=verified (weak policy)'] };
}

// Authorization for the CRDT arm. History and conflicts are inspected here;
// merging alone never calls this function.
function authorizeAutomerge(doc, policy) {
  const checks = [];
  const record = readRecord(doc);
  if (policy.requireAudit) {
    const actors = [...new Set(Automerge.getAllChanges(doc)
      .map(change => Automerge.decodeChange(change).actor))].sort();
    checks.push(`actors=${actors.join(',')}`);
    if (policy.trustedActors && actors.some(actor => !policy.trustedActors.includes(actor))) {
      return { allowed: false, reason: 'UNTRUSTED_ACTOR', actors, checks };
    }
  }
  if (policy.requireNoConflicts) {
    const conflicts = conflictFieldNames(doc);
    if (conflicts.length > 0) {
      return { allowed: false, reason: 'UNRESOLVED_CONFLICT', conflicts, checks };
    }
    checks.push('no unresolved conflicts');
  }
  const validation = validateRecord(record);
  if (!validation.valid) {
    return { allowed: false, reason: 'INVARIANT_VIOLATION', details: validation.reasons, checks };
  }
  checks.push('record invariant');
  if (record.status !== 'verified') {
    return { allowed: false, reason: 'NOT_VERIFIED', status: record.status, checks };
  }
  checks.push('status=verified');
  if (policy.now < record.validFrom || policy.now > record.validUntil) {
    return { allowed: false, reason: 'OUT_OF_VALIDITY', checks };
  }
  checks.push('within validity window');
  if (policy.action !== 'restart') {
    return { allowed: false, reason: 'UNSUPPORTED_ACTION', checks };
  }
  return { allowed: true, reason: null, checks };
}

function snapshotRecord(snapshot) {
  return { ...snapshot.record, observations: Number(snapshot.record.observations) };
}

export async function runCausalHistoryScenario() {
  const naivePolicy = {
    action: 'restart', now: 25, trustedActors: null,
    requireNoConflicts: false, requireAudit: false,
  };
  const auditedPolicy = {
    action: 'restart', now: 25, trustedActors: TRUSTED_ACTORS,
    requireNoConflicts: true, requireAudit: true,
  };

  // ---------------------------------------------------------------------------
  // Native JS snapshot arm
  // ---------------------------------------------------------------------------
  const snapBase = createSnapshot(baseRecord(), { actor: 'base', clock: 0, at: 0 });
  const snapSupport = revise(snapBase, supportPatch(), {
    actor: SUPPORT_ACTOR, clock: 2, at: 2,
  });
  const snapRefute = revise(snapBase, refutePatch(), {
    actor: REFUTE_ACTOR, clock: 1, at: 3,
  });

  const onlineFirst = reviseIfCurrent(snapBase, snapBase.version, supportPatch(), {
    actor: SUPPORT_ACTOR, clock: 2, at: 2,
  });
  let onlineSecondWriter = null;
  try {
    reviseIfCurrent(onlineFirst, snapBase.version, refutePatch(), {
      actor: REFUTE_ACTOR, clock: 1, at: 3,
    });
  } catch (error) {
    onlineSecondWriter = error.code;
  }
  const offlineBothAccepted = snapSupport.parent === snapBase.version &&
    snapRefute.parent === snapBase.version;

  const lastWinsAB = mergeWholeLastArgumentWins(snapSupport, snapRefute);
  const lastWinsBA = mergeWholeLastArgumentWins(snapRefute, snapSupport);
  const lastArgumentWinsOrderDependent = canonical(lastWinsAB.record) !== canonical(lastWinsBA.record);

  const lww = mergeWholeLww(snapSupport, snapRefute);
  const lwwReverse = mergeWholeLww(snapRefute, snapSupport);
  const lwwConverged = canonical(lww.record) === canonical(lwwReverse.record);
  const lwwLost = lww.parent === snapSupport.version ? snapRefute : snapSupport;
  const lwwLostReferenced = lww.parent === lwwLost.version ||
    JSON.stringify(lww.fieldClocks).includes(`"${lwwLost.actor}"`);

  const fieldMerge = mergeFieldsLww(snapSupport, snapRefute);
  const fieldMergeReverse = mergeFieldsLww(snapRefute, snapSupport);
  const fieldMergeConverged = canonical(fieldMerge.record) === canonical(fieldMergeReverse.record);
  const fieldWinningActors = new Set(Object.values(fieldMerge.fieldClocks).map(clock => clock.actor));
  const fieldLost = fieldWinningActors.has(SUPPORT_ACTOR) ? snapRefute : snapSupport;
  const fieldLostReferenced = fieldMerge.parent === fieldLost.version ||
    JSON.stringify(fieldMerge.fieldClocks).includes(`"${fieldLost.actor}"`);

  const detectedConflicts = detectFieldConflicts(snapBase, snapSupport, snapRefute);
  const missingAncestor = explainMissingAncestor(snapSupport, snapRefute);

  const snapIntervalA = revise(snapBase, { validFrom: 40, observations: 2 }, {
    actor: 'c1', clock: 1, at: 4,
  });
  const snapIntervalB = revise(snapBase, { validUntil: 30, observations: 2 }, {
    actor: 'd1', clock: 1, at: 5,
  });
  const snapIntervalMerged = mergeFieldsLww(snapIntervalA, snapIntervalB);
  const snapIntervalValidation = validateRecord(snapshotRecord(snapIntervalMerged));
  const snapIntervalConflicts = detectFieldConflicts(snapBase, snapIntervalA, snapIntervalB);

  const snapshotActionLog = [];
  const snapshotBefore = authorizeSnapshot(snapSupport, {
    ...naivePolicy, requireNoConflicts: true, conflicts: [], trustedActors: TRUSTED_ACTORS,
  });
  if (snapshotBefore.allowed) {
    snapshotActionLog.push({ action: 'restart', basis: 'snapshot before offline counter-evidence', at: 2 });
  }
  const snapshotAfterStrict = authorizeSnapshot(fieldMerge, {
    ...naivePolicy, requireNoConflicts: true, conflicts: detectedConflicts,
    trustedActors: TRUSTED_ACTORS,
  });
  const snapshotAfterNaive = authorizeSnapshot(fieldMerge, naivePolicy);
  const snapshotAfterNoConflictData = authorizeSnapshot(fieldMerge, {
    ...naivePolicy, requireNoConflicts: true,
  });
  const snapshotProjection = JSON.parse(JSON.stringify(fieldMerge.record));
  const snapshotProjectionNaive = authorizeRecord(snapshotProjection, naivePolicy);
  const snapshotProjectionAudited = authorizeRecord(snapshotProjection, auditedPolicy);

  // ---------------------------------------------------------------------------
  // Automerge arm
  // ---------------------------------------------------------------------------
  const baseDoc = Automerge.from({
    ...baseRecord(),
    observations: new Automerge.Counter(1),
  }, { actor: BASE_ACTOR });

  const docA = Automerge.change(Automerge.clone(baseDoc, { actor: SUPPORT_ACTOR }), {
    message: 'agent-a: support revision offline',
  }, doc => {
    doc.claim = 'restart after flush preserves effective config';
    doc.status = 'verified';
    doc.evidence = 'incident-42b';
    doc.observations.increment(1);
  });
  const docB = Automerge.change(Automerge.clone(baseDoc, { actor: REFUTE_ACTOR }), {
    message: 'agent-b: refute revision offline',
  }, doc => {
    doc.claim = 'restart reverts startup override';
    doc.status = 'rejected';
    doc.evidence = 'incident-43';
    doc.observations.increment(1);
  });

  const merged = Automerge.merge(Automerge.clone(docA), docB);
  const mergedReverse = Automerge.merge(Automerge.clone(docB), docA);
  const mergeOrdersEqual = Automerge.equals(merged, mergedReverse);
  const mergedRecord = readRecord(merged);
  const mergedConflicts = conflictsFor(merged);
  const mergedProjection = JSON.parse(JSON.stringify(merged));
  const projectionLosers = mergedConflicts.flatMap(item =>
    item.values
      .filter(value => String(value) !== String(mergedProjection[item.field]))
      .map(value => ({ field: item.field, value }))
  );
  const mergedValidation = validateRecord(mergedRecord);
  const mergedClaimConsistent = claimMatchesStatus(mergedRecord);

  const historyChanges = Automerge.getAllChanges(merged).map(change => {
    const decoded = Automerge.decodeChange(change);
    return {
      hash: decoded.hash,
      actor: decoded.actor,
      seq: decoded.seq,
      deps: decoded.deps,
      message: decoded.message,
      time: decoded.time,
      bytes: change.byteLength,
    };
  });
  const byActor = Object.fromEntries(historyChanges.map(change => [change.actor, change]));
  const baseHash = byActor[BASE_ACTOR].hash;
  const supportHash = byActor[SUPPORT_ACTOR].hash;
  const refuteHash = byActor[REFUTE_ACTOR].hash;
  const baseView = Automerge.view(merged, [baseHash]);
  const heads = Automerge.getHeads(merged);
  const beforeMerge = {
    localHeads: Automerge.getHeads(docA).length,
    otherHeads: Automerge.getHeads(docB),
    missingDeps: Automerge.getMissingDeps(docA, Automerge.getHeads(docB)),
    hasOtherHeads: Automerge.hasHeads(docA, Automerge.getHeads(docB)),
    missingWithoutKnownHead: Automerge.getMissingDeps(docA, []),
    conflicts: conflictFieldNames(docA),
  };
  const afterMerge = {
    missingDeps: Automerge.getMissingDeps(merged, Automerge.getHeads(docB)),
    hasOtherHeads: Automerge.hasHeads(merged, Automerge.getHeads(docB)),
    heads: heads.length,
  };
  const changesFromA = Automerge.getChanges(docA, merged).length;
  const changesFromB = Automerge.getChanges(docB, merged).length;

  const saved = Automerge.save(merged);
  const loaded = Automerge.load(saved);
  const loadedConflicts = conflictsFor(loaded);
  const loadedCounter = Automerge.isCounter(loaded.observations);
  const headsPreserved = canonical(sorted(Automerge.getHeads(loaded))) === canonical(sorted(heads));
  const reimported = Automerge.from(mergedProjection, { actor: '99' });
  let reimportedIncrementError = null;
  try {
    Automerge.change(reimported, doc => { doc.observations.increment(1); });
  } catch (error) {
    reimportedIncrementError = error.name;
  }

  const intervalDocA = Automerge.change(Automerge.clone(baseDoc, { actor: 'c1' }), {
    message: 'interval: later start',
  }, doc => {
    doc.validFrom = 40;
    doc.observations.increment(1);
  });
  const intervalDocB = Automerge.change(Automerge.clone(baseDoc, { actor: 'd1' }), {
    message: 'interval: earlier end',
  }, doc => {
    doc.validUntil = 30;
    doc.observations.increment(1);
  });
  const intervalMerged = Automerge.merge(Automerge.clone(intervalDocA), intervalDocB);
  const intervalRecord = readRecord(intervalMerged);
  const intervalConflicts = conflictsFor(intervalMerged, ['validFrom', 'validUntil']);
  const intervalValidation = validateRecord(intervalRecord);

  const untrustedDoc = Automerge.change(Automerge.clone(baseDoc, { actor: UNTRUSTED_ACTOR }), {
    message: 'untrusted assertion',
  }, doc => {
    doc.claim = 'restart is always safe';
    doc.status = 'verified';
    doc.evidence = 'incident-99';
  });
  const untrustedMerged = Automerge.merge(Automerge.clone(baseDoc, { actor: 'ff' }), untrustedDoc);
  const untrustedRecord = readRecord(untrustedMerged);
  const untrustedActors = [...new Set(Automerge.getAllChanges(untrustedMerged)
    .map(change => Automerge.decodeChange(change).actor))].sort();

  const spoofDoc = Automerge.change(Automerge.clone(baseDoc, { actor: IMPOSTOR_ACTOR }), {
    message: 'self-asserted identity',
  }, doc => {
    doc.claim = 'restart is always safe';
    doc.status = 'verified';
    doc.evidence = 'incident-99';
  });
  const spoofMerged = Automerge.merge(Automerge.clone(baseDoc, { actor: 'ff' }), spoofDoc);
  const spoofRecord = readRecord(spoofMerged);
  const spoofChange = Automerge.decodeChange(Automerge.getLastLocalChange(spoofDoc));
  const spoofActors = [...new Set(Automerge.getAllChanges(spoofMerged)
    .map(change => Automerge.decodeChange(change).actor))].sort();

  const automergeActionLog = [];
  const automergeBefore = authorizeAutomerge(docA, auditedPolicy);
  if (automergeBefore.allowed) {
    automergeActionLog.push({ action: 'restart', basis: 'agent-a local heads before B arrived', at: 2 });
  }
  const automergeAfter = authorizeAutomerge(merged, auditedPolicy);
  const sameKeyNaive = authorizeAutomerge(merged, naivePolicy);
  const sameKeyAudited = authorizeAutomerge(merged, auditedPolicy);

  // Keep an independent history handle so the later report can still describe
  // the pre-resolution merge after authoring the resolution.
  const resolved = Automerge.change(Automerge.clone(merged, { actor: 'f1' }), {
    message: 'reviewed: reject until flush/override behavior is separated',
  }, doc => {
    doc.claim = 'restart safety disputed: flush behavior differs by release';
    doc.status = 'rejected';
    doc.evidence = 'review-1';
    doc.validUntil = 30;
  });
  const resolvedRecord = readRecord(resolved);
  const resolvedChange = Automerge.decodeChange(Automerge.getLastLocalChange(resolved));

  return {
    fixture: {
      case: 'documents/cases/1-heterogeneous-engineering-workspace.md#4-持续演化情境',
      situations: [5, 7],
      base: baseRecord(),
      support: supportPatch(),
      refute: refutePatch(),
      actors: { base: BASE_ACTOR, support: SUPPORT_ACTOR, refute: REFUTE_ACTOR },
      note: 'Both agents start from the same base; B observed later but has a lower local logical clock in the snapshot arm.',
    },
    snapshot: {
      base: { version: snapBase.version, record: snapBase.record },
      support: { version: snapSupport.version, actor: snapSupport.actor, clock: snapSupport.clock, record: snapSupport.record },
      refute: { version: snapRefute.version, actor: snapRefute.actor, clock: snapRefute.clock, at: snapRefute.at, record: snapRefute.record },
      cas: { onlineSecondWriter, offlineBothAccepted },
      lastArgumentWins: {
        ab: lastWinsAB.record,
        ba: lastWinsBA.record,
        orderDependent: lastArgumentWinsOrderDependent,
      },
      lww: {
        converged: lwwConverged,
        record: lww.record,
        observations: Number(lww.record.observations),
        parent: lww.parent,
        winner: lww.actor,
        conflicts: null,
        lost: { actor: lwwLost.actor, status: lwwLost.record.status, record: lwwLost.record },
        lostReferenced: lwwLostReferenced,
        semanticConsistent: claimMatchesStatus(lww.record),
      },
      fieldMerge: {
        converged: fieldMergeConverged,
        record: fieldMerge.record,
        observations: Number(fieldMerge.record.observations),
        parent: fieldMerge.parent,
        winner: fieldMerge.actor,
        conflicts: null,
        lost: { actor: fieldLost.actor, status: fieldLost.record.status, record: fieldLost.record },
        lostReferenced: fieldLostReferenced,
        semanticConsistent: claimMatchesStatus(fieldMerge.record),
      },
      conflictDetection: {
        withBase: detectedConflicts,
        withoutBase: missingAncestor,
        consumerRetainsBase: false,
      },
      interval: {
        merged: snapIntervalMerged.record,
        observations: Number(snapIntervalMerged.record.observations),
        conflicts: snapIntervalConflicts,
        validation: snapIntervalValidation,
        weakAuthorization: weakAuthorize(snapshotRecord(snapIntervalMerged)),
        strictAuthorization: authorizeRecord(snapshotRecord(snapIntervalMerged), naivePolicy),
      },
      projection: {
        record: snapshotProjection,
        dropped: ['actor', 'clock', 'parent', 'version', 'fieldClocks'],
        naive: snapshotProjectionNaive,
        audited: snapshotProjectionAudited,
      },
      authorization: {
        beforeEvidence: snapshotBefore,
        afterEvidenceStrict: snapshotAfterStrict,
        afterEvidenceNaive: snapshotAfterNaive,
        afterEvidenceWithoutConflictData: snapshotAfterNoConflictData,
        actionLog: snapshotActionLog,
        wouldExecuteAgainUnderNaivePolicy: snapshotAfterNaive.allowed,
      },
    },
    automerge: {
      base: { heads: Automerge.getHeads(baseDoc), changes: Automerge.getAllChanges(baseDoc).length },
      branches: {
        a: { heads: Automerge.getHeads(docA), change: byActor[SUPPORT_ACTOR] },
        b: { heads: Automerge.getHeads(docB), change: byActor[REFUTE_ACTOR] },
      },
      sameKey: {
        mergeOrdersEqual,
        heads: sorted(heads),
        headCount: heads.length,
        changeCount: historyChanges.length,
        record: mergedRecord,
        observations: mergedRecord.observations,
        conflicts: mergedConflicts,
        conflictCount: mergedConflicts.length,
        conflictFields: mergedConflicts.map(item => item.field),
        projection: mergedProjection,
        projectionLosers,
        projectionConflictsVisible: false,
        validation: mergedValidation,
        claimMatchesStatus: mergedClaimConsistent,
        action: {
          naive: sameKeyNaive,
          audited: sameKeyAudited,
          projectionNaive: authorizeRecord(mergedProjection, naivePolicy),
          projectionAudited: authorizeRecord(mergedProjection, auditedPolicy),
        },
      },
      history: {
        baseHash,
        supportHash,
        refuteHash,
        changes: historyChanges,
        baseView: { record: readRecord(baseView), heads: Automerge.getHeads(baseView) },
        beforeMerge,
        afterMerge,
        changesFromA,
        changesFromB,
        closedButIncomplete: beforeMerge.localHeads === 1 &&
          beforeMerge.missingWithoutKnownHead.length === 0 &&
          beforeMerge.hasOtherHeads === false &&
          beforeMerge.conflicts.length === 0,
      },
      persistence: {
        saveBytes: saved.byteLength,
        jsonBytes: Buffer.byteLength(JSON.stringify(merged)),
        changeBytes: historyChanges.reduce((sum, change) => sum + change.bytes, 0),
        loaded: {
          headsPreserved,
          headCount: Automerge.getHeads(loaded).length,
          changeCount: Automerge.getAllChanges(loaded).length,
          conflicts: loadedConflicts,
          conflictCount: loadedConflicts.length,
          counterPreserved: loadedCounter,
        },
        reimport: {
          changeCount: Automerge.getAllChanges(reimported).length,
          actor: Automerge.decodeChange(Automerge.getAllChanges(reimported)[0]).actor,
          deps: Automerge.decodeChange(Automerge.getAllChanges(reimported)[0]).deps,
          conflicts: conflictsFor(reimported),
          conflictCount: conflictsFor(reimported).length,
          counterPreserved: Automerge.isCounter(reimported.observations),
          observations: Number(reimported.observations),
          incrementError: reimportedIncrementError,
        },
      },
      interval: {
        record: intervalRecord,
        conflicts: intervalConflicts,
        conflictCount: intervalConflicts.length,
        validation: intervalValidation,
        weakAuthorization: weakAuthorize(intervalRecord),
        audited: authorizeAutomerge(intervalMerged, { ...auditedPolicy, trustedActors: null }),
        snapshot: {
          record: snapIntervalMerged.record,
          observations: Number(snapIntervalMerged.record.observations),
          conflicts: snapIntervalConflicts,
          validation: snapIntervalValidation,
        },
      },
      authorization: {
        beforeEvidence: automergeBefore,
        afterEvidence: automergeAfter,
        actionLog: automergeActionLog,
        untrusted: {
          record: untrustedRecord,
          actors: untrustedActors,
          conflicts: conflictFieldNames(untrustedMerged),
          naive: authorizeAutomerge(untrustedMerged, naivePolicy),
          audited: authorizeAutomerge(untrustedMerged, auditedPolicy),
          projectionNaive: authorizeRecord(JSON.parse(JSON.stringify(untrustedMerged)), naivePolicy),
          projectionAudited: authorizeRecord(JSON.parse(JSON.stringify(untrustedMerged)), auditedPolicy),
        },
        spoof: {
          record: spoofRecord,
          decodedActor: spoofChange.actor,
          message: spoofChange.message,
          actors: spoofActors,
          conflicts: conflictFieldNames(spoofMerged),
          audited: authorizeAutomerge(spoofMerged, auditedPolicy),
          identityAuthenticated: false,
          note: 'The actor field is self-declared; no signature or key binding was checked.',
        },
      },
      resolution: {
        changeCount: Automerge.getAllChanges(resolved).length,
        headCount: Automerge.getHeads(resolved).length,
        conflicts: conflictsFor(resolved),
        record: resolvedRecord,
        actor: resolvedChange.actor,
        message: resolvedChange.message,
        note: 'A new authored assignment resolves the conflict; it does not prove either prior claim.',
      },
    },
    comparison: {
      convergence: { snapshotWholeLww: lwwConverged, snapshotFieldLww: fieldMergeConverged, automerge: mergeOrdersEqual },
      conflictVisibility: {
        snapshot: 'none in the snapshot; external three-way comparison needs retained ancestor content',
        automerge: 'per-property conflicts via getConflicts; hidden by JSON projection; no cross-field conflicts',
      },
      causalHistory: {
        snapshot: 'single parent hash; the losing branch is not referenced',
        automerge: 'change DAG with deps/heads; multiple heads after merge; view/getChanges/getMissingDeps',
      },
      jsonRoundTrip: {
        snapshot: 'record projection drops actor, clock, parent, version and field clocks',
        automerge: 'drops conflicts, change history and Counter type; reimport is one new change',
      },
      actionRollback: {
        snapshot: false, automerge: false,
        parallelExperiment16: 'old committed intent still wrote the actuator after counter-evidence',
      },
      authorization: {
        snapshot: 'requires externally supplied conflict data or a fail-closed policy',
        automerge: 'merge accepts untrusted changes; filter/sign before merge; actor IDs are not authentication',
      },
    },
    limits: [
      'One in-memory fixture on one machine; no network, sync protocol, retries, duplication or clock skew.',
      'No text/list/nested-map/counter benchmark; no performance claim.',
      'The snapshot arm is one local design (LWW and field-LWW), not every snapshot-based design. Keeping all ancestor snapshots can enable three-way detection at the cost of an event history.',
      'Automerge actor IDs are arbitrary identifiers; no signature, revocation or key management is implemented.',
      'getHistory and toJS are marked hidden in 3.5.0 and are not used; getAllChanges/decodeChange are semi-stable APIs.',
      'Action execution is a simulated log entry; no infrastructure was touched.',
      'Parallel experiment 16 is cited from its own run; it is not re-run here.',
      'The JSON projection is the plain object form; binary save/load is tested separately and preserves conflicts and Counter.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runCausalHistoryScenario(), null, 2));
}
