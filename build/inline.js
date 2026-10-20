const fs = require('fs');
const path = require('path');

const LIB_DIR = path.join(__dirname, '..', 'src', 'lib');

// Dependency order: a lib may only use libs listed before it.
const LIBS = ['schema', 'text', 'salary', 'linkedin', 'normalize', 'dedupe', 'prefilter', 'scoring', 'pipeline', 'digest'];

function extractBody(source, name) {
  const start = source.indexOf('// @body');
  const end = source.indexOf('// @export');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${name}: missing // @body or // @export marker`);
  }
  return source.slice(start + '// @body'.length, end).trim();
}

function inlineCode(entry) {
  const bodies = LIBS.map((name) => extractBody(fs.readFileSync(path.join(LIB_DIR, `${name}.js`), 'utf8'), name));
  return `${bodies.join('\n\n')}\n\n// ---- node entry ----\n${entry.trim()}\n`;
}

module.exports = { LIBS, extractBody, inlineCode };
