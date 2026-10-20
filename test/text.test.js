const test = require('node:test');
const assert = require('node:assert/strict');
const { stripHtml, normalizeKey, dedupeKey, truncate, escapeHtml, isWithinHours } = require('../src/lib/text');

test('stripHtml removes tags, decodes entities and keeps line breaks', () => {
  assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b></p><p>Line&amp;2</p>'), 'Hello world\nLine&2');
  assert.equal(stripHtml('<strong>Tech Lead</strong> Symfony'), 'Tech Lead Symfony');
  assert.equal(stripHtml('<p>Build our <b>product</b>.</p>'), 'Build our product.');
  assert.equal(stripHtml('It&#39;s &#8217;ok&#8217;'), "It's ’ok’");
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
});

test('normalizeKey lowercases, strips accents and punctuation', () => {
  assert.equal(normalizeKey('  Développeur Full-Stack (Sénior) '), 'developpeur full stack senior');
  assert.equal(normalizeKey(null), '');
});

test('dedupeKey ignores gender markers so cross-posted offers match', () => {
  const a = dedupeKey('Acme Santé', 'Développeur Full Stack Senior PHP/Symfony (H/F)');
  const b = dedupeKey('ACME SANTE', 'Développeur Full Stack Senior PHP/Symfony H/F');
  const c = dedupeKey('Acme Santé', 'Développeur Full Stack Senior PHP/Symfony (M/W/D)');
  assert.equal(a, 'acme sante|developpeur full stack senior php symfony');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('dedupeKey is empty when the company or title is missing', () => {
  assert.equal(dedupeKey('', 'Lead Developer'), '');
  assert.equal(dedupeKey('Acme', ''), '');
});

test('truncate cuts long strings with an ellipsis', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate(null, 3), '');
});

test('escapeHtml escapes the five HTML special characters', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(8), '8');
});

test('isWithinHours compares against now and keeps unparseable dates', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  assert.equal(isWithinHours('2026-10-12T11:00:00Z', 24, now), true);
  assert.equal(isWithinHours('2026-10-12T09:00:00Z', 24, now), false);
  assert.equal(isWithinHours('not a date', 24, now), true);
  assert.equal(isWithinHours('', 24, now), true);
});
