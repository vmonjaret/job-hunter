const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { OFFER_COLUMNS, SOURCES } = require('../src/lib/schema');
const { buildCollector } = require('../build/collector');
const { workflowConfig } = require('../build/build');
const { assertConnectionsValid } = require('../build/n8n');
const { runCodeNode, findNode } = require('./harness');

const NOW = '2026-10-13T10:00:00Z';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const cfg = { ...workflowConfig(), enabledSources: SOURCES, wttj: { indexName: 'wttj_jobs' } };
const WTTJ_ENV = { data: 'window.env = {"PUBLIC_ALGOLIA_API_KEY_CLIENT":"KEY","PUBLIC_ALGOLIA_APPLICATION_ID":"APP"};' };
const wf = buildCollector(cfg);
const code = (name) => findNode(wf, name).parameters.jsCode;
const config = runCodeNode(code('Config'))[0];
const run = (name, input, nodes = {}) => runCodeNode(code(name), { input, nodes: { Config: [config], ...nodes }, now: NOW });

test('workflow structure is valid', () => {
  assertConnectionsValid(wf);
  assert.equal(wf.name, 'job-hunter-collector');
  assert.equal(wf.settings.timezone, 'Europe/Paris');
  assert.equal(wf.settings.executionOrder, 'v1');
  const names = wf.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length);
});

test('every Code node compiles and has no require()', () => {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$input', '$', 'Date', node.parameters.jsCode), `${node.name} does not compile`);
    assert.doesNotMatch(node.parameters.jsCode, /\brequire\(/, `${node.name} uses require`);
  }
});

test('the schedule runs 4 times a day', () => {
  assert.deepEqual(findNode(wf, 'Every 4 hours').parameters.rule.interval, [{ field: 'cronExpression', expression: '0 7,11,15,19 * * *' }]);
});

test('sources feed the merge in a fixed order', () => {
  const order = ['FT Normalize', 'WTTJ Normalize', 'LinkedIn Normalize', 'Adzuna Normalize', 'Remotive Normalize', 'RemoteOK Normalize'];
  order.forEach((name, input) => {
    assert.deepEqual(wf.connections[name].main[0], [{ node: 'Merge Sources', type: 'main', index: input }]);
  });
  assert.equal(findNode(wf, 'Merge Sources').parameters.numberInputs, 6);
});

test('only enabled sources are built', () => {
  const partial = buildCollector({ ...cfg, enabledSources: ['remoteok', 'wttj'] });
  assertConnectionsValid(partial);
  const names = partial.nodes.map((n) => n.name);
  assert.ok(!names.some((n) => /^(FT|Adzuna|LinkedIn|Remotive) /.test(n)));
  assert.deepEqual(partial.connections['WTTJ Normalize'].main[0], [{ node: 'Merge Sources', type: 'main', index: 0 }]);
  assert.deepEqual(partial.connections['RemoteOK Normalize'].main[0], [{ node: 'Merge Sources', type: 'main', index: 1 }]);
  assert.equal(findNode(partial, 'Merge Sources').parameters.numberInputs, 2);
  assert.throws(() => buildCollector({ ...cfg, enabledSources: ['wttj', 'indeed'] }), /Unknown sources in enabledSources: indeed/);
  assert.throws(() => buildCollector({ ...cfg, enabledSources: ['wttj'] }), /at least 2 sources/);
});

test('the default config leaves France Travail and Adzuna out', () => {
  const names = buildCollector(workflowConfig()).nodes.map((n) => n.name);
  assert.ok(names.includes('LinkedIn Search'));
  assert.ok(!names.includes('FT Search'));
  assert.ok(!names.includes('Adzuna Search'));
});

