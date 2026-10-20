const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const {
  selectDigestRows, sourceHealth, recentStats, digestSubject, renderDigestHtml, buildDigest, formatErrorEmail,
} = require('../src/lib/digest');

const NOW = new Date('2026-10-13T06:00:00Z'); // 08:00 in Paris
const config = { ...baseConfig, sheetUrl: 'https://docs.google.com/spreadsheets/d/abc' };
const row = (id, status, score, extra = {}) => ({
  id, status, score, source: 'adzuna', title: `Job ${id}`, company: 'Acme', location: 'Paris', work_mode: 'hybrid',
  salary_raw: '', estimated_salary: '', score_reason: 'Good fit.', flags: '', url: `https://example.com/${id}`,
  published_at: '2026-10-12T08:00:00Z', found_at: '2026-10-12T15:00:00.000Z', ...extra,
});

test('selectDigestRows keeps new rows at or above the threshold, best first', () => {
  const rows = [
    row('a', 'new', '8'),
    row('b', 'new', '6'),
    row('c', 'emailed', '9'),
    row('d', 'new', ''),
    row('e', 'new', '9'),
    row('f', 'new', '0'),
    row('g', 'new', '8', { published_at: '2026-10-12T20:00:00Z' }),
    row('h', 'to_score', ''),
  ];
  assert.deepEqual(selectDigestRows(rows, 7).map((r) => r.id), ['e', 'g', 'a']);
});

test('sourceHealth summarizes the last 24h of runs per source', () => {
  const runs = [
    { run_at: '2026-10-13T05:00:00.000Z', source: 'france_travail', fetched: '12', eligible: '12', error: '' },
    { run_at: '2026-10-12T17:00:00.000Z', source: 'france_travail', fetched: '3', eligible: '3', error: '' },
    { run_at: '2026-10-13T05:00:00.000Z', source: 'adzuna', fetched: '0', eligible: '0', error: '401 Unauthorized' },
    { run_at: '2026-10-11T05:00:00.000Z', source: 'wttj', fetched: '40', eligible: '5', error: '' },
    { run_at: '2026-10-13T05:00:00.000Z', source: 'remotive', fetched: '0', eligible: '0', error: '' },
  ];
  const health = sourceHealth(runs, NOW);
  assert.deepEqual(health.map((h) => [h.source, h.runs, h.fetched, h.ok]), [
    ['france_travail', 2, 15, true],
    ['wttj', 0, 0, false],
    ['linkedin', 0, 0, false],
    ['adzuna', 1, 0, false],
    ['remotive', 1, 0, false],
    ['remoteok', 0, 0, false],
  ]);
  assert.equal(health[3].lastError, '401 Unauthorized');
  assert.deepEqual(sourceHealth(runs, NOW, ['wttj', 'remotive']).map((h) => h.source), ['wttj', 'remotive']);
  assert.equal(health[0].label, 'France Travail');
});

test('recentStats counts offers saved and scored in the last 24h', () => {
  const rows = [row('a', 'new', '8'), row('b', 'to_score', ''), row('c', 'new', '5', { found_at: '2026-10-10T10:00:00.000Z' })];
  assert.deepEqual(recentStats(rows, NOW), { collected: 2, scored: 1 });
});

test('digestSubject uses the Paris date and pluralizes', () => {
  assert.equal(digestSubject(1, NOW), '🎯 Job digest: 1 new match (13/10)');
  assert.equal(digestSubject(3, new Date('2026-10-13T22:30:00Z')), '🎯 Job digest: 3 new matches (14/10)');
});

test('renderDigestHtml escapes job data and never links unsafe URLs', () => {
  const evil = row('x', 'new', '9', { title: '<script>alert(1)</script>', company: 'Tom & Jerry', url: 'javascript:alert(1)', flags: 'far_commute,esn' });
  const html = renderDigestHtml([evil], sourceHealth([], NOW), { collected: 1, scored: 1 }, config);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Tom &amp; Jerry'));
  assert.ok(html.includes('href="#"'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('far_commute'));
});

test('renderDigestHtml shows salary, warnings, sheet link and attributions', () => {
  const rows = [
    row('a', 'new', '8', { source: 'remoteok', salary_raw: '90000-120000 USD' }),
    row('b', 'new', '7', { source: 'remotive', estimated_salary: '60-70k EUR' }),
  ];
  const runs = [{ run_at: '2026-10-13T05:00:00.000Z', source: 'adzuna', fetched: '0', eligible: '0', error: '401 Unauthorized' }];
  const html = renderDigestHtml(rows, sourceHealth(runs, NOW), { collected: 2, scored: 2 }, config);
  assert.ok(html.includes('90000-120000 USD'));
  assert.ok(html.includes('~60-70k EUR (estimated)'));
  assert.ok(html.includes('⚠️ Adzuna: error: 401 Unauthorized'));
  assert.ok(html.includes('⚠️ Welcome to the Jungle: no runs logged in 24h'));
  assert.ok(html.includes('href="https://docs.google.com/spreadsheets/d/abc"'));
  assert.ok(html.includes('Jobs via <a href="https://remoteok.com">Remote OK</a>'));
  assert.ok(html.includes('Jobs via <a href="https://remotive.com">Remotive</a>'));
  assert.ok(html.includes('score ≥ 7'));
});

test('buildDigest returns null when nothing qualifies', () => {
  assert.equal(buildDigest([row('a', 'new', '5')], [], config, NOW), null);
  assert.equal(buildDigest([], [], config, NOW), null);
});

test('buildDigest returns the subject, html and ids to mark as emailed', () => {
  const d = buildDigest([row('a', 'new', '8'), row('b', 'new', '9'), row('c', 'new', '3')], [], config, NOW);
  assert.equal(d.subject, '🎯 Job digest: 2 new matches (13/10)');
  assert.deepEqual(d.ids, ['b', 'a']);
  assert.ok(d.html.includes('Job b'));
  assert.ok(!d.html.includes('Job c'));
});

test('formatErrorEmail describes the failed workflow', () => {
  const email = formatErrorEmail({
    workflow: { id: '1', name: 'job-hunter-collector' },
    execution: { id: '42', url: 'https://n8n.example.com/execution/42', lastNodeExecuted: 'Read Offers', error: { message: 'Sheet <not> found' } },
  }, 'me@example.com');
  assert.equal(email.to, 'me@example.com');
  assert.equal(email.subject, '⚠️ n8n job hunter: job-hunter-collector failed');
  assert.ok(email.html.includes('Read Offers'));
  assert.ok(email.html.includes('Sheet &lt;not&gt; found'));
  assert.ok(email.html.includes('href="https://n8n.example.com/execution/42"'));
  assert.equal(formatErrorEmail({}, 'me@example.com').subject, '⚠️ n8n job hunter: unknown workflow failed');
});

test('sourceHealth flags a source that fetched offers but also logged an error', () => {
  const runs = [
    { run_at: '2026-10-13T05:00:00.000Z', source: 'france_travail', fetched: '12', eligible: '12', error: '' },
    { run_at: '2026-10-13T01:00:00.000Z', source: 'france_travail', fetched: '5', eligible: '5', error: '429 Too Many Requests' },
  ];
  const ft = sourceHealth(runs, NOW)[0];
  assert.equal(ft.ok, false);
  assert.equal(ft.lastError, '429 Too Many Requests');
});
