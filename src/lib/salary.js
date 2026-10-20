// @body
// Returns a yearly { min, max } from free-text salary, or null when there is no usable yearly amount.
function parseSalary(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).toLowerCase();
  if (!/\d/.test(s)) return null;
  if (/jour|journalier|\bday\b|daily|heure|horaire|\bhour|hourly|\/h\b|tjm/.test(s)) return null;

  let t = s.replace(/(\d)[\s  ]+(?=\d{3}(?!\d))/g, '$1'); // "55 000" -> "55000"
  t = t.replace(/(\d)[,.](?=\d{3}(?!\d))/g, '$1'); // "60,000" -> "60000"
  t = t.replace(/(\d),(\d)/g, '$1.$2'); // "35,3k" -> "35.3k"

  const values = [];
  const re = /(\d+(?:\.\d+)?)\s*(k)?/g;
  let m = re.exec(t);
  while (m) {
    let v = parseFloat(m[1]);
    if (m[2]) v *= 1000;
    if (v >= 1000) values.push(v);
    m = re.exec(t);
  }
  if (values.length === 0) return null;

  let min = Math.min(...values);
  let max = Math.max(...values);
  const monthly = /mensuel|par mois|\/ ?mois|per month|\/ ?month|monthly/.test(s);
  if (monthly || max < 15000) {
    min *= 12;
    max *= 12;
  }
  return { min: Math.round(min), max: Math.round(max) };
}
// @export
module.exports = { parseSalary };
