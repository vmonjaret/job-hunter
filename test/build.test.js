const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { outputs } = require('../build/build');

const ROOT = path.join(__dirname, '..');

test('generated files are up to date (run `npm run build` if this fails)', () => {
  for (const [rel, content] of Object.entries(outputs())) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing`);
    assert.equal(fs.readFileSync(file, 'utf8'), content, `${rel} is stale`);
  }
});

test('sheet headers match the schema', () => {
  const out = outputs();
  assert.equal(out['sheet/runs-header.csv'], 'run_at,source,fetched,eligible,error\n');
  assert.match(out['sheet/offers-header.csv'], /^id,source,title,company,/);
});
