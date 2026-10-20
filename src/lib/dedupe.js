// @body
function dedupe(offers, existingRows) {
  const ids = new Set(existingRows.filter((r) => r.id).map((r) => String(r.id)));
  const keys = new Set(existingRows.map((r) => r.dedupe_key).filter(Boolean));
  const out = [];
  for (const offer of offers) {
    if (ids.has(offer.id)) continue;
    if (offer.dedupe_key && keys.has(offer.dedupe_key)) continue;
    ids.add(offer.id);
    if (offer.dedupe_key) keys.add(offer.dedupe_key);
    out.push(offer);
  }
  return out;
}
// @export
module.exports = { dedupe };
