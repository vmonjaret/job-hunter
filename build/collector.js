const { createWorkflow, addNode, connect, codeNode, configNode, httpNode, sheetsNode } = require('./n8n');
const { SOURCES } = require('../src/lib/schema');

function normalizeEntry(source) {
  return `const config = $('Config').first().json;
const { offers, status } = normalizeResponses('${source}', $input.all().map((i) => i.json), config, new Date());
return [{ json: { _status: status } }, ...offers.map((o) => ({ json: o }))];`;
}

const CONFIG = "$('Config').first().json";
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Each builder adds one source's nodes on row y and returns the name of its last node (the Normalize node).
const SOURCE_BUILDERS = {
  france_travail(wf, y) {
    codeNode(wf, 'FT Queries', [440, y], `return ${CONFIG}.keywords.map((k) => ({ json: { motsCles: k } }));`, { libs: false });
    httpNode(wf, 'FT Search', [660, y], {
      method: 'GET',
      url: 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search',
      authentication: 'genericCredentialType',
      genericAuthType: 'oAuth2Api',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'motsCles', value: '={{ $json.motsCles }}' },
          { name: 'region', value: `={{ ${CONFIG}.ftRegion }}` },
          { name: 'typeContrat', value: 'CDI' },
          { name: 'publieeDepuis', value: '1' },
          { name: 'range', value: '0-149' },
        ],
      },
    }, { credentials: { oAuth2Api: { name: 'France Travail OAuth2' } } });
    codeNode(wf, 'FT Normalize', [880, y], normalizeEntry('france_travail'));
    connect(wf, 'Config', 'FT Queries');
    connect(wf, 'FT Queries', 'FT Search');
    connect(wf, 'FT Search', 'FT Normalize');
    return 'FT Normalize';
  },

  // Algolia, with the public keys the website serves at /api/env.
  wttj(wf, y) {
    httpNode(wf, 'WTTJ Env', [440, y], {
      method: 'GET',
      url: 'https://www.welcometothejungle.com/api/env',
      options: { response: { response: { responseFormat: 'text' } } },
    });
    codeNode(wf, 'WTTJ Queries', [660, y], `const { wttj, keywords } = ${CONFIG};
const { appId, apiKey } = parseWttjEnv($input.first().json.data);
return keywords.map((k) => ({ json: { appId, apiKey, body: { requests: [{ indexName: wttj.indexName, params: \`query=\${encodeURIComponent(k)}&hitsPerPage=100\` }] } } }));`);
    httpNode(wf, 'WTTJ Search', [880, y], {
      method: 'POST',
      url: "={{ 'https://' + $json.appId + '-dsn.algolia.net/1/indexes/*/queries' }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-Algolia-Application-Id', value: '={{ $json.appId }}' },
          { name: 'X-Algolia-API-Key', value: '={{ $json.apiKey }}' },
          { name: 'Referer', value: 'https://www.welcometothejungle.com/' },
          { name: 'Origin', value: 'https://www.welcometothejungle.com' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
    });
    codeNode(wf, 'WTTJ Normalize', [1100, y], `const config = $('Config').first().json;
const keys = parseWttjEnv($('WTTJ Env').first().json.data);
const { offers, status } = normalizeResponses('wttj', $input.all().map((i) => i.json), { ...config, wttj: { ...config.wttj, ...keys } }, new Date());
return [{ json: { _status: status } }, ...offers.map((o) => ({ json: o }))];`);
    connect(wf, 'Config', 'WTTJ Env');
    connect(wf, 'WTTJ Env', 'WTTJ Queries');
    connect(wf, 'WTTJ Queries', 'WTTJ Search');
    connect(wf, 'WTTJ Search', 'WTTJ Normalize');
    return 'WTTJ Normalize';
  },

  // Guest pages, no login. Throttled: LinkedIn answers 429 when requests come too fast.
  linkedin(wf, y) {
    codeNode(wf, 'LinkedIn Queries', [440, y], `const { keywords, linkedinPages } = ${CONFIG};
return keywords.flatMap((k) => Array.from({ length: linkedinPages }, (_, p) => ({ json: { keywords: k, start: p * 10 } })));`, { libs: false });
    const browserHeaders = { parameters: [{ name: 'User-Agent', value: BROWSER_UA }, { name: 'Accept-Language', value: 'en-US,en;q=0.9' }] };
    httpNode(wf, 'LinkedIn Search', [660, y], {
      method: 'GET',
      url: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'keywords', value: '={{ $json.keywords }}' },
          { name: 'location', value: `={{ ${CONFIG}.linkedinLocation }}` },
          { name: 'f_TPR', value: 'r86400' },
          { name: 'f_JT', value: 'F' },
          { name: 'start', value: '={{ $json.start }}' },
        ],
      },
      sendHeaders: true,
      headerParameters: browserHeaders,
      options: { batching: { batch: { batchSize: 1, batchInterval: 2000 } }, response: { response: { responseFormat: 'text' } } },
    });
    sheetsNode(wf, 'LinkedIn Known Offers', [880, y], 'offers', 'read', { executeOnce: true, alwaysOutputData: true });
    const pick = codeNode(wf, 'LinkedIn Pick', [1100, y], `const config = $('Config').first().json;
const searches = $('LinkedIn Search').all().map((i) => i.json);
const rows = $input.all().map((i) => i.json);
return pickLinkedinCards(searches, rows, config, new Date()).map((json) => ({ json }));`);
    // With no new card, an empty item still flows on so that LinkedIn Normalize reports the status.
    pick.alwaysOutputData = true;
    httpNode(wf, 'LinkedIn Job', [1320, y], {
      method: 'GET',
      url: "={{ $json.id ? 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + $json.id : '' }}",
      sendHeaders: true,
      headerParameters: browserHeaders,
      options: { batching: { batch: { batchSize: 1, batchInterval: 3000 } }, response: { response: { responseFormat: 'text' } } },
    });
    codeNode(wf, 'LinkedIn Normalize', [1540, y], `const searches = $('LinkedIn Search').all().map((i) => i.json);
const picks = $('LinkedIn Pick').all().map((i) => i.json).filter((c) => c.id);
const { offers, status } = normalizeLinkedin(searches, picks, $input.all().map((i) => i.json), new Date());
return [{ json: { _status: status } }, ...offers.map((o) => ({ json: o }))];`);
    connect(wf, 'Config', 'LinkedIn Queries');
    connect(wf, 'LinkedIn Queries', 'LinkedIn Search');
    connect(wf, 'LinkedIn Search', 'LinkedIn Known Offers');
    connect(wf, 'LinkedIn Known Offers', 'LinkedIn Pick');
    connect(wf, 'LinkedIn Pick', 'LinkedIn Job');
    connect(wf, 'LinkedIn Job', 'LinkedIn Normalize');
    return 'LinkedIn Normalize';
  },

  adzuna(wf, y) {
    codeNode(wf, 'Adzuna Queries', [440, y], `return ${CONFIG}.keywords.map((k) => ({ json: { what: k } }));`, { libs: false });
    httpNode(wf, 'Adzuna Search', [660, y], {
      method: 'GET',
      url: 'https://api.adzuna.com/v1/api/jobs/fr/search/1',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'what', value: '={{ $json.what }}' },
          { name: 'where', value: `={{ ${CONFIG}.adzunaWhere }}` },
          { name: 'distance', value: `={{ ${CONFIG}.adzunaDistanceKm }}` },
          { name: 'permanent', value: '1' },
          { name: 'max_days_old', value: '1' },
          { name: 'results_per_page', value: '50' },
          { name: 'sort_by', value: 'date' },
        ],
      },
    }, { credentials: { httpCustomAuth: { name: 'Adzuna API' } } });
    codeNode(wf, 'Adzuna Normalize', [880, y], normalizeEntry('adzuna'));
    connect(wf, 'Config', 'Adzuna Queries');
    connect(wf, 'Adzuna Queries', 'Adzuna Search');
    connect(wf, 'Adzuna Search', 'Adzuna Normalize');
    return 'Adzuna Normalize';
  },

  remotive(wf, y) {
    httpNode(wf, 'Remotive Fetch', [660, y], {
      method: 'GET',
      url: 'https://remotive.com/api/remote-jobs',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'category', value: 'software-development' }] },
    });
    codeNode(wf, 'Remotive Normalize', [880, y], normalizeEntry('remotive'));
    connect(wf, 'Config', 'Remotive Fetch');
    connect(wf, 'Remotive Fetch', 'Remotive Normalize');
    return 'Remotive Normalize';
  },

  remoteok(wf, y) {
    httpNode(wf, 'RemoteOK Fetch', [660, y], {
      method: 'GET',
      url: 'https://remoteok.com/api',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'n8n-job-hunter (personal job search)' }] },
    });
    codeNode(wf, 'RemoteOK Normalize', [880, y], normalizeEntry('remoteok'));
    connect(wf, 'Config', 'RemoteOK Fetch');
    connect(wf, 'RemoteOK Fetch', 'RemoteOK Normalize');
    return 'RemoteOK Normalize';
  },
};

