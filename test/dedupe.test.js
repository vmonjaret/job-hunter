const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupe } = require('../src/lib/dedupe');

const offer = (id, key) => ({ id, dedupe_key: key });

test('drops offers whose id is already in the sheet', () => {
  const out = dedupe([offer('a:1', 'k1'), offer('a:2', 'k2')], [{ id: 'a:1', dedupe_key: 'other' }]);
  assert.deepEqual(out.map((o) => o.id), ['a:2']);
});

test('drops offers whose dedupe key is already in the sheet (cross-posted)', () => {
  const out = dedupe([offer('b:9', 'acme|dev')], [{ id: 'a:1', dedupe_key: 'acme|dev' }]);
  assert.deepEqual(out, []);
});

test('keeps the first of two duplicates in the same batch', () => {
  const out = dedupe([offer('a:1', 'k'), offer('b:1', 'k'), offer('a:1', 'z')], []);
  assert.deepEqual(out.map((o) => o.id), ['a:1']);
});

test('offers without a dedupe key are only deduped by id', () => {
  const out = dedupe([offer('a:1', ''), offer('b:1', '')], [{ id: 'c:1', dedupe_key: '' }]);
  assert.deepEqual(out.map((o) => o.id), ['a:1', 'b:1']);
});

test('works with an empty sheet and ignores empty rows', () => {
  assert.deepEqual(dedupe([offer('a:1', 'k')], [{}]).map((o) => o.id), ['a:1']);
});
