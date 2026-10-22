import assert from 'node:assert/strict';
import test from 'node:test';
import { runApiScenario } from './scenario.js';

test('同一设施变化下比较原生引用、函数说明、显式观测与动态投影', async () => {
  const result = await runApiScenario();
  const names = ['native', 'described', 'witnessed', 'projected'];
  for (const name of names) {
    for (const stage of ['incident', 'fileEdited', 'replacement']) {
      assert.equal(result.stages[stage][name].verdict, 'consistent');
      assert.equal(result.stages[stage][name].request, 502);
      assert.equal(result.stages[stage][name].ready, false);
    }
    for (const stage of ['restarted', 'reused']) {
      assert.equal(result.stages[stage][name].request, 200);
      assert.equal(result.stages[stage][name].ready, true);
    }
    assert.notEqual(result.stages.incident[name].instanceId, result.stages.restarted[name].instanceId);
    assert.notEqual(result.stages.restarted[name].instanceId, result.stages.reused[name].instanceId);
    assert.equal(result.failures[name].status, 'failed');
  }
  assert.equal(result.staleRejected, true);
  assert.deepEqual(result.cachedTargets, {
    native: 'gateway-a', described: 'gateway-a', witnessed: 'gateway-b', projected: 'gateway-b',
  });
  assert.equal(result.races.witnessed.status, 'rejected');
  assert.equal(result.races.witnessed.code, 'SUBJECT_CHANGED');
  assert.equal(result.races.witnessed.beganOnB, true);
  assert.equal(result.races.projected.role, 'gateway-b');
  assert.equal(result.races.projected.beganOnB, true);
  assert.equal(result.races.native.role, 'gateway-b');
  assert.equal(result.races.described.role, 'gateway-b');
  for (const name of ['native', 'described', 'projected']) {
    assert.deepEqual(result.hiddenResults[name], { status: 'returned', role: 'gateway-a' });
  }
  assert.deepEqual(result.hiddenResults.witnessed, { status: 'rejected', code: 'INSTANCE_MISMATCH' });
  assert.equal(result.failures.witnessed.attributedToB, true);
  assert.equal(result.failures.projected.attributedToB, true);
  assert.equal(result.knowledge.selected, 'startup-override');
  assert.deepEqual(result.knowledge.changedArtifact, []);
  assert.deepEqual(result.knowledge.changedModel, []);
  assert.deepEqual(result.knowledge.expired, []);
  assert.deepEqual(result.knowledge.conflicting, ['startup-override', 'opposing-advice']);
  assert.equal(result.knowledge.retainedConflict, true);
  assert.equal(result.knowledge.conflictDecision, 'manual-review');
  assert.equal(result.stopped, true);
});
