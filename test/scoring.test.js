const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { SCORING_SCHEMA, buildScoringRequest, parseScoringResponse } = require('../src/lib/scoring');

const config = { ...baseConfig, systemPrompt: 'SYSTEM PROMPT' };
const okResponse = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-response.json'), 'utf8'));
const row = { title: 'Tech Lead Symfony', company: 'Gamma', location: 'Paris', work_mode: 'unknown', contract: 'CDI', salary_raw: '65000-75000 EUR', source: 'adzuna' };
const withText = (text, extra = {}) => ({ ...okResponse(), content: [{ type: 'text', text }], ...extra });

test('buildScoringRequest builds the Messages API body', () => {
  const body = buildScoringRequest(row, 'Kafka and DDD.', config);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.system, 'SYSTEM PROMPT');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema: SCORING_SCHEMA } });
  assert.equal(body.thinking, undefined);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  const content = body.messages[0].content;
  assert.match(content, /^Title: Tech Lead Symfony$/m);
  assert.match(content, /^Company: Gamma$/m);
  assert.match(content, /^Salary: 65000-75000 EUR$/m);
  assert.match(content, /Description:\nKafka and DDD\./);
});

test('buildScoringRequest truncates long descriptions and handles a missing one', () => {
  const long = buildScoringRequest(row, 'a'.repeat(7000), config).messages[0].content;
  assert.ok(long.includes(`${'a'.repeat(6000)}…`));
  assert.ok(!long.includes('a'.repeat(6001)));
  const none = buildScoringRequest({ ...row, company: '' }, '', config).messages[0].content;
  assert.match(none, /Description: \(not available, score from the fields above only\)/);
  assert.match(none, /^Company: \(not specified\)$/m);
});

test('the schema only uses constraints that structured outputs support', () => {
  assert.doesNotMatch(JSON.stringify(SCORING_SCHEMA), /minimum|maximum|minLength|maxLength|multipleOf/);
  assert.equal(SCORING_SCHEMA.additionalProperties, false);
});

test('parseScoringResponse reads the text block after a thinking block', () => {
  assert.deepEqual(parseScoringResponse(okResponse()), {
    ok: true,
    score: 8,
    reason: 'Senior Symfony full stack role with 2 remote days at a product company.',
    flags: [],
    work_mode: 'hybrid',
    estimated_salary: '60-70k EUR',
  });
});

test('parseScoringResponse sanitizes flags, work mode and salary', () => {
  const r = parseScoringResponse(withText('{"score":"7","reason":"ok","flags":["esn","made_up"],"work_mode":"mars","estimated_salary":null}'));
  assert.deepEqual(r, { ok: true, score: 7, reason: 'ok', flags: ['esn'], work_mode: 'unknown', estimated_salary: '' });
});

test('parseScoringResponse turns every failure into ok: false', () => {
  assert.deepEqual(parseScoringResponse({ error: { message: 'Request failed with status code 529' } }), { ok: false, error: 'Request failed with status code 529' });
  assert.deepEqual(parseScoringResponse({ error: 'timeout' }), { ok: false, error: 'timeout' });
  assert.deepEqual(parseScoringResponse(withText('{}', { stop_reason: 'refusal' })), { ok: false, error: 'stop_reason refusal' });
  assert.deepEqual(parseScoringResponse(withText('{}', { stop_reason: 'max_tokens' })), { ok: false, error: 'stop_reason max_tokens' });
  assert.deepEqual(parseScoringResponse({ ...okResponse(), content: [] }), { ok: false, error: 'no text block' });
  assert.deepEqual(parseScoringResponse(withText('not json')), { ok: false, error: 'invalid JSON' });
  assert.deepEqual(parseScoringResponse(withText('{"score":11}')), { ok: false, error: 'invalid score 11' });
  assert.deepEqual(parseScoringResponse(withText('{"score":7.5}')), { ok: false, error: 'invalid score 7.5' });
  assert.deepEqual(parseScoringResponse(null), { ok: false, error: 'empty response' });
});
