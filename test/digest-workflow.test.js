const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDigestWorkflow } = require('../build/digest');
const { buildErrorHandler } = require('../build/error-handler');
const { workflowConfig } = require('../build/build');
const { assertConnectionsValid } = require('../build/n8n');
const { runCodeNode, findNode } = require('./harness');

const NOW = '2026-10-13T06:00:00Z';
const cfg = { ...workflowConfig(), sheetUrl: 'https://docs.google.com/spreadsheets/d/abc' };
const digest = buildDigestWorkflow(cfg);
const errors = buildErrorHandler(cfg);

const compileAll = (wf) => {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$input', '$', 'Date', node.parameters.jsCode), `${node.name} does not compile`);
    assert.doesNotMatch(node.parameters.jsCode, /\brequire\(/, `${node.name} uses require`);
  }
};

test('digest workflow structure', () => {
  assertConnectionsValid(digest);
  compileAll(digest);
  assert.equal(digest.name, 'job-hunter-digest');
  assert.equal(digest.settings.timezone, 'Europe/Paris');
  assert.deepEqual(findNode(digest, 'Every day 08:00').parameters.rule.interval, [{ field: 'cronExpression', expression: '0 8 * * *' }]);
  assert.equal(findNode(digest, 'Read Offers').executeOnce, true);
  assert.equal(findNode(digest, 'Read Runs').parameters.sheetName.value, 'runs');
  assert.deepEqual(findNode(digest, 'Update Offers').parameters.columns.matchingColumns, ['id']);
  assert.equal(findNode(digest, 'Send Digest').parameters.sendTo, "={{ $('Config').first().json.digestEmail }}");
});

test('digest Config only carries what the digest needs', () => {
  const config = runCodeNode(findNode(digest, 'Config').parameters.jsCode)[0];
  assert.deepEqual(Object.keys(config).sort(), ['digestEmail', 'scoreThreshold', 'sheetId', 'sheetUrl']);
  assert.equal(config.digestEmail, 'you@example.com');
});

test('digest end to end: build the email, then mark rows as emailed', () => {
  const config = runCodeNode(findNode(digest, 'Config').parameters.jsCode)[0];
  const offers = [
    { id: 'a', status: 'new', score: '8', source: 'adzuna', title: 'Lead Dev', url: 'https://x/a', found_at: '2026-10-12T15:00:00.000Z' },
    { id: 'b', status: 'new', score: '4', source: 'adzuna', title: 'Other', url: 'https://x/b', found_at: '2026-10-12T15:00:00.000Z' },
  ];
  const runs = [{ run_at: '2026-10-13T05:00:00.000Z', source: 'adzuna', fetched: '10', eligible: '4', error: '' }];
  const built = runCodeNode(findNode(digest, 'Build Digest').parameters.jsCode, {
    input: runs, nodes: { Config: [config], 'Read Offers': offers }, now: NOW,
  });
  assert.equal(built.length, 1);
  assert.equal(built[0].subject, '🎯 Job digest: 1 new match (13/10)');
  assert.deepEqual(built[0].ids, ['a']);

  const marked = runCodeNode(findNode(digest, 'Mark Emailed').parameters.jsCode, {
    input: [{ id: 'gmail-msg' }], nodes: { 'Build Digest': built }, now: NOW,
  });
  assert.deepEqual(marked, [{ id: 'a', status: 'emailed', emailed_at: '2026-10-13T06:00:00.000Z' }]);
});

test('digest sends nothing when no offer qualifies or the sheet is empty', () => {
  const config = runCodeNode(findNode(digest, 'Config').parameters.jsCode)[0];
  const built = runCodeNode(findNode(digest, 'Build Digest').parameters.jsCode, {
    input: [{}], nodes: { Config: [config], 'Read Offers': [{}] }, now: NOW,
  });
  assert.deepEqual(built, []);
});

test('error handler formats and sends an alert', () => {
  assertConnectionsValid(errors);
  compileAll(errors);
  assert.equal(findNode(errors, 'On workflow error').type, 'n8n-nodes-base.errorTrigger');
  const out = runCodeNode(findNode(errors, 'Format Error').parameters.jsCode, {
    input: [{ workflow: { name: 'job-hunter-digest' }, execution: { lastNodeExecuted: 'Send Digest', error: { message: 'boom' } } }],
  });
  assert.equal(out[0].to, 'you@example.com');
  assert.equal(out[0].subject, '⚠️ n8n job hunter: job-hunter-digest failed');
  assert.equal(findNode(errors, 'Send Alert').parameters.sendTo, '={{ $json.to }}');
});
