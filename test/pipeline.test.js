const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { OFFER_COLUMNS, RUN_COLUMNS } = require('../src/lib/schema');
const { pickLinkedinCards, prepareCollectorRun, applyScores, buildRunLog } = require('../src/lib/pipeline');

const config = { ...baseConfig, systemPrompt: 'SYS' };
const okResponse = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-response.json'), 'utf8'));
const status = (source) => ({ _status: { source, fetched: 3, eligible: 2, error: '' } });
const offer = (id, title, extra = {}) => ({
  id, source: 'adzuna', title, company: 'Acme', location: 'Paris', work_mode: 'unknown', contract: 'CDI',
  salary_min: '', salary_max: '', salary_raw: '', url: `https://x/${id}`, dedupe_key: `acme|${id}`,
  found_at: '2026-10-13T10:00:00.000Z', description: 'desc', ...extra,
});

test('prepareCollectorRun retries to_score rows first, then new offers that pass the filters', () => {
  const fetched = [status('adzuna'), offer('adzuna:1', 'Lead Developer'), offer('adzuna:2', 'Développeur Junior'), offer('adzuna:3', 'Tech Lead')];
  const rows = [
    { id: 'adzuna:3', status: 'new', dedupe_key: 'acme|adzuna:3' },
    { id: 'old:1', status: 'to_score', title: 'Senior PHP Developer', source: 'adzuna', score_attempts: '1', row_number: 5 },
  ];
  const items = prepareCollectorRun(fetched, rows, config);
  assert.deepEqual(items.map((i) => [i.op, i.row.id]), [['update', 'old:1'], ['append', 'adzuna:1']]);

  const [retry, fresh] = items;
  assert.equal(retry.noDescription, true);
  assert.equal('row_number' in retry.row, false);
  assert.match(retry.claudeRequest.messages[0].content, /Description: \(not available/);

  assert.deepEqual(Object.keys(fresh.row), OFFER_COLUMNS);
  assert.equal(fresh.row.status, 'to_score');
  assert.equal(fresh.row.score_attempts, 0);
  assert.equal(fresh.noDescription, false);
  assert.equal('description' in fresh.row, false);
  assert.match(fresh.claudeRequest.messages[0].content, /Description:\ndesc/);
});

test('prepareCollectorRun caps the number of retried rows', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `r:${i}`, status: 'to_score', title: 'T' }));
  assert.equal(prepareCollectorRun([], rows, config).length, 50);
});

test('prepareCollectorRun works on an empty sheet (one empty item from n8n)', () => {
  const items = prepareCollectorRun([status('adzuna'), offer('adzuna:1', 'Lead Developer')], [{}], config);
  assert.deepEqual(items.map((i) => i.op), ['append']);
});

test('applyScores writes successful scores', () => {
  const [item] = prepareCollectorRun([offer('adzuna:1', 'Lead Developer')], [], config);
  const [{ op, row }] = applyScores([item], [okResponse()], config);
  assert.equal(op, 'append');
  assert.equal(row.status, 'new');
  assert.equal(row.score, 8);
  assert.equal(row.score_reason, 'Senior Symfony full stack role with 2 remote days at a product company.');
  assert.equal(row.flags, '');
  assert.equal(row.work_mode, 'hybrid');
  assert.equal(row.estimated_salary, '60-70k EUR');
  assert.equal(row.score_attempts, 1);
});

test('applyScores notes when an offer was scored without its description', () => {
  const [item] = prepareCollectorRun([], [{ id: 'old:1', status: 'to_score', title: 'T', score_attempts: '1' }], config);
  const [{ op, row }] = applyScores([item], [okResponse()], config);
  assert.equal(op, 'update');
  assert.match(row.score_reason, /\(scored without description\)$/);
  assert.equal(row.score_attempts, 2);
});

test('applyScores keeps failed offers for a retry, then gives up after 3 attempts', () => {
  const [fresh] = prepareCollectorRun([offer('adzuna:1', 'Lead Developer')], [], config);
  const [{ row: first }] = applyScores([fresh], [{ error: { message: 'timeout' } }], config);
  assert.equal(first.status, 'to_score');
  assert.equal(first.score, '');
  assert.equal(first.score_reason, 'scoring failed: timeout');
  assert.equal(first.score_attempts, 1);

  const [retry] = prepareCollectorRun([], [{ ...first, score_attempts: '2' }], config);
  const [{ row: last }] = applyScores([retry], [{ error: 'timeout' }], config);
  assert.equal(last.status, 'score_failed');
  assert.equal(last.score_attempts, 3);
});

test('applyScores throws when responses do not line up with prepared items', () => {
  const items = prepareCollectorRun([offer('adzuna:1', 'Lead Developer')], [], config);
  assert.throws(() => applyScores(items, [], config), /1 prepared items but 0 responses/);
});

test('buildRunLog turns status items into run rows', () => {
  const log = buildRunLog([status('adzuna'), offer('adzuna:1', 'Lead'), status('wttj')], new Date('2026-10-13T10:00:00Z'));
  assert.deepEqual(log, [
    { run_at: '2026-10-13T10:00:00.000Z', source: 'adzuna', fetched: 3, eligible: 2, error: '' },
    { run_at: '2026-10-13T10:00:00.000Z', source: 'wttj', fetched: 3, eligible: 2, error: '' },
  ]);
  assert.deepEqual(Object.keys(log[0]), RUN_COLUMNS);
});

test('pickLinkedinCards keeps new cards that pass the pre-filter, up to the cap', () => {
  const search = { data: fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-search.html'), 'utf8') };
  const now = new Date('2026-10-14T10:00:00Z');
  const ids = (cards) => cards.map((c) => c.id);
  assert.deepEqual(ids(pickLinkedinCards([search, search, { error: { message: '429' } }], [], config, now)), ['4469956025', '4472473881', '4404321448']);
  assert.deepEqual(ids(pickLinkedinCards([search], [{ id: 'linkedin:4469956025' }, {}], config, now)), ['4472473881', '4404321448']);
  assert.deepEqual(ids(pickLinkedinCards([search], [], { ...config, esnBlocklist: ['Theodo'] }, now)), ['4469956025']);
  assert.deepEqual(ids(pickLinkedinCards([search], [], { ...config, linkedinMaxDetails: 1 }, now)), ['4469956025']);
  assert.equal(pickLinkedinCards([search], [], config, now)[0].company, 'Cegid');
});