function buildCollector(cfg) {
  const sources = SOURCES.filter((s) => cfg.enabledSources.includes(s));
  const unknown = cfg.enabledSources.filter((s) => !SOURCES.includes(s));
  if (unknown.length) throw new Error(`Unknown sources in enabledSources: ${unknown.join(', ')}`);
  if (sources.length < 2) throw new Error('enabledSources needs at least 2 sources (the Merge node needs 2 inputs)');
  const wf = createWorkflow('job-hunter-collector');

  addNode(wf, {
    name: 'Every 4 hours',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 300],
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 7,11,15,19 * * *' }] } },
  });
  addNode(wf, { name: 'Run manually', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 500], parameters: {} });
  configNode(wf, cfg, [220, 400]);
  connect(wf, 'Every 4 hours', 'Config');
  connect(wf, 'Run manually', 'Config');

  // Merge (input order = dedupe priority)
  const normalizeNodes = sources.map((source, i) => SOURCE_BUILDERS[source](wf, i * 200));
  addNode(wf, { name: 'Merge Sources', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [1760, 400], parameters: { numberInputs: sources.length } });
  normalizeNodes.forEach((name, input) => connect(wf, name, 'Merge Sources', input));

  // Run log
  codeNode(wf, 'Log Run', [1980, 600], 'return buildRunLog($input.all().map((i) => i.json), new Date()).map((json) => ({ json }));');
  sheetsNode(wf, 'Append Run Log', [2200, 600], 'runs', 'append');
  connect(wf, 'Merge Sources', 'Log Run');
  connect(wf, 'Log Run', 'Append Run Log');

  // Dedupe, filter, score, write
  sheetsNode(wf, 'Read Offers', [1980, 300], 'offers', 'read', { executeOnce: true, alwaysOutputData: true });
  codeNode(wf, 'Prepare', [2200, 300], `const config = $('Config').first().json;
const fetched = $('Merge Sources').all().map((i) => i.json);
const rows = $input.all().map((i) => i.json);
return prepareCollectorRun(fetched, rows, config).map((json) => ({ json }));`);
  httpNode(wf, 'Score Offer', [2420, 300], {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'anthropic-beta', value: 'server-side-fallback-2026-07-01' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.claudeRequest) }}',
    options: { batching: { batch: { batchSize: 5, batchInterval: 3000 } }, timeout: 120000 },
  },
  // No node-level retry: it could re-send every offer; failed offers stay to_score for the next run.
  { credentials: { httpHeaderAuth: { name: 'Anthropic API Key' } }, retryOnFail: false });
  codeNode(wf, 'Apply Scores', [2640, 300], `const config = $('Config').first().json;
const prepared = $('Prepare').all().map((i) => i.json);
const responses = $input.all().map((i) => i.json);
return applyScores(prepared, responses, config).map((json) => ({ json }));`);
  codeNode(wf, 'New Rows', [2860, 200], "return $input.all().filter((i) => i.json.op === 'append').map((i) => ({ json: i.json.row }));", { libs: false });
  codeNode(wf, 'Retried Rows', [2860, 400], "return $input.all().filter((i) => i.json.op === 'update').map((i) => ({ json: i.json.row }));", { libs: false });
  sheetsNode(wf, 'Append Offers', [3080, 200], 'offers', 'append');
  sheetsNode(wf, 'Update Offers', [3080, 400], 'offers', 'update');
  connect(wf, 'Merge Sources', 'Read Offers');
  connect(wf, 'Read Offers', 'Prepare');
  connect(wf, 'Prepare', 'Score Offer');
  connect(wf, 'Score Offer', 'Apply Scores');
  connect(wf, 'Apply Scores', 'New Rows');
  connect(wf, 'Apply Scores', 'Retried Rows');
  connect(wf, 'New Rows', 'Append Offers');
  connect(wf, 'Retried Rows', 'Update Offers');

  return wf;
}

module.exports = { buildCollector };
