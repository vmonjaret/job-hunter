const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSalary } = require('../src/lib/salary');

const cases = [
  ['Annuel de 55000.00 Euros à 65000.00 Euros sur 12 mois', { min: 55000, max: 65000 }],
  ['Annuel de 60000,00 Euros sur 12 mois', { min: 60000, max: 60000 }],
  ['Mensuel de 4500.00 Euros sur 12 mois', { min: 54000, max: 54000 }],
  ['$35,3k- $52k', { min: 35300, max: 52000 }],
  ['€70k - €85k', { min: 70000, max: 85000 }],
  ['55 000 € - 65 000 €', { min: 55000, max: 65000 }],
  ['€60,000 - €75,000', { min: 60000, max: 75000 }],
  ['4 000 € par mois', { min: 48000, max: 48000 }],
  ['500€ par jour', null],
  ['TJM 600 €/jour', null],
  ['Selon profil', null],
  ['Autre', null],
  ['', null],
  [null, null],
  [undefined, null],
];

for (const [input, expected] of cases) {
  test(`parseSalary(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseSalary(input), expected);
  });
}
