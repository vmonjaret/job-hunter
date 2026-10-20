const test = require('node:test');
const assert = require('node:assert/strict');
const { runCodeNode, findNode } = require('./harness');

test('runCodeNode exposes $input, $() and a fixed clock', () => {
  const code = "return $input.all().map((i) => ({ json: { v: i.json.v * 2, k: $('Config').first().json.k, t: new Date().toISOString(), n: Date.now() } }));";
  const out = runCodeNode(code, { input: [{ v: 1 }, { v: 2 }], nodes: { Config: [{ k: 'x' }] }, now: '2026-10-13T10:00:00Z' });
  assert.deepEqual(out, [
    { v: 2, k: 'x', t: '2026-10-13T10:00:00.000Z', n: Date.parse('2026-10-13T10:00:00Z') },
    { v: 4, k: 'x', t: '2026-10-13T10:00:00.000Z', n: Date.parse('2026-10-13T10:00:00Z') },
  ]);
});

test('runCodeNode still parses explicit dates with a fixed clock', () => {
  const out = runCodeNode("return [{ json: { y: new Date('2020-01-02T00:00:00Z').getUTCFullYear() } }];", { now: '2026-10-13T10:00:00Z' });
  assert.deepEqual(out, [{ y: 2020 }]);
});

test('runCodeNode fails on unknown node references and non-array returns', () => {
  assert.throws(() => runCodeNode("return $('Nope').all();"), /Unknown node referenced: Nope/);
  assert.throws(() => runCodeNode('return { json: {} };'), /must return an array/);
});

test('findNode finds a node by name or throws', () => {
  const wf = { nodes: [{ name: 'A' }] };
  assert.equal(findNode(wf, 'A').name, 'A');
  assert.throws(() => findNode(wf, 'B'), /Node not found: B/);
});
