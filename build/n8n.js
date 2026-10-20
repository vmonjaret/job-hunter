const crypto = require('crypto');
const { inlineCode } = require('./inline');

// Deterministic ids keep the generated JSON stable between builds.
function nodeId(workflowName, nodeName) {
  const h = crypto.createHash('md5').update(`${workflowName}/${nodeName}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function createWorkflow(name) {
  return {
    name,
    nodes: [],
    connections: {},
    settings: { executionOrder: 'v1', timezone: 'Europe/Paris', saveManualExecutions: true },
    pinData: {},
  };
}

function addNode(wf, node) {
  if (wf.nodes.some((n) => n.name === node.name)) throw new Error(`Duplicate node name: ${node.name}`);
  const full = { id: nodeId(wf.name, node.name), parameters: {}, ...node };
  wf.nodes.push(full);
  return full;
}

function connect(wf, from, to, input = 0, output = 0) {
  if (!wf.connections[from]) wf.connections[from] = { main: [] };
  const { main } = wf.connections[from];
  while (main.length <= output) main.push([]);
  main[output].push({ node: to, type: 'main', index: input });
}

function codeNode(wf, name, position, entry, { libs = true } = {}) {
  return addNode(wf, {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { mode: 'runOnceForAllItems', jsCode: libs ? inlineCode(entry) : `${entry.trim()}\n` },
  });
}

function configNode(wf, values, position) {
  const entry = `// Generated from src/config.js and src/config.local.js: edit them, run npm run build:local, then re-import.\nreturn [{ json: ${JSON.stringify(values, null, 2)} }];`;
  return codeNode(wf, 'Config', position, entry, { libs: false });
}

function httpNode(wf, name, position, parameters, extra = {}) {
  return addNode(wf, {
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: { options: {}, ...parameters },
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 5000,
    ...extra,
  });
}

const SHEET_ID = "={{ $('Config').first().json.sheetId }}";

function sheetsNode(wf, name, position, sheetName, operation, extra = {}) {
  const parameters = {
    operation,
    documentId: { __rl: true, mode: 'id', value: SHEET_ID },
    sheetName: { __rl: true, mode: 'name', value: sheetName },
    options: {},
  };
  if (operation === 'append') {
    parameters.columns = { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] };
  }
  if (operation === 'update') {
    parameters.columns = { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['id'], schema: [] };
  }
  // RAW keeps ISO dates as text (Date.parse can read them back) and stops "=..." titles becoming formulas.
  if (operation === 'append' || operation === 'update') parameters.options = { cellFormat: 'RAW' };
  return addNode(wf, {
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    parameters,
    credentials: { googleSheetsOAuth2Api: { name: 'Google Sheets account' } },
    ...extra,
  });
}

function gmailNode(wf, name, position, sendTo) {
  return addNode(wf, {
    name,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position,
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo,
      subject: '={{ $json.subject }}',
      emailType: 'html',
      message: '={{ $json.html }}',
      options: { appendAttribution: false },
    },
    credentials: { gmailOAuth2: { name: 'Gmail account' } },
  });
}

function assertConnectionsValid(wf) {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, { main }] of Object.entries(wf.connections)) {
    if (!names.has(from)) throw new Error(`Connection from unknown node: ${from}`);
    for (const output of main) {
      for (const target of output) {
        if (!names.has(target.node)) throw new Error(`Connection from ${from} to unknown node: ${target.node}`);
      }
    }
  }
}

module.exports = { createWorkflow, addNode, connect, codeNode, configNode, httpNode, sheetsNode, gmailNode, assertConnectionsValid };
