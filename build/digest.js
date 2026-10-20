const { createWorkflow, addNode, connect, codeNode, configNode, sheetsNode, gmailNode } = require('./n8n');

function buildDigestWorkflow(cfg) {
  const wf = createWorkflow('job-hunter-digest');
  const values = { sheetId: cfg.sheetId, sheetUrl: cfg.sheetUrl, digestEmail: cfg.digestEmail, scoreThreshold: cfg.scoreThreshold };

  addNode(wf, {
    name: 'Every day 08:00',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 0],
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } },
  });
  addNode(wf, { name: 'Run manually', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 200], parameters: {} });
  configNode(wf, values, [220, 100]);
  sheetsNode(wf, 'Read Offers', [440, 100], 'offers', 'read', { executeOnce: true, alwaysOutputData: true });
  sheetsNode(wf, 'Read Runs', [660, 100], 'runs', 'read', { executeOnce: true, alwaysOutputData: true });
  codeNode(wf, 'Build Digest', [880, 100], `const config = $('Config').first().json;
const offers = $('Read Offers').all().map((i) => i.json).filter((r) => r.id);
const runs = $input.all().map((i) => i.json).filter((r) => r.run_at);
const digest = buildDigest(offers, runs, config, new Date());
return digest ? [{ json: digest }] : [];`);
  gmailNode(wf, 'Send Digest', [1100, 100], "={{ $('Config').first().json.digestEmail }}");
  codeNode(wf, 'Mark Emailed', [1320, 100], `const { ids } = $('Build Digest').first().json;
const emailedAt = new Date().toISOString();
return ids.map((id) => ({ json: { id, status: 'emailed', emailed_at: emailedAt } }));`, { libs: false });
  sheetsNode(wf, 'Update Offers', [1540, 100], 'offers', 'update');

  connect(wf, 'Every day 08:00', 'Config');
  connect(wf, 'Run manually', 'Config');
  connect(wf, 'Config', 'Read Offers');
  connect(wf, 'Read Offers', 'Read Runs');
  connect(wf, 'Read Runs', 'Build Digest');
  connect(wf, 'Build Digest', 'Send Digest');
  connect(wf, 'Send Digest', 'Mark Emailed');
  connect(wf, 'Mark Emailed', 'Update Offers');
  return wf;
}

module.exports = { buildDigestWorkflow };
