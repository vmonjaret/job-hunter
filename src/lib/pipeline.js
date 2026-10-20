const { pickColumns } = require('./schema');
const { dedupe } = require('./dedupe');
const { prefilter } = require('./prefilter');
const { buildScoringRequest, parseScoringResponse } = require('./scoring');
const { parseLinkedinCards } = require('./linkedin');
const { linkedinCardOffer } = require('./normalize');
// @body
// LinkedIn job pages are fetched one by one and get rate-limited, so only fetch new cards that pass the pre-filter.
function pickLinkedinCards(searchResponses, existingRows, config, now) {
  const cards = new Map();
  for (const response of searchResponses) {
    for (const card of parseLinkedinCards(response && response.data)) {
      if (!cards.has(card.id)) cards.set(card.id, card);
    }
  }
  const offers = [...cards.values()].map((card) => linkedinCardOffer(card, now.toISOString()));
  const { kept } = prefilter(dedupe(offers, existingRows.filter((r) => r && r.id)), config);
  return kept.slice(0, config.linkedinMaxDetails).map((o) => cards.get(o.id.slice('linkedin:'.length)));
}

function prepareCollectorRun(fetched, existingRows, config) {
  const rows = existingRows.filter((r) => r && r.id);
  const offers = fetched.filter((f) => !f._status && f.id);
  const retryRows = rows.filter((r) => r.status === 'to_score').slice(0, config.maxRetryRows);
  const { kept } = prefilter(dedupe(offers, rows), config);
  const items = [];
  for (const existing of retryRows) {
    const row = pickColumns(existing);
    items.push({ op: 'update', row, noDescription: true, claudeRequest: buildScoringRequest(row, '', config) });
  }
  for (const offer of kept) {
    const row = pickColumns({ ...offer, status: 'to_score', score_attempts: 0 });
    items.push({
      op: 'append',
      row,
      noDescription: !offer.description,
      claudeRequest: buildScoringRequest(row, offer.description, config),
    });
  }
  return items;
}

function applyScores(prepared, responses, config) {
  if (prepared.length !== responses.length) {
    throw new Error(`Scoring mismatch: ${prepared.length} prepared items but ${responses.length} responses`);
  }
  return prepared.map((item, i) => {
    const result = parseScoringResponse(responses[i]);
    const attempts = (Number(item.row.score_attempts) || 0) + 1;
    const row = { ...item.row, score_attempts: attempts };
    if (result.ok) {
      Object.assign(row, {
        score: result.score,
        score_reason: item.noDescription ? `${result.reason} (scored without description)` : result.reason,
        flags: result.flags.join(','),
        work_mode: result.work_mode === 'unknown' ? row.work_mode : result.work_mode,
        estimated_salary: result.estimated_salary,
        status: 'new',
      });
    } else {
      Object.assign(row, {
        score: '',
        score_reason: `scoring failed: ${result.error}`,
        status: attempts >= config.maxScoreAttempts ? 'score_failed' : 'to_score',
      });
    }
    return { op: item.op, row };
  });
}

function buildRunLog(fetched, now) {
  const runAt = now.toISOString();
  return fetched
    .filter((f) => f._status)
    .map((f) => ({ run_at: runAt, source: f._status.source, fetched: f._status.fetched, eligible: f._status.eligible, error: f._status.error }));
}
// @export
module.exports = { pickLinkedinCards, prepareCollectorRun, applyScores, buildRunLog };
