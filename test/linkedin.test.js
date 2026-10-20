const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseLinkedinCards, parseLinkedinDetail } = require('../src/lib/linkedin');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parseLinkedinCards reads the job cards of a guest search page', () => {
  const cards = parseLinkedinCards(fixture('linkedin-search.html'));
  assert.equal(cards.length, 3);
  assert.deepEqual(cards[0], {
    id: '4469956025',
    title: 'Lead developper Fullstack- F/H/NB',
    company: 'Cegid',
    location: 'Boulogne-Billancourt, Île-de-France, France',
    published_at: '2026-10-13',
  });
  assert.equal(cards[2].id, '4404321448');
  assert.equal(cards[2].company, 'Theodo');
});

test('parseLinkedinCards returns nothing for an empty or blocked page', () => {
  assert.deepEqual(parseLinkedinCards(''), []);
  assert.deepEqual(parseLinkedinCards(undefined), []);
  assert.deepEqual(parseLinkedinCards('<html>429</html>'), []);
});

test('parseLinkedinDetail reads the description and criteria of a job page', () => {
  const detail = parseLinkedinDetail(fixture('linkedin-job.html'));
  assert.match(detail.description, /^L’histoire du groupe Theodo/);
  assert.ok(detail.description.length > 3000);
  assert.doesNotMatch(detail.description, /<[a-z]/i);
  assert.equal(detail.employment_type, 'Full-time');
  assert.equal(detail.seniority, 'Mid-Senior level');
  assert.deepEqual(parseLinkedinDetail(''), { description: '', employment_type: '', seniority: '' });
});
