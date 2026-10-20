const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { OFFER_COLUMNS, RUN_COLUMNS } = require('../src/lib/schema');

const ROOT = path.join(__dirname, '..');

// With local: true, src/config.local.js and prompts/candidate-profile.md (both gitignored) replace the
// committed defaults and the example profile.
function workflowConfig({ local = false } = {}) {
  const localFile = (rel) => (local && fs.existsSync(path.join(ROOT, rel)) ? path.join(ROOT, rel) : null);
  const read = (file) => fs.readFileSync(file, 'utf8');
  const profileFile = localFile('prompts/candidate-profile.md') || path.join(ROOT, 'prompts', 'candidate-profile.example.md');
  const profile = read(profileFile).replace(/<!--[\s\S]*?-->\n?/g, '').trim();
  const systemPrompt = read(path.join(ROOT, 'prompts', 'scoring-system-prompt.md')).replace('{{candidate_profile}}', () => profile).trim();
  const configFile = localFile('src/config.local.js');
  return { ...baseConfig, ...(configFile ? require(configFile) : {}), systemPrompt };
}

function outputs(cfg = workflowConfig()) {
  // Required here, not at the top: collector.js and the tests require this file for workflowConfig().
  const { buildCollector } = require('./collector');
  const { buildDigestWorkflow } = require('./digest');
  const { buildErrorHandler } = require('./error-handler');
  const json = (wf) => `${JSON.stringify(wf, null, 2)}\n`;
  return {
    'workflows/job-hunter-collector.json': json(buildCollector(cfg)),
    'workflows/job-hunter-digest.json': json(buildDigestWorkflow(cfg)),
    'workflows/job-hunter-error-handler.json': json(buildErrorHandler(cfg)),
    'sheet/offers-header.csv': `${OFFER_COLUMNS.join(',')}\n`,
    'sheet/runs-header.csv': `${RUN_COLUMNS.join(',')}\n`,
  };
}

// `npm run build` writes the committed files from the defaults and the example profile. `npm run build:local`
// writes your personal workflows to dist/ (gitignored), so your sheet, email and profile never land in git.
function writeAll({ local = false } = {}) {
  for (const [rel, content] of Object.entries(outputs(workflowConfig({ local })))) {
    if (local && !rel.startsWith('workflows/')) continue;
    const file = path.join(ROOT, local ? path.join('dist', rel) : rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
}

if (require.main === module) writeAll({ local: process.argv.includes('--local') });

module.exports = { workflowConfig, outputs, writeAll };
