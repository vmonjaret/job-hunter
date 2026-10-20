const { createWorkflow, addNode, connect, codeNode, gmailNode } = require('./n8n');

function buildErrorHandler(cfg) {
  const wf = createWorkflow('job-hunter-error-handler');
  addNode(wf, { name: 'On workflow error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} });
  codeNode(wf, 'Format Error', [220, 0], `return [{ json: formatErrorEmail($input.first().json, ${JSON.stringify(cfg.digestEmail)}) }];`);
  gmailNode(wf, 'Send Alert', [440, 0], '={{ $json.to }}');
  connect(wf, 'On workflow error', 'Format Error');
  connect(wf, 'Format Error', 'Send Alert');
  return wf;
}

module.exports = { buildErrorHandler };
