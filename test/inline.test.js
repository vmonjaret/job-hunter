const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBody, LIBS } = require('../build/inline');

test('extractBody returns the code between the markers', () => {
  const source = "const { a } = require('./a');\n// @body\nfunction b() { return a(); }\n// @export\nmodule.exports = { b };\n";
  assert.equal(extractBody(source, 'b'), 'function b() { return a(); }');
});

test('extractBody throws when a marker is missing', () => {
  assert.throws(() => extractBody('function x() {}\n// @export\n', 'x'), /x: missing \/\/ @body or \/\/ @export marker/);
  assert.throws(() => extractBody('// @body\nfunction x() {}\n', 'x'), /x: missing/);
});

test('LIBS lists the libraries in dependency order', () => {
  assert.deepEqual(LIBS, ['schema', 'text', 'salary', 'linkedin', 'normalize', 'dedupe', 'prefilter', 'scoring', 'pipeline', 'digest']);
});
