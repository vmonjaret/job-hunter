const { truncate } = require('./text');
// @body
const SCORE_FLAGS = ['esn', 'avoided_language', 'contractor_only', 'salary_below_floor', 'onsite_only', 'far_commute', 'not_senior', 'not_cdi'];
const WORK_MODES = ['onsite', 'hybrid', 'remote', 'unknown'];

// Structured outputs don't support numeric constraints; the 0-10 range is checked in parseScoringResponse.
const SCORING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'reason', 'flags', 'work_mode', 'estimated_salary'],
  properties: {
    score: { type: 'integer', description: 'Match score from 0 (no fit) to 10 (perfect fit)' },
    reason: { type: 'string' },
    flags: { type: 'array', items: { type: 'string', enum: SCORE_FLAGS } },
    work_mode: { type: 'string', enum: WORK_MODES },
    estimated_salary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

function buildUserMessage(row, description, maxChars) {
  return [
    `Title: ${row.title}`,
    `Company: ${row.company || '(not specified)'}`,
    `Location: ${row.location || '(not specified)'}`,
    `Work mode (from the job board): ${row.work_mode || 'unknown'}`,
    `Contract: ${row.contract || '(not specified)'}`,
    `Salary: ${row.salary_raw || '(not specified)'}`,
    `Source: ${row.source}`,
    '',
    description
      ? `Description:\n${truncate(description, maxChars)}`
      : 'Description: (not available, score from the fields above only)',
  ].join('\n');
}

function buildScoringRequest(row, description, config) {
  return {
    model: config.claudeModel,
    max_tokens: config.claudeMaxTokens,
    system: config.systemPrompt,
    messages: [{ role: 'user', content: buildUserMessage(row, description, config.descriptionMaxChars) }],
    output_config: { effort: config.claudeEffort, format: { type: 'json_schema', schema: SCORING_SCHEMA } },
    fallbacks: 'default',
  };
}

function parseScoringResponse(response) {
  if (!response || typeof response !== 'object') return { ok: false, error: 'empty response' };
  if (response.error) {
    return { ok: false, error: typeof response.error === 'string' ? response.error : response.error.message || 'API error' };
  }
  if (response.stop_reason !== 'end_turn') return { ok: false, error: `stop_reason ${response.stop_reason}` };
  const block = (response.content || []).find((b) => b.type === 'text');
  if (!block) return { ok: false, error: 'no text block' };
  let data;
  try {
    data = JSON.parse(block.text);
  } catch (e) {
    return { ok: false, error: 'invalid JSON' };
  }
  const score = Number(data.score);
  if (!Number.isInteger(score) || score < 0 || score > 10) return { ok: false, error: `invalid score ${data.score}` };
  return {
    ok: true,
    score,
    reason: truncate(String(data.reason || ''), 200),
    flags: Array.isArray(data.flags) ? data.flags.filter((f) => SCORE_FLAGS.includes(f)) : [],
    work_mode: WORK_MODES.includes(data.work_mode) ? data.work_mode : 'unknown',
    estimated_salary: typeof data.estimated_salary === 'string' ? data.estimated_salary : '',
  };
}
// @export
module.exports = { SCORE_FLAGS, WORK_MODES, SCORING_SCHEMA, buildScoringRequest, parseScoringResponse };
