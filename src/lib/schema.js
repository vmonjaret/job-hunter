// @body
// Column order of the Google Sheet tabs. The header rows in the sheet must match exactly.
const OFFER_COLUMNS = [
  'id', 'source', 'title', 'company', 'location', 'work_mode', 'contract',
  'salary_min', 'salary_max', 'salary_raw', 'estimated_salary', 'url',
  'published_at', 'found_at', 'score', 'score_reason', 'flags', 'status',
  'score_attempts', 'emailed_at', 'notes', 'dedupe_key',
];
const RUN_COLUMNS = ['run_at', 'source', 'fetched', 'eligible', 'error'];
// Also the dedupe priority: when two sources have the same offer, the first one wins.
const SOURCES = ['france_travail', 'wttj', 'linkedin', 'adzuna', 'remotive', 'remoteok'];

function pickColumns(row) {
  const out = {};
  for (const col of OFFER_COLUMNS) {
    out[col] = row[col] === undefined || row[col] === null ? '' : row[col];
  }
  return out;
}
// @export
module.exports = { OFFER_COLUMNS, RUN_COLUMNS, SOURCES, pickColumns };
