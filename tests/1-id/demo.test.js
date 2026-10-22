/**
 * 实验 1：身份与 JSON 边界
 *
 * 运行：`pnpm test` 或 `node --test tests/1-id/demo.test.js`
 * 结论与证据：`documents/conclusions/1-core.md`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityScope, restoreIdentityScope } from '../../src/identity.js';
import { jsonRoundtrip } from '../lib/json.js';
import { makeJump, makeMachine } from '../lib/machine.js';

test('references retain identity when object data changes', () => {
  const scope = createIdentityScope();
  const machine = makeMachine();
  assert.equal(scope.register('machine:a', machine), machine);
  const reference = scope.ref('machine:a');
  assert.deepEqual(reference, { $ref: 'machine:a' });
  machine.address = 'updated-address';
  assert.equal(scope.resolve(reference), machine);
  assert.equal(scope.resolve(reference).address, 'updated-address');
});

test('two machines and connection references roundtrip into a new identity scope', () => {
  const original = createIdentityScope();
  const a = original.register('machine:a', makeMachine());
  const b = original.register('machine:b', makeJump());
  const connection = {
    target: original.ref('machine:a'),
    via: original.ref('machine:b'),
    again: original.ref('machine:a'),
  };
  const data = jsonRoundtrip({
    objects: original.snapshot(object => ({ ...object })),
    connection,
  });
  const restored = restoreIdentityScope(data.objects, value => value);
  const restoredA = restored.resolve(data.connection.target);
  assert.deepEqual(restoredA, a);
  assert.notEqual(restoredA, a);
  assert.equal(restored.resolve(data.connection.again), restoredA);
  assert.deepEqual(restored.resolve(data.connection.via), b);
  assert.notEqual(restored.resolve(data.connection.via), b);
  assert.equal(original.resolve(connection.target), a);
});

test('snapshot and restore isolate nested data from later external mutation', () => {
  const scope = createIdentityScope();
  const machine = scope.register('a', { config: { addresses: ['old'] } });
  const entries = scope.snapshot(object => object);
  machine.config.addresses[0] = 'changed original';
  assert.equal(entries[0].value.config.addresses[0], 'old');
  const restored = restoreIdentityScope(entries, value => value);
  entries[0].value.config.addresses[0] = 'changed snapshot';
  assert.equal(restored.resolve({ $ref: 'a' }).config.addresses[0], 'old');
  restored.resolve({ $ref: 'a' }).config.addresses.push('new');
  assert.equal(entries[0].value.config.addresses.length, 1);
});

test('unknown references fail explicitly and reference shapes are strict', () => {
  const scope = createIdentityScope();
  scope.register('a', {});
  assert.throws(() => scope.ref('missing'), /Unknown identity/);
  assert.throws(() => scope.resolve({ $ref: 'missing' }), /Unknown identity/);
  for (const reference of [null, 'a', [], {}, { $ref: '' }, { $ref: 1 },
    { $ref: 'a', extra: true }, Object.create({ $ref: 'a' }),
    { $ref: 'a', [Symbol('extra')]: 1 }, { get $ref() { return 'a'; } }]) {
    assert.throws(() => scope.resolve(reference));
  }
});

test('registration rejects duplicate IDs and ambiguous object identity', () => {
  const scope = createIdentityScope();
  const object = scope.register('a', {});
  assert.throws(() => scope.register('a', {}), /Duplicate identity/);
  assert.throws(() => scope.register('a', object), /Duplicate identity/);
  assert.throws(() => scope.register('b', object), /already has an identity/);
  assert.equal(scope.resolve({ $ref: 'a' }), object);
  assert.throws(() => scope.ref('b'), /Unknown identity/);
  const otherScope = createIdentityScope();
  assert.equal(otherScope.register('a', object), object);
  assert.equal(otherScope.register('b', {}), otherScope.resolve({ $ref: 'b' }));
});

test('registration accepts functions and plain objects, not other object kinds', () => {
  const scope = createIdentityScope();
  const fn = () => 'hello';
  assert.equal(scope.register('fn', fn), fn);
  assert.equal(scope.resolve(scope.ref('fn'))(), 'hello');
  const record = Object.create(null);
  assert.equal(scope.register('record', record), record);
  for (const id of ['', null, undefined, 1, Symbol('id')]) {
    assert.throws(() => scope.register(id, {}));
  }
  for (const value of [null, undefined, true, 1, 'object', [], new Date(), new Map()]) {
    assert.throws(() => scope.register('invalid', value));
  }
});

test('snapshots reject values that JSON would lose or silently transform', () => {
  const scope = createIdentityScope();
  const machine = scope.register('a', { name: 'a' });
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = Array(2);
  sparse[1] = 'last';
  const extraArray = [1];
  extraArray.extra = 2;
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const invalid = [undefined, () => {}, Symbol('value'), 1n, NaN, Infinity, -Infinity,
    cyclic, new Date(), new Map(), new Set(), /pattern/, sparse, extraArray,
    { nested: undefined }, [undefined], { [Symbol('key')]: true }, hidden,
    { get value() { return 1; } }, { toJSON() { return {}; } }];
  for (const value of invalid) {
    assert.throws(() => scope.snapshot(() => value));
    assert.equal(scope.resolve(scope.ref('a')), machine);
  }
  assert.throws(() => scope.snapshot(() => { throw new Error('projection failed'); }), /projection failed/);
  assert.deepEqual(scope.snapshot(object => ({ ...object })), [{ id: 'a', value: { name: 'a' } }]);
  assert.throws(() => scope.snapshot());
});

test('snapshots support JSON primitives, dense arrays and repeated noncyclic data', () => {
  const scope = createIdentityScope();
  scope.register('a', {});
  const shared = { value: 2 };
  const projection = { values: [null, true, false, '', 0, -3.5], left: shared, right: shared };
  assert.deepEqual(scope.snapshot(() => projection), [{ id: 'a', value: projection }]);
  assert.deepEqual(scope.snapshot(() => null), [{ id: 'a', value: null }]);
  const special = JSON.parse('{"__proto__":{"safe":true}}');
  const saved = scope.snapshot(() => special)[0].value;
  assert.equal(Object.hasOwn(saved, '__proto__'), true);
  assert.deepEqual(saved, special);
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
});

test('restore rejects malformed entries and invalid decoded identities', () => {
  const invalid = [null, {}, [null], [{}], [{ id: 'a' }], [{ value: {} }],
    [{ id: '', value: {} }], [{ id: 1, value: {} }],
    [{ id: 'a', value: {}, extra: true }], [{ id: 'a', value: undefined }],
    [{ id: 'a', value: {} }, { id: 'a', value: {} }], Array(1)];
  for (const entries of invalid) {
    assert.throws(() => restoreIdentityScope(entries, value => value));
  }
  assert.throws(() => restoreIdentityScope([], null));
  assert.throws(() => restoreIdentityScope([{ id: 'a', value: null }], value => value));
  const shared = {};
  assert.throws(() => restoreIdentityScope([
    { id: 'a', value: {} }, { id: 'b', value: {} },
  ], () => shared), /already has an identity/);
  assert.throws(() => restoreIdentityScope([{ id: 'a', value: {} }], () => {
    throw new Error('decode failed');
  }), /decode failed/);
  assert.deepEqual(restoreIdentityScope([], value => value).snapshot(value => value), []);
});

test('restore lets callers decode JSON projections into registered functions', () => {
  const scope = createIdentityScope();
  scope.register('greet', () => 'hello');
  const entries = scope.snapshot(() => ({ greeting: 'hello' }));
  const restored = restoreIdentityScope(entries, value => () => value.greeting);
  assert.equal(restored.resolve(restored.ref('greet'))(), 'hello');
  assert.notEqual(restored.resolve(restored.ref('greet')), scope.resolve(scope.ref('greet')));
});
