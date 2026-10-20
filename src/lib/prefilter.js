const { normalizeKey } = require('./text');
// @body
function prefilterReason(offer, config) {
  if (!new RegExp(config.titleIncludeRegex, 'i').test(offer.title)) return 'title not matching';
  if (new RegExp(config.titleExcludeRegex, 'i').test(offer.title)) return 'title excluded';
  const company = ` ${normalizeKey(offer.company)} `;
  const esn = config.esnBlocklist.find((name) => company.includes(` ${normalizeKey(name)} `));
  if (esn) return `ESN: ${esn}`;
  const max = offer.salary_max;
  if (max !== '' && max !== null && max !== undefined && Number(max) < config.salaryFloor) return 'salary below floor';
  return '';
}

function prefilter(offers, config) {
  const kept = [];
  const dropped = [];
  for (const offer of offers) {
    const reason = prefilterReason(offer, config);
    if (reason) dropped.push({ offer, reason });
    else kept.push(offer);
  }
  return { kept, dropped };
}
// @export
module.exports = { prefilter, prefilterReason };
