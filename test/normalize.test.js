const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { OFFER_COLUMNS, RUN_COLUMNS, SOURCES, pickColumns } = require('../src/lib/schema');
const { normalizeResponses, parseWttjEnv, normalizeLinkedin } = require('../src/lib/normalize');
const html = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const NOW = new Date('2026-10-13T10:00:00Z');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const wttjConfig = { ...baseConfig, wttj: { appId: 'APP', apiKey: 'KEY', indexName: 'wttj_jobs' } };

test('schema columns', () => {
  assert.deepEqual(OFFER_COLUMNS, [
    'id', 'source', 'title', 'company', 'location', 'work_mode', 'contract',
    'salary_min', 'salary_max', 'salary_raw', 'estimated_salary', 'url',
    'published_at', 'found_at', 'score', 'score_reason', 'flags', 'status',
    'score_attempts', 'emailed_at', 'notes', 'dedupe_key',
  ]);
  assert.deepEqual(RUN_COLUMNS, ['run_at', 'source', 'fetched', 'eligible', 'error']);
  assert.deepEqual(SOURCES, ['france_travail', 'wttj', 'linkedin', 'adzuna', 'remotive', 'remoteok']);
});

test('pickColumns keeps only sheet columns and blanks missing values', () => {
  const row = pickColumns({ id: 'a', title: 'T', row_number: 4, description: 'x', score: null });
  assert.deepEqual(Object.keys(row), OFFER_COLUMNS);
  assert.equal(row.id, 'a');
  assert.equal(row.score, '');
  assert.equal(row.notes, '');
});

