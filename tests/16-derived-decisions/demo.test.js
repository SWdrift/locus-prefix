import test from 'node:test';
import assert from 'node:assert/strict';
import { runDerivedDecisions } from './scenario.js';

test('derived decisions retract, but dependency tracking and transactions have different boundaries', async () => {
  const result = await runDerivedDecisions();
  assert.deepEqual(result.memory.before, { snapshot: true, native: true, reactive: true });
  assert.deepEqual(result.memory.after, { snapshot: true, native: false, reactive: false });
  assert.deepEqual(result.database.before, {
    query: ['repair'], cached: ['repair'], bridged: ['repair'],
  });
  assert.deepEqual(result.database.after, {
    query: [], cached: ['repair'], bridged: ['repair'],
  });
  assert.deepEqual(result.database.afterIngestionSignal, []);
  assert.equal(result.coordination.writerBlocked, true);
  assert.equal(result.coordination.committedBeforeRefutation, 1);
  assert.equal(result.coordination.newIntentsAfterRefutation, 0);
  assert.deepEqual(result.coordination.currentEligible, []);
  assert.equal(result.coordination.effectAfterRefutation, 'executed:repair');
});
