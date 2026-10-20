// Runs n8n Code node code ("Run Once for All Items" mode) outside n8n.
function fixedDate(iso) {
  const t = Date.parse(iso);
  return class FixedDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(t);
    }

    static now() {
      return t;
    }
  };
}

function wrap(items) {
  return {
    all: () => items.map((json) => ({ json })),
    first: () => ({ json: items[0] }),
  };
}

function runCodeNode(jsCode, { input = [], nodes = {}, now } = {}) {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Unknown node referenced: ${name}`);
    return wrap(nodes[name]);
  };
  const DateImpl = now ? fixedDate(now) : Date;
  // eslint-disable-next-line no-new-func
  const result = new Function('$input', '$', 'Date', jsCode)(wrap(input), $, DateImpl);
  if (!Array.isArray(result)) throw new Error('Code node must return an array');
  return result.map((item) => item.json);
}

function findNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`Node not found: ${name}`);
  return node;
}

module.exports = { runCodeNode, findNode };