test('france travail offers are mapped', () => {
  const { offers, status } = normalizeResponses('france_travail', [fixture('france-travail.json')], baseConfig, NOW);
  assert.deepEqual(status, { source: 'france_travail', fetched: 3, eligible: 3, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'france_travail:201ABCD');
  assert.equal(o.source, 'france_travail');
  assert.equal(o.title, 'Développeur Full Stack Senior PHP/Symfony (H/F)');
  assert.equal(o.company, 'Acme Santé');
  assert.equal(o.location, '75 - Paris 9e Arrondissement');
  assert.equal(o.work_mode, 'unknown');
  assert.equal(o.contract, 'CDI');
  assert.equal(o.salary_min, 60000);
  assert.equal(o.salary_max, 70000);
  assert.equal(o.salary_raw, 'Annuel de 60000.00 Euros à 70000.00 Euros sur 12 mois');
  assert.equal(o.url, 'https://candidat.francetravail.fr/offres/recherche/detail/201ABCD');
  assert.equal(o.published_at, '2026-10-12T09:15:00.000Z');
  assert.equal(o.found_at, '2026-10-13T10:00:00.000Z');
  assert.equal(o.dedupe_key, 'acme sante|developpeur full stack senior php symfony');
  assert.match(o.description, /PHP 8, Symfony, React/);
  assert.equal(offers[1].url, 'https://candidat.francetravail.fr/offres/recherche/detail/201EFGH');
  assert.equal(offers[2].salary_min, '');
  for (const col of OFFER_COLUMNS) assert.ok(col in o, `missing column ${col}`);
});

test('adzuna offers are mapped and predicted salaries are not used for filtering', () => {
  const { offers, status } = normalizeResponses('adzuna', [fixture('adzuna.json')], baseConfig, NOW);
  assert.deepEqual(status, { source: 'adzuna', fetched: 2, eligible: 2, error: '' });
  assert.equal(offers[0].id, 'adzuna:4870000001');
  assert.equal(offers[0].title, 'Tech Lead Symfony');
  assert.equal(offers[0].salary_min, 65000);
  assert.equal(offers[0].salary_max, 75000);
  assert.equal(offers[0].contract, 'permanent full_time');
  assert.equal(offers[0].url, 'https://www.adzuna.fr/details/4870000001');
  assert.equal(offers[1].salary_min, '');
  assert.equal(offers[1].salary_max, '');
  assert.equal(offers[1].salary_raw, 'Adzuna estimate: 52000-52000 EUR');
  assert.equal(offers[1].dedupe_key, 'acme sante|developpeur full stack senior php symfony');
});

test('parseWttjEnv reads the Algolia keys from the WTTJ /api/env script', () => {
  const env = 'window.env = {"PUBLIC_ALGOLIA_API_KEY_CLIENT":"abc123","PUBLIC_WTTJ_URL":"https://x","PUBLIC_ALGOLIA_APPLICATION_ID":"CSEKHVMS53"};';
  assert.deepEqual(parseWttjEnv(env), { appId: 'CSEKHVMS53', apiKey: 'abc123' });
  assert.deepEqual(parseWttjEnv('<html>blocked</html>'), { appId: '', apiKey: '' });
  assert.deepEqual(parseWttjEnv(undefined), { appId: '', apiKey: '' });
});

test('wttj reports an error when the Algolia keys are missing', () => {
  const { offers, status } = normalizeResponses('wttj', [fixture('wttj.json')], baseConfig, NOW);
  assert.equal(offers.length, 0);
  assert.match(status.error, /Algolia keys/);
});

test('wttj keeps recent full-time offers in France or fully remote', () => {
  const { offers, status } = normalizeResponses('wttj', [fixture('wttj.json')], wttjConfig, NOW);
  assert.deepEqual(status, { source: 'wttj', fetched: 3, eligible: 1, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'wttj:WTTJ-REF-1');
  assert.equal(o.company, 'Delta Health');
  assert.equal(o.location, 'Paris');
  assert.equal(o.work_mode, 'hybrid');
  assert.equal(o.salary_min, 65000);
  assert.equal(o.salary_max, 80000);
  assert.equal(o.url, 'https://www.welcometothejungle.com/fr/companies/delta-health/jobs/senior-fullstack-engineer_paris');
  assert.equal(o.description, 'Event-driven architecture with Kafka.');
});

test('remotive keeps recent software jobs open to Europe', () => {
  const { offers, status } = normalizeResponses('remotive', [fixture('remotive.json')], baseConfig, NOW);
  assert.deepEqual(status, { source: 'remotive', fetched: 3, eligible: 1, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'remotive:1680001');
  assert.equal(o.work_mode, 'remote');
  assert.equal(o.location, 'Europe');
  assert.equal(o.published_at, '2026-10-11T20:17:27Z');
  assert.equal(o.salary_min, 70000);
  assert.equal(o.salary_max, 85000);
  assert.equal(o.description, 'Build our product.');
});

test('remoteok gives the same result whether n8n splits the array or not', () => {
  const asArray = normalizeResponses('remoteok', [fixture('remoteok.json')], baseConfig, NOW);
  const asItems = normalizeResponses('remoteok', fixture('remoteok.json'), baseConfig, NOW);
  assert.deepEqual(asItems, asArray);
  assert.deepEqual(asItems.status, { source: 'remoteok', fetched: 2, eligible: 1, error: '' });
  const o = asItems.offers[0];
  assert.equal(o.id, 'remoteok:1137500');
  assert.equal(o.title, 'Senior Full Stack Engineer');
  assert.equal(o.salary_raw, '90000-120000 USD');
  assert.equal(o.work_mode, 'remote');
});

test('HTTP error items are reported in the status', () => {
  const one = normalizeResponses('adzuna', [{ error: { message: '401 Unauthorized' } }], baseConfig, NOW);
  assert.deepEqual(one.status, { source: 'adzuna', fetched: 0, eligible: 0, error: '401 Unauthorized' });
  const two = normalizeResponses('adzuna', [{ error: 'timeout' }, { error: 'timeout' }, fixture('adzuna.json')], baseConfig, NOW);
  assert.equal(two.status.error, '2 requests failed: timeout');
  assert.equal(two.offers.length, 2);
});

test('an empty France Travail response (HTTP 204) gives no offers and no error', () => {
  const { offers, status } = normalizeResponses('france_travail', [{}], baseConfig, NOW);
  assert.equal(offers.length, 0);
  assert.deepEqual(status, { source: 'france_travail', fetched: 0, eligible: 0, error: '' });
});

test('duplicate offers within one source are kept once', () => {
  const ft = fixture('france-travail.json');
  const { offers } = normalizeResponses('france_travail', [ft, ft], baseConfig, NOW);
  assert.equal(offers.length, 3);
});

test('an n8n error item without a message still gives a readable error', () => {
  const { status } = normalizeResponses('remotive', [{ error: { level: 'warning', shouldReport: false, tags: {} } }], baseConfig, NOW);
  assert.match(status.error, /^request failed \(n8n recorded no details/);
});

test('normalizeLinkedin builds offers from the cards and their job pages', () => {
  const search = { data: html('linkedin-search.html') };
  const card = { id: '4404321448', title: 'Lead Software Engineer - CDI Paris - Theodo Healthtech', company: 'Theodo', location: 'Greater Paris Metropolitan Region', published_at: '2026-10-14' };
  const { offers, status } = normalizeLinkedin([search, search], [card], [{ data: html('linkedin-job.html') }], NOW);
  assert.deepEqual(status, { source: 'linkedin', fetched: 3, eligible: 1, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'linkedin:4404321448');
  assert.equal(o.url, 'https://www.linkedin.com/jobs/view/4404321448/');
  assert.equal(o.company, 'Theodo');
  assert.equal(o.contract, 'Full-time');
  assert.equal(o.published_at, '2026-10-14');
  assert.match(o.description, /^L’histoire du groupe Theodo/);
  assert.equal(o.dedupe_key, 'theodo|lead software engineer cdi paris theodo healthtech');
  const contract = { data: html('linkedin-job.html').replace('Full-time', 'Contract') };
  assert.deepEqual(normalizeLinkedin([search], [card], [contract], NOW).status, { source: 'linkedin', fetched: 3, eligible: 0, error: '' });
});

test('normalizeLinkedin leaves out job pages that failed and reports them', () => {
  const card = (id) => ({ id, title: 'Tech Lead', company: 'Acme', location: 'Paris', published_at: '' });
  const { offers, status } = normalizeLinkedin(
    [{ data: html('linkedin-search.html') }, { error: { message: '429 - Too Many Requests' } }],
    [card('1'), card('2')],
    [{ error: { message: '429 - Too Many Requests' } }, { data: '<html></html>' }],
    NOW,
  );
  assert.equal(offers.length, 0);
  assert.deepEqual(status, { source: 'linkedin', fetched: 3, eligible: 0, error: '3 requests failed: 429 - Too Many Requests' });
});
