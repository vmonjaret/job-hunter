const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { prefilter, prefilterReason } = require('../src/lib/prefilter');

const offer = (title, company = 'Acme', salaryMax = '') => ({ id: title, title, company, salary_max: salaryMax });

const cases = [
  [offer('Développeur Full Stack Senior'), ''],
  [offer('Tech Lead Symfony'), ''],
  [offer('Lead Developer International'), ''],
  [offer('Comptable'), 'title not matching'],
  [offer('Développeur Full Stack Junior'), 'title excluded'],
  [offer('Senior Python Developer'), 'title excluded'],
  [offer('Stage Développeur Full Stack'), 'title excluded'],
  [offer('Lead Developer', 'Capgemini Engineering'), 'ESN: Capgemini'],
  [offer('Lead Developer', 'Sopra Steria Group'), 'ESN: Sopra Steria'],
  [offer('Lead Developer', 'CGI France'), 'ESN: CGI'],
  [offer('Lead Developer', 'Catalana Tech'), ''],
  [offer('Lead Developer', 'Acme', 55000), 'salary below floor'],
  [offer('Lead Developer', 'Acme', '55000'), 'salary below floor'],
  [offer('Lead Developer', 'Acme', 65000), ''],
  [offer('Lead Developer', 'Acme', ''), ''],
];

for (const [o, expected] of cases) {
  test(`prefilterReason: ${o.title} @ ${o.company} (${o.salary_max})`, () => {
    assert.equal(prefilterReason(o, config), expected);
  });
}

test('prefilter splits kept and dropped offers', () => {
  const { kept, dropped } = prefilter([offer('Lead Developer'), offer('Comptable')], config);
  assert.deepEqual(kept.map((o) => o.title), ['Lead Developer']);
  assert.deepEqual(dropped.map((d) => d.reason), ['title not matching']);
});