test('LinkedIn fetches throttled guest pages and only the job pages it needs', () => {
  const search = findNode(wf, 'LinkedIn Search');
  assert.equal(search.parameters.url, 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  const query = Object.fromEntries(search.parameters.queryParameters.parameters.map((p) => [p.name, p.value]));
  assert.equal(query.f_TPR, 'r86400');
  assert.equal(query.f_JT, 'F');
  for (const name of ['LinkedIn Search', 'LinkedIn Job']) {
    const node = findNode(wf, name);
    assert.equal(node.parameters.options.batching.batch.batchSize, 1, name);
    assert.equal(node.parameters.options.response.response.responseFormat, 'text', name);
    assert.match(node.parameters.headerParameters.parameters[0].value, /^Mozilla\/5\.0/, name);
  }
  assert.equal(findNode(wf, 'LinkedIn Known Offers').executeOnce, true);
  assert.equal(findNode(wf, 'LinkedIn Pick').alwaysOutputData, true);
  assert.deepEqual(wf.connections['LinkedIn Pick'].main[0], [{ node: 'LinkedIn Job', type: 'main', index: 0 }]);

  const queries = run('LinkedIn Queries', []);
  assert.equal(queries.length, config.keywords.length * config.linkedinPages);
  assert.deepEqual(queries.slice(0, 2), [{ keywords: config.keywords[0], start: 0 }, { keywords: config.keywords[0], start: 10 }]);

  const searches = [{ data: fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-search.html'), 'utf8') }];
  const picks = run('LinkedIn Pick', [{ id: 'linkedin:4469956025' }], { 'LinkedIn Search': searches });
  assert.deepEqual(picks.map((p) => p.id), ['4472473881', '4404321448']);
  const job = { data: fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-job.html'), 'utf8') };
  const out = run('LinkedIn Normalize', [{ error: { message: '429 - Too Many Requests' } }, job], { 'LinkedIn Search': searches, 'LinkedIn Pick': picks });
  assert.deepEqual(out[0]._status, { source: 'linkedin', fetched: 3, eligible: 1, error: '429 - Too Many Requests' });
  assert.equal(out[1].id, 'linkedin:4404321448');

  const empty = run('LinkedIn Normalize', [{ error: { message: 'Invalid URL' } }], { 'LinkedIn Search': searches, 'LinkedIn Pick': [{}] });
  assert.deepEqual(empty, [{ _status: { source: 'linkedin', fetched: 3, eligible: 0, error: '' } }]);
});

test('fetch nodes keep going on errors', () => {
  for (const name of ['FT Search', 'WTTJ Env', 'WTTJ Search', 'LinkedIn Search', 'LinkedIn Job', 'Adzuna Search', 'Remotive Fetch', 'RemoteOK Fetch', 'Score Offer']) {
    const node = findNode(wf, name);
    assert.equal(node.onError, 'continueRegularOutput', name);
    assert.equal(node.alwaysOutputData, true, name);
  }
});

test('Score Offer calls the Claude API with the right headers and credential', () => {
  const node = findNode(wf, 'Score Offer');
  assert.equal(node.parameters.url, 'https://api.anthropic.com/v1/messages');
  const headers = Object.fromEntries(node.parameters.headerParameters.parameters.map((p) => [p.name, p.value]));
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.deepEqual(node.credentials, { httpHeaderAuth: { name: 'Anthropic API Key' } });
  assert.equal(node.parameters.jsonBody, '={{ JSON.stringify($json.claudeRequest) }}');
});

test('credentials use the documented names', () => {
  assert.deepEqual(findNode(wf, 'FT Search').credentials, { oAuth2Api: { name: 'France Travail OAuth2' } });
  assert.deepEqual(findNode(wf, 'Adzuna Search').credentials, { httpCustomAuth: { name: 'Adzuna API' } });
  for (const name of ['Read Offers', 'Append Offers', 'Update Offers', 'Append Run Log']) {
    assert.deepEqual(findNode(wf, name).credentials, { googleSheetsOAuth2Api: { name: 'Google Sheets account' } }, name);
  }
  assert.deepEqual(findNode(wf, 'Update Offers').parameters.columns.matchingColumns, ['id']);
  assert.equal(findNode(wf, 'Read Offers').executeOnce, true);
});

test('Config carries the system prompt and settings', () => {
  assert.match(config.systemPrompt, /^You score job offers for one candidate\./);
  assert.equal(config.claudeModel, 'claude-opus-5-5');
  assert.equal(config.wttj.indexName, 'wttj_jobs');
});

test('query nodes emit one item per keyword', () => {
  assert.deepEqual(run('FT Queries', []), config.keywords.map((k) => ({ motsCles: k })));
  assert.deepEqual(run('Adzuna Queries', []), config.keywords.map((k) => ({ what: k })));
  const wttj = run('WTTJ Queries', [WTTJ_ENV]);
  assert.equal(wttj.length, config.keywords.length);
  assert.equal(wttj[0].appId, 'APP');
  assert.equal(wttj[0].apiKey, 'KEY');
  assert.deepEqual(wttj[0].body, { requests: [{ indexName: 'wttj_jobs', params: `query=${encodeURIComponent(config.keywords[0])}&hitsPerPage=100` }] });
});

test('WTTJ reads its Algolia keys from the website on every run', () => {
  const env = findNode(wf, 'WTTJ Env');
  assert.equal(env.parameters.url, 'https://www.welcometothejungle.com/api/env');
  assert.equal(env.parameters.options.response.response.responseFormat, 'text');
  assert.deepEqual(wf.connections.Config.main[0].filter((c) => c.node.startsWith('WTTJ')), [{ node: 'WTTJ Env', type: 'main', index: 0 }]);
  assert.deepEqual(wf.connections['WTTJ Env'].main[0], [{ node: 'WTTJ Queries', type: 'main', index: 0 }]);
  const search = findNode(wf, 'WTTJ Search');
  assert.match(search.parameters.url, /\$json\.appId/);
  const failed = run('WTTJ Normalize', [fixture('wttj.json')], { 'WTTJ Env': [{ error: { message: '403' } }] });
  assert.match(failed[0]._status.error, /Algolia keys/);
});

test('end to end: normalize, prepare, score and split rows', () => {
  const merged = [
    ...run('FT Normalize', [fixture('france-travail.json')]),
    ...run('WTTJ Normalize', [fixture('wttj.json')], { 'WTTJ Env': [WTTJ_ENV] }),
    ...run('Adzuna Normalize', [fixture('adzuna.json')]),
    ...run('Remotive Normalize', [fixture('remotive.json')]),
    ...run('RemoteOK Normalize', fixture('remoteok.json')),
  ];
  assert.equal(merged.filter((m) => m._status).length, 5);

  const log = run('Log Run', merged);
  assert.deepEqual(log.map((l) => l.source), ['france_travail', 'wttj', 'adzuna', 'remotive', 'remoteok']);

  const sheetRows = [
    { id: 'remotive:1680001', status: 'emailed', dedupe_key: 'eta labs|senior react full stack developer', row_number: 2 },
    { id: 'adzuna:999', status: 'to_score', source: 'adzuna', title: 'Senior PHP Developer', company: 'Old Co', score_attempts: 1, row_number: 3 },
  ];
  const prepared = run('Prepare', sheetRows, { 'Merge Sources': merged });
  assert.deepEqual(prepared.map((p) => [p.op, p.row.id]), [
    ['update', 'adzuna:999'],
    ['append', 'france_travail:201ABCD'],
    ['append', 'wttj:WTTJ-REF-1'],
    ['append', 'adzuna:4870000001'],
    ['append', 'remoteok:1137500'],
  ]);

  const ok = fixture('claude-response.json');
  const applied = run('Apply Scores', [ok, ok, { error: { message: 'timeout' } }, ok, ok], { Prepare: prepared });
  const appendRows = run('New Rows', applied);
  const updateRows = run('Retried Rows', applied);
  assert.equal(appendRows.length, 4);
  assert.equal(updateRows.length, 1);
  assert.deepEqual(Object.keys(appendRows[0]), OFFER_COLUMNS);
  assert.equal(appendRows[0].status, 'new');
  assert.equal(appendRows[1].status, 'to_score');
  assert.equal(updateRows[0].id, 'adzuna:999');
  assert.equal(updateRows[0].score_attempts, 2);
});

test('end to end: first run on an empty sheet', () => {
  const merged = run('Adzuna Normalize', [fixture('adzuna.json')]);
  const prepared = run('Prepare', [{}], { 'Merge Sources': merged });
  assert.deepEqual(prepared.map((p) => p.row.id), ['adzuna:4870000001', 'adzuna:4870000002']);
});

test('Sheets writes store values as raw text (no date or formula parsing)', () => {
  for (const name of ['Append Offers', 'Update Offers', 'Append Run Log']) {
    assert.equal(findNode(wf, name).parameters.options.cellFormat, 'RAW', name);
  }
});

test('Score Offer does not retry the whole node (failed offers are retried on the next run)', () => {
  assert.equal(findNode(wf, 'Score Offer').retryOnFail, false);
});
