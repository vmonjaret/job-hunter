# n8n Job Hunter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three importable n8n workflows that collect job offers from 5 sources, score them with Claude Opus 5.5 against the user's profile, track them in a Google Sheet, and email a daily digest of the best new matches.

**Architecture:** All Code node logic lives in plain CommonJS modules under `src/lib/`, unit-tested with Node's built-in test runner. A build script (`build/`) inlines those modules into n8n Code nodes and generates the workflow JSON files in `workflows/`, which are committed and imported into n8n. A small harness (`test/harness.js`) runs the generated Code node code the way n8n does, so the wiring between nodes is tested too. The last task is a guided integration run on the user's self-hosted n8n.

**Tech Stack:** Node.js 24 (tests and build only, no npm dependencies), n8n (self-hosted), Google Sheets, Gmail, Claude API (`claude-opus-5-5`), France Travail / Adzuna / Welcome to the Jungle (Algolia) / Remotive / RemoteOK.

**Spec:** `docs/superpowers/specs/2026-10-13-job-hunter-design.md`

## Global Constraints

- No npm dependencies. Tests run with `npm test` (`node --test`). The build runs with `npm run build`.
- Every file in `src/lib/` has exactly this shape: optional `require` lines, then a `// @body` line, the code, then a `// @export` line followed by `module.exports = {...}`. Only the code between the markers is inlined into n8n. Top-level names must be unique across all lib files, because they are all inlined into one scope.
- Lib code must not use `require`, `module`, `process`, or the filesystem: it runs inside n8n Code nodes.
- Inline order (dependencies first): `schema, text, salary, normalize, dedupe, prefilter, scoring, pipeline, digest`.
- Claude request: `model: "claude-opus-5-5"`, `max_tokens: 4096`, `output_config: { effort: "low", format: { type: "json_schema", schema } }`, `fallbacks: "default"`, headers `anthropic-version: 2023-06-01` and `anthropic-beta: server-side-fallback-2026-07-01`. No `minimum`/`maximum`/`minLength`/`maxLength` in the schema. No `thinking` parameter (Opus 5.5 rejects disabling it).
- Collector cron: `0 7,11,15,19 * * *`. Digest cron: `0 8 * * *`. Workflow timezone: `Europe/Paris`.
- Sheet tabs: `offers` (columns = `OFFER_COLUMNS`, in order) and `runs` (columns = `RUN_COLUMNS`, in order).
- n8n credential names, exactly: `France Travail OAuth2`, `Adzuna API`, `Anthropic API Key`, `Google Sheets account`, `Gmail account`.
- Digest recipient: `you@example.com`. Score threshold: 7. Salary floor: 60000.
- `workflows/*.json` and `sheet/*.csv` are generated: never edit them by hand. Run `npm run build` and commit the output.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (pass it as a second `-m`). Commit signing is turned off for this repository.

## Review Focus

1. **RemoteOK's array response gets split into items by n8n.** The HTTP Request node turns a top-level JSON array into one item per element, so the normalizer receives single jobs (and the legal-notice object), not one array. It must give the same result for both shapes. Covered by a test in Task 3.
2. **First run on an empty Sheet.** Google Sheets "read" returns no rows. With `alwaysOutputData` n8n then emits one empty `{}` item, which must not be treated as an existing offer or crash dedupe. Covered by a test in Task 6 and the collector flow test in Task 8.
3. **Sheet values come back as strings** (`"8"`, `"2"`, `""`). Digest selection, health stats and `score_attempts` must compare numerically and treat `""` as "no score". Covered by tests in Tasks 6 and 7.
4. **HTML and unsafe URLs in job data.** Titles and companies like `<script>` or `A & B` must be escaped in the digest, and `javascript:` URLs must never become links. Covered by a test in Task 7.
5. **Claude responses that don't match the prepared items.** An HTTP error item, a refusal, a non-JSON body or an out-of-range score must become a scoring failure for that offer, not a crash. A response count different from the prepared count must throw, so the error workflow sends an alert. Covered by tests in Tasks 5 and 6.

---

### Task 1: Project scaffold, inliner and Code node harness

**Files:**
- Create: `package.json`, `.gitignore`
- Create: `build/inline.js`
- Create: `test/harness.js`
- Test: `test/inline.test.js`, `test/harness.test.js`

**Interfaces:**
- Produces: `extractBody(source: string, name: string): string`, `inlineCode(entry: string): string`, `LIBS: string[]` (from `build/inline.js`)
- Produces: `runCodeNode(jsCode: string, { input?: object[], nodes?: Record<string, object[]>, now?: string }): object[]` and `findNode(workflow, name): object` (from `test/harness.js`). `runCodeNode` returns the `json` of each output item.

- [ ] **Step 1: Create `package.json` and `.gitignore`**

`package.json`:
```json
{
  "name": "n8n-job-hunter",
  "version": "1.0.0",
  "private": true,
  "description": "n8n workflows that collect, score and email job offers",
  "scripts": {
    "test": "node --test",
    "build": "node build/build.js"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`.gitignore`:
```
node_modules/
.DS_Store
```

- [ ] **Step 2: Write the failing tests**

`test/inline.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBody, LIBS } = require('../build/inline');

test('extractBody returns the code between the markers', () => {
  const source = "const { a } = require('./a');\n// @body\nfunction b() { return a(); }\n// @export\nmodule.exports = { b };\n";
  assert.equal(extractBody(source, 'b'), 'function b() { return a(); }');
});

test('extractBody throws when a marker is missing', () => {
  assert.throws(() => extractBody('function x() {}\n// @export\n', 'x'), /x: missing \/\/ @body or \/\/ @export marker/);
  assert.throws(() => extractBody('// @body\nfunction x() {}\n', 'x'), /x: missing/);
});

test('LIBS lists the libraries in dependency order', () => {
  assert.deepEqual(LIBS, ['schema', 'text', 'salary', 'normalize', 'dedupe', 'prefilter', 'scoring', 'pipeline', 'digest']);
});
```

`test/harness.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCodeNode, findNode } = require('./harness');

test('runCodeNode exposes $input, $() and a fixed clock', () => {
  const code = "return $input.all().map((i) => ({ json: { v: i.json.v * 2, k: $('Config').first().json.k, t: new Date().toISOString(), n: Date.now() } }));";
  const out = runCodeNode(code, { input: [{ v: 1 }, { v: 2 }], nodes: { Config: [{ k: 'x' }] }, now: '2026-10-13T10:00:00Z' });
  assert.deepEqual(out, [
    { v: 2, k: 'x', t: '2026-10-13T10:00:00.000Z', n: Date.parse('2026-10-13T10:00:00Z') },
    { v: 4, k: 'x', t: '2026-10-13T10:00:00.000Z', n: Date.parse('2026-10-13T10:00:00Z') },
  ]);
});

test('runCodeNode still parses explicit dates with a fixed clock', () => {
  const out = runCodeNode("return [{ json: { y: new Date('2020-01-02T00:00:00Z').getUTCFullYear() } }];", { now: '2026-10-13T10:00:00Z' });
  assert.deepEqual(out, [{ y: 2020 }]);
});

test('runCodeNode fails on unknown node references and non-array returns', () => {
  assert.throws(() => runCodeNode("return $('Nope').all();"), /Unknown node referenced: Nope/);
  assert.throws(() => runCodeNode('return { json: {} };'), /must return an array/);
});

test('findNode finds a node by name or throws', () => {
  const wf = { nodes: [{ name: 'A' }] };
  assert.equal(findNode(wf, 'A').name, 'A');
  assert.throws(() => findNode(wf, 'B'), /Node not found: B/);
});
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../build/inline'` and `Cannot find module './harness'`.

- [ ] **Step 4: Implement `build/inline.js` and `test/harness.js`**

`build/inline.js`:
```js
const fs = require('fs');
const path = require('path');

const LIB_DIR = path.join(__dirname, '..', 'src', 'lib');

// Dependency order: a lib may only use libs listed before it.
const LIBS = ['schema', 'text', 'salary', 'normalize', 'dedupe', 'prefilter', 'scoring', 'pipeline', 'digest'];

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
```

`test/harness.js`:
```js
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
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npm test`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore build/inline.js test/harness.js test/inline.test.js test/harness.test.js
git commit -m "chore: scaffold project with lib inliner and Code node harness" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Text and salary helpers

**Files:**
- Create: `src/lib/text.js`, `src/lib/salary.js`
- Test: `test/text.test.js`, `test/salary.test.js`

**Interfaces:**
- Produces (`text.js`): `stripHtml(html): string`, `normalizeKey(str): string`, `dedupeKey(company, title): string` (`''` when company or title is empty), `truncate(str, max): string` (appends `…` when cut), `escapeHtml(str): string`, `isWithinHours(dateish, hours, now: Date): boolean` (`true` when the date can't be parsed)
- Produces (`salary.js`): `parseSalary(text): { min: number, max: number } | null` (yearly amounts)

- [ ] **Step 1: Write the failing tests**

`test/text.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripHtml, normalizeKey, dedupeKey, truncate, escapeHtml, isWithinHours } = require('../src/lib/text');

test('stripHtml removes tags, decodes entities and keeps line breaks', () => {
  assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b></p><p>Line&amp;2</p>'), 'Hello world\nLine&2');
  assert.equal(stripHtml('<strong>Tech Lead</strong> Symfony'), 'Tech Lead Symfony');
  assert.equal(stripHtml('<p>Build our <b>product</b>.</p>'), 'Build our product.');
  assert.equal(stripHtml('It&#39;s &#8217;ok&#8217;'), "It's ’ok’");
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
});

test('normalizeKey lowercases, strips accents and punctuation', () => {
  assert.equal(normalizeKey('  Développeur Full-Stack (Sénior) '), 'developpeur full stack senior');
  assert.equal(normalizeKey(null), '');
});

test('dedupeKey ignores gender markers so cross-posted offers match', () => {
  const a = dedupeKey('Acme Santé', 'Développeur Full Stack Senior PHP/Symfony (H/F)');
  const b = dedupeKey('ACME SANTE', 'Développeur Full Stack Senior PHP/Symfony H/F');
  const c = dedupeKey('Acme Santé', 'Développeur Full Stack Senior PHP/Symfony (M/W/D)');
  assert.equal(a, 'acme sante|developpeur full stack senior php symfony');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('dedupeKey is empty when the company or title is missing', () => {
  assert.equal(dedupeKey('', 'Lead Developer'), '');
  assert.equal(dedupeKey('Acme', ''), '');
});

test('truncate cuts long strings with an ellipsis', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate(null, 3), '');
});

test('escapeHtml escapes the five HTML special characters', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(8), '8');
});

test('isWithinHours compares against now and keeps unparseable dates', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  assert.equal(isWithinHours('2026-10-12T11:00:00Z', 24, now), true);
  assert.equal(isWithinHours('2026-10-12T09:00:00Z', 24, now), false);
  assert.equal(isWithinHours('not a date', 24, now), true);
  assert.equal(isWithinHours('', 24, now), true);
});
```

`test/salary.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSalary } = require('../src/lib/salary');

const cases = [
  ['Annuel de 55000.00 Euros à 65000.00 Euros sur 12 mois', { min: 55000, max: 65000 }],
  ['Annuel de 60000,00 Euros sur 12 mois', { min: 60000, max: 60000 }],
  ['Mensuel de 4500.00 Euros sur 12 mois', { min: 54000, max: 54000 }],
  ['$35,3k- $52k', { min: 35300, max: 52000 }],
  ['€70k - €85k', { min: 70000, max: 85000 }],
  ['55 000 € - 65 000 €', { min: 55000, max: 65000 }],
  ['€60,000 - €75,000', { min: 60000, max: 75000 }],
  ['4 000 € par mois', { min: 48000, max: 48000 }],
  ['500€ par jour', null],
  ['TJM 600 €/jour', null],
  ['Selon profil', null],
  ['Autre', null],
  ['', null],
  [null, null],
  [undefined, null],
];

for (const [input, expected] of cases) {
  test(`parseSalary(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseSalary(input), expected);
  });
}
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/text.test.js test/salary.test.js`
Expected: FAIL with `Cannot find module '../src/lib/text'` and `'../src/lib/salary'`.

- [ ] **Step 3: Implement `src/lib/text.js` and `src/lib/salary.js`**

`src/lib/text.js`:
```js
// @body
const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

function stripHtml(html) {
  if (html === null || html === undefined) return '';
  return String(html)
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div)\s*\/?>/gi, '\n')
    .replace(/<\/?(b|i|u|em|strong|span|a|small|code)(\s[^>]*)?>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
}

function normalizeKey(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeKey(company, title) {
  const cleanTitle = String(title || '')
    .replace(/\(\s*[hfmwd]\s*(\/\s*[hfmwd]\s*)*\)/gi, ' ')
    .replace(/\b[hf]\s*\/\s*[hf]\b/gi, ' ');
  const c = normalizeKey(company);
  const t = normalizeKey(cleanTitle);
  return c && t ? `${c}|${t}` : '';
}

function truncate(str, max) {
  const s = String(str === null || str === undefined ? '' : str);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function escapeHtml(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isWithinHours(dateish, hours, now) {
  const t = Date.parse(dateish);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t <= hours * 3600 * 1000;
}
// @export
module.exports = { stripHtml, normalizeKey, dedupeKey, truncate, escapeHtml, isWithinHours };
```

`src/lib/salary.js`:
```js
// @body
// Returns a yearly { min, max } from free-text salary, or null when there is no usable yearly amount.
function parseSalary(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).toLowerCase();
  if (!/\d/.test(s)) return null;
  if (/jour|journalier|\bday\b|daily|heure|horaire|\bhour|hourly|\/h\b|tjm/.test(s)) return null;

  let t = s.replace(/(\d)[\s  ]+(?=\d{3}(?!\d))/g, '$1'); // "55 000" -> "55000"
  t = t.replace(/(\d)[,.](?=\d{3}(?!\d))/g, '$1'); // "60,000" -> "60000"
  t = t.replace(/(\d),(\d)/g, '$1.$2'); // "35,3k" -> "35.3k"

  const values = [];
  const re = /(\d+(?:\.\d+)?)\s*(k)?/g;
  let m = re.exec(t);
  while (m) {
    let v = parseFloat(m[1]);
    if (m[2]) v *= 1000;
    if (v >= 1000) values.push(v);
    m = re.exec(t);
  }
  if (values.length === 0) return null;

  let min = Math.min(...values);
  let max = Math.max(...values);
  const monthly = /mensuel|par mois|\/ ?mois|per month|\/ ?month|monthly/.test(s);
  if (monthly || max < 15000) {
    min *= 12;
    max *= 12;
  }
  return { min: Math.round(min), max: Math.round(max) };
}
// @export
module.exports = { parseSalary };
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test test/text.test.js test/salary.test.js`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/text.js src/lib/salary.js test/text.test.js test/salary.test.js
git commit -m "feat: add text and salary helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sheet schema, config and source normalizers

**Files:**
- Create: `src/lib/schema.js`, `src/config.js`, `src/lib/normalize.js`
- Create: `test/fixtures/france-travail.json`, `test/fixtures/adzuna.json`, `test/fixtures/wttj.json`, `test/fixtures/remotive.json`, `test/fixtures/remoteok.json`
- Test: `test/normalize.test.js`

**Interfaces:**
- Consumes: `stripHtml`, `dedupeKey`, `isWithinHours` (text.js), `parseSalary` (salary.js)
- Produces (`schema.js`): `OFFER_COLUMNS: string[]`, `RUN_COLUMNS: string[]`, `SOURCES: string[]` (order: `france_travail, wttj, adzuna, remotive, remoteok`), `pickColumns(row): object` (exactly the `OFFER_COLUMNS` keys, missing values as `''`)
- Produces (`src/config.js`): the config object (keys listed in the code below). Not inlined: the build puts it into each workflow's Config node.
- Produces (`normalize.js`): `normalizeResponses(source, responses: object[], config, now: Date): { offers: Offer[], status: { source, fetched, eligible, error } }`. An `Offer` has every `OFFER_COLUMNS` key plus `description` (plain text).

- [ ] **Step 1: Create the fixtures**

`test/fixtures/france-travail.json`:
```json
{
  "resultats": [
    {
      "id": "201ABCD",
      "intitule": "Développeur Full Stack Senior PHP/Symfony (H/F)",
      "description": "Nous recherchons un développeur full stack senior. Stack : PHP 8, Symfony, React. 2 jours de télétravail.",
      "dateCreation": "2026-10-12T09:15:00.000Z",
      "lieuTravail": { "libelle": "75 - Paris 9e Arrondissement", "codePostal": "75009" },
      "entreprise": { "nom": "Acme Santé" },
      "typeContrat": "CDI",
      "salaire": { "libelle": "Annuel de 60000.00 Euros à 70000.00 Euros sur 12 mois" },
      "origineOffre": { "urlOrigine": "https://candidat.francetravail.fr/offres/recherche/detail/201ABCD" }
    },
    {
      "id": "201EFGH",
      "intitule": "Développeur Full Stack Junior (H/F)",
      "description": "Poste junior.",
      "dateCreation": "2026-10-12T10:00:00.000Z",
      "lieuTravail": { "libelle": "93 - Saint-Denis" },
      "entreprise": { "nom": "Beta Corp" },
      "typeContrat": "CDI",
      "salaire": { "libelle": "Annuel de 38000.00 Euros sur 12 mois" },
      "origineOffre": {}
    },
    {
      "id": "201IJKL",
      "intitule": "Lead Developer Node.js (H/F)",
      "description": "Lead dev pour un grand compte.",
      "dateCreation": "2026-10-12T11:00:00.000Z",
      "lieuTravail": { "libelle": "92 - Nanterre" },
      "entreprise": { "nom": "Capgemini" },
      "typeContrat": "CDI"
    }
  ]
}
```

`test/fixtures/adzuna.json`:
```json
{
  "results": [
    {
      "id": "4870000001",
      "title": "<strong>Tech Lead</strong> Symfony",
      "description": "Product company, Kafka, DDD.",
      "created": "2026-10-12T08:00:00Z",
      "redirect_url": "https://www.adzuna.fr/details/4870000001",
      "company": { "display_name": "Gamma Software" },
      "location": { "display_name": "Paris, Ile-de-France" },
      "salary_min": 65000,
      "salary_max": 75000,
      "salary_is_predicted": "0",
      "contract_type": "permanent",
      "contract_time": "full_time"
    },
    {
      "id": "4870000002",
      "title": "Développeur Full Stack Senior PHP/Symfony H/F",
      "description": "Same offer, cross-posted.",
      "created": "2026-10-12T09:30:00Z",
      "redirect_url": "https://www.adzuna.fr/details/4870000002",
      "company": { "display_name": "Acme Santé" },
      "location": { "display_name": "Paris" },
      "salary_min": 52000,
      "salary_max": 52000,
      "salary_is_predicted": "1",
      "contract_type": "permanent"
    }
  ]
}
```

`test/fixtures/wttj.json`:
```json
{
  "results": [
    {
      "hits": [
        {
          "objectID": "obj-1",
          "reference": "WTTJ-REF-1",
          "name": "Senior Fullstack Engineer (React / Node.js)",
          "slug": "senior-fullstack-engineer_paris",
          "organization": { "name": "Delta Health", "slug": "delta-health" },
          "offices": [{ "city": "Paris", "country_code": "FR" }],
          "contract_type": "full_time",
          "remote": "partial",
          "salary_minimum": 65000,
          "salary_maximum": 80000,
          "salary_period": "yearly",
          "salary_currency": "EUR",
          "published_at": "2026-10-12T14:00:00Z",
          "summary": "Event-driven architecture with Kafka."
        },
        {
          "objectID": "obj-2",
          "reference": "WTTJ-REF-2",
          "name": "Lead Developer PHP",
          "slug": "lead-developer-php_lyon",
          "organization": { "name": "Epsilon", "slug": "epsilon" },
          "offices": [{ "city": "Lyon", "country_code": "FR" }],
          "contract_type": "internship",
          "remote": "no",
          "published_at": "2026-10-12T14:00:00Z"
        },
        {
          "objectID": "obj-3",
          "reference": "WTTJ-REF-3",
          "name": "Senior Backend Engineer",
          "slug": "senior-backend-engineer",
          "organization": { "name": "Zeta", "slug": "zeta" },
          "offices": [{ "city": "Paris", "country_code": "FR" }],
          "contract_type": "full_time",
          "remote": "fulltime",
          "published_at": "2026-10-01T09:00:00Z"
        }
      ]
    }
  ]
}
```

`test/fixtures/remotive.json`:
```json
{
  "job-count": 3,
  "jobs": [
    {
      "id": 1680001,
      "url": "https://remotive.com/remote-jobs/software-dev/senior-react-full-stack-developer-1680001",
      "title": "Senior React Full-stack Developer",
      "company_name": "Eta Labs",
      "category": "Software Development",
      "tags": ["react", "node"],
      "job_type": "full_time",
      "publication_date": "2026-10-11T20:17:27",
      "candidate_required_location": "Europe",
      "salary": "€70k - €85k",
      "description": "<p>Build our <b>product</b>.</p>"
    },
    {
      "id": 1680002,
      "url": "https://remotive.com/remote-jobs/marketing/remote-office-assistant-1680002",
      "title": "Remote Office Assistant",
      "company_name": "Theta",
      "category": "Marketing",
      "tags": [],
      "job_type": "full_time",
      "publication_date": "2026-10-11T20:17:27",
      "candidate_required_location": "Worldwide",
      "salary": "$35,3k- $52k",
      "description": ""
    },
    {
      "id": 1680003,
      "url": "https://remotive.com/remote-jobs/software-dev/senior-node-engineer-1680003",
      "title": "Senior Node Engineer",
      "company_name": "Iota",
      "category": "Software Development",
      "tags": ["node"],
      "job_type": "full_time",
      "publication_date": "2026-10-12T08:00:00",
      "candidate_required_location": "USA Only",
      "salary": "",
      "description": ""
    }
  ]
}
```

`test/fixtures/remoteok.json`:
```json
[
  {
    "last_updated": 1791878411,
    "legal": "API Terms of Service: Please link back to the URL on Remote OK and mention Remote OK as a source."
  },
  {
    "slug": "remote-senior-full-stack-engineer-kappa-1137500",
    "id": "1137500",
    "epoch": 1791800000,
    "date": "2026-10-12T10:00:00+00:00",
    "company": "Kappa",
    "position": "Senior Full Stack Engineer",
    "tags": ["php", "react", "senior"],
    "description": "<p>PHP and React.</p>",
    "location": "Europe",
    "salary_min": 90000,
    "salary_max": 120000,
    "url": "https://remoteOK.com/remote-jobs/remote-senior-full-stack-engineer-kappa-1137500"
  },
  {
    "slug": "remote-senior-sales-executive-1137498",
    "id": "1137498",
    "epoch": 1791763204,
    "date": "2026-10-12T00:00:04+00:00",
    "company": "SimSpace Corporation",
    "position": "Senior Sales Executive Central Region",
    "tags": ["sales", "senior"],
    "description": "<p>Sales.</p>",
    "location": "",
    "salary_min": 145000,
    "salary_max": 220000,
    "url": "https://remoteOK.com/remote-jobs/remote-senior-sales-executive-1137498"
  }
]
```

- [ ] **Step 2: Write the failing tests**

`test/normalize.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { OFFER_COLUMNS, RUN_COLUMNS, SOURCES, pickColumns } = require('../src/lib/schema');
const { normalizeResponses } = require('../src/lib/normalize');

const NOW = new Date('2026-10-13T10:00:00Z');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const wttjConfig = { ...baseConfig, wttj: { appId: 'APP', apiKey: 'KEY', indexName: 'wttj_jobs' } };

test('schema columns', () => {
  assert.deepEqual(OFFER_COLUMNS, [
    'id', 'source', 'title', 'company', 'location', 'work_mode', 'contract',
    'salary_min', 'salary_max', 'salary_raw', 'estimated_salary', 'url',
    'published_at', 'found_at', 'score', 'score_reason', 'flags', 'status',
    'score_attempts', 'emailed_at', 'notes', 'dedupe_key',
  ]);
  assert.deepEqual(RUN_COLUMNS, ['run_at', 'source', 'fetched', 'eligible', 'error']);
  assert.deepEqual(SOURCES, ['france_travail', 'wttj', 'adzuna', 'remotive', 'remoteok']);
});

test('pickColumns keeps only sheet columns and blanks missing values', () => {
  const row = pickColumns({ id: 'a', title: 'T', row_number: 4, description: 'x', score: null });
  assert.deepEqual(Object.keys(row), OFFER_COLUMNS);
  assert.equal(row.id, 'a');
  assert.equal(row.score, '');
  assert.equal(row.notes, '');
});

test('france travail offers are mapped', () => {
  const { offers, status } = normalizeResponses('france_travail', [fixture('france-travail.json')], baseConfig, NOW);
  assert.deepEqual(status, { source: 'france_travail', fetched: 3, eligible: 3, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'france_travail:201ABCD');
  assert.equal(o.source, 'france_travail');
  assert.equal(o.title, 'Développeur Full Stack Senior PHP/Symfony (H/F)');
  assert.equal(o.company, 'Acme Santé');
  assert.equal(o.location, '75 - Paris 9e Arrondissement');
  assert.equal(o.work_mode, 'unknown');
  assert.equal(o.contract, 'CDI');
  assert.equal(o.salary_min, 60000);
  assert.equal(o.salary_max, 70000);
  assert.equal(o.salary_raw, 'Annuel de 60000.00 Euros à 70000.00 Euros sur 12 mois');
  assert.equal(o.url, 'https://candidat.francetravail.fr/offres/recherche/detail/201ABCD');
  assert.equal(o.published_at, '2026-10-12T09:15:00.000Z');
  assert.equal(o.found_at, '2026-10-13T10:00:00.000Z');
  assert.equal(o.dedupe_key, 'acme sante|developpeur full stack senior php symfony');
  assert.match(o.description, /PHP 8, Symfony, React/);
  assert.equal(offers[1].url, 'https://candidat.francetravail.fr/offres/recherche/detail/201EFGH');
  assert.equal(offers[2].salary_min, '');
  for (const col of OFFER_COLUMNS) assert.ok(col in o, `missing column ${col}`);
});

test('adzuna offers are mapped and predicted salaries are not used for filtering', () => {
  const { offers, status } = normalizeResponses('adzuna', [fixture('adzuna.json')], baseConfig, NOW);
  assert.deepEqual(status, { source: 'adzuna', fetched: 2, eligible: 2, error: '' });
  assert.equal(offers[0].id, 'adzuna:4870000001');
  assert.equal(offers[0].title, 'Tech Lead Symfony');
  assert.equal(offers[0].salary_min, 65000);
  assert.equal(offers[0].salary_max, 75000);
  assert.equal(offers[0].contract, 'permanent full_time');
  assert.equal(offers[0].url, 'https://www.adzuna.fr/details/4870000001');
  assert.equal(offers[1].salary_min, '');
  assert.equal(offers[1].salary_max, '');
  assert.equal(offers[1].salary_raw, 'Adzuna estimate: 52000-52000 EUR');
  assert.equal(offers[1].dedupe_key, 'acme sante|developpeur full stack senior php symfony');
});

test('wttj reports a configuration error when keys are missing', () => {
  const { offers, status } = normalizeResponses('wttj', [fixture('wttj.json')], baseConfig, NOW);
  assert.equal(offers.length, 0);
  assert.match(status.error, /not configured/);
});

test('wttj keeps recent full-time offers in France or fully remote', () => {
  const { offers, status } = normalizeResponses('wttj', [fixture('wttj.json')], wttjConfig, NOW);
  assert.deepEqual(status, { source: 'wttj', fetched: 3, eligible: 1, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'wttj:WTTJ-REF-1');
  assert.equal(o.company, 'Delta Health');
  assert.equal(o.location, 'Paris');
  assert.equal(o.work_mode, 'hybrid');
  assert.equal(o.salary_min, 65000);
  assert.equal(o.salary_max, 80000);
  assert.equal(o.url, 'https://www.welcometothejungle.com/fr/companies/delta-health/jobs/senior-fullstack-engineer_paris');
  assert.equal(o.description, 'Event-driven architecture with Kafka.');
});

test('remotive keeps recent software jobs open to Europe', () => {
  const { offers, status } = normalizeResponses('remotive', [fixture('remotive.json')], baseConfig, NOW);
  assert.deepEqual(status, { source: 'remotive', fetched: 3, eligible: 1, error: '' });
  const o = offers[0];
  assert.equal(o.id, 'remotive:1680001');
  assert.equal(o.work_mode, 'remote');
  assert.equal(o.location, 'Europe');
  assert.equal(o.published_at, '2026-10-11T20:17:27Z');
  assert.equal(o.salary_min, 70000);
  assert.equal(o.salary_max, 85000);
  assert.equal(o.description, 'Build our product.');
});

test('remoteok gives the same result whether n8n splits the array or not', () => {
  const asArray = normalizeResponses('remoteok', [fixture('remoteok.json')], baseConfig, NOW);
  const asItems = normalizeResponses('remoteok', fixture('remoteok.json'), baseConfig, NOW);
  assert.deepEqual(asItems, asArray);
  assert.deepEqual(asItems.status, { source: 'remoteok', fetched: 2, eligible: 1, error: '' });
  const o = asItems.offers[0];
  assert.equal(o.id, 'remoteok:1137500');
  assert.equal(o.title, 'Senior Full Stack Engineer');
  assert.equal(o.salary_raw, '90000-120000 USD');
  assert.equal(o.work_mode, 'remote');
});

test('HTTP error items are reported in the status', () => {
  const one = normalizeResponses('adzuna', [{ error: { message: '401 Unauthorized' } }], baseConfig, NOW);
  assert.deepEqual(one.status, { source: 'adzuna', fetched: 0, eligible: 0, error: '401 Unauthorized' });
  const two = normalizeResponses('adzuna', [{ error: 'timeout' }, { error: 'timeout' }, fixture('adzuna.json')], baseConfig, NOW);
  assert.equal(two.status.error, '2 requests failed: timeout');
  assert.equal(two.offers.length, 2);
});

test('an empty France Travail response (HTTP 204) gives no offers and no error', () => {
  const { offers, status } = normalizeResponses('france_travail', [{}], baseConfig, NOW);
  assert.equal(offers.length, 0);
  assert.deepEqual(status, { source: 'france_travail', fetched: 0, eligible: 0, error: '' });
});

test('duplicate offers within one source are kept once', () => {
  const ft = fixture('france-travail.json');
  const { offers } = normalizeResponses('france_travail', [ft, ft], baseConfig, NOW);
  assert.equal(offers.length, 3);
});
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `node --test test/normalize.test.js`
Expected: FAIL with `Cannot find module '../src/config'`.

- [ ] **Step 4: Implement `src/lib/schema.js`, `src/config.js` and `src/lib/normalize.js`**

`src/lib/schema.js`:
```js
// @body
// Column order of the Google Sheet tabs. The header rows in the sheet must match exactly.
const OFFER_COLUMNS = [
  'id', 'source', 'title', 'company', 'location', 'work_mode', 'contract',
  'salary_min', 'salary_max', 'salary_raw', 'estimated_salary', 'url',
  'published_at', 'found_at', 'score', 'score_reason', 'flags', 'status',
  'score_attempts', 'emailed_at', 'notes', 'dedupe_key',
];
const RUN_COLUMNS = ['run_at', 'source', 'fetched', 'eligible', 'error'];
const SOURCES = ['france_travail', 'wttj', 'adzuna', 'remotive', 'remoteok'];

function pickColumns(row) {
  const out = {};
  for (const col of OFFER_COLUMNS) {
    out[col] = row[col] === undefined || row[col] === null ? '' : row[col];
  }
  return out;
}
// @export
module.exports = { OFFER_COLUMNS, RUN_COLUMNS, SOURCES, pickColumns };
```

`src/config.js`:
```js
// Values for each workflow's Config node. Edit here, run `npm run build`, then re-import the workflows.
module.exports = {
  sheetId: '',
  sheetUrl: '',
  digestEmail: 'you@example.com',
  keywords: ['développeur full stack', 'fullstack senior', 'lead developer', 'tech lead', 'php symfony', 'node.js senior'],
  ftRegion: '11',
  adzunaWhere: 'Paris',
  adzunaDistanceKm: 40,
  wttj: { appId: '', apiKey: '', indexName: '' },
  titleIncludeRegex: 'full.?stack|lead|staff|senior|php|symfony|node|react|typescript|back.?end',
  titleExcludeRegex: '\\bjunior\\b|\\bstage\\b|stagiaire|\\bintern(ship)?\\b|alternan|apprenti|freelance|python|data scientist',
  esnBlocklist: [
    'Capgemini', 'Sopra Steria', 'Alten', 'Akkodis', 'Altran', 'CGI', 'Accenture', 'Inetum',
    'Modis', 'Atos', 'Expleo', 'Devoteam', 'Onepoint', 'Wavestone', 'Keyrus', 'SII', 'Aubay',
    'Talan', 'Extia', 'Davidson', 'Ausy', 'Neurones', 'Sword', 'Infotel',
  ],
  salaryFloor: 60000,
  scoreThreshold: 7,
  claudeModel: 'claude-opus-5-5',
  claudeEffort: 'low',
  claudeMaxTokens: 4096,
  descriptionMaxChars: 6000,
  maxRetryRows: 50,
  maxScoreAttempts: 3,
  windowHours: { wttj: 48, remotive: 72, remoteok: 48 },
  remoteTags: ['php', 'symfony', 'node', 'nodejs', 'react', 'full-stack', 'fullstack', 'full stack', 'lead', 'typescript'],
  remoteLocationRegex: 'worldwide|anywhere|europe|emea|france|\\beu\\b|\\bcet\\b|\\bcest\\b',
};
```

`src/lib/normalize.js`:
```js
const { stripHtml, dedupeKey, isWithinHours } = require('./text');
const { parseSalary } = require('./salary');
// @body
function makeOffer(source, externalId, fields, foundAt) {
  const offer = {
    id: `${source}:${externalId}`,
    source,
    title: '',
    company: '',
    location: '',
    work_mode: 'unknown',
    contract: '',
    salary_min: '',
    salary_max: '',
    salary_raw: '',
    estimated_salary: '',
    url: '',
    published_at: '',
    found_at: foundAt,
    score: '',
    score_reason: '',
    flags: '',
    status: '',
    score_attempts: 0,
    emailed_at: '',
    notes: '',
    dedupe_key: '',
    description: '',
    ...fields,
  };
  offer.title = stripHtml(offer.title);
  offer.company = String(offer.company || '').trim();
  offer.location = String(offer.location || '').trim();
  offer.dedupe_key = dedupeKey(offer.company, offer.title);
  return offer;
}

function salaryFields(raw) {
  const parsed = parseSalary(raw);
  return { salary_raw: raw || '', salary_min: parsed ? parsed.min : '', salary_max: parsed ? parsed.max : '' };
}

function matchesRemoteLocation(location, regexSource) {
  const loc = String(location || '').trim();
  if (!loc) return true;
  return new RegExp(regexSource, 'i').test(loc);
}

function fromFranceTravail(raw, foundAt) {
  return makeOffer('france_travail', raw.id, {
    title: raw.intitule,
    company: raw.entreprise?.nom,
    location: raw.lieuTravail?.libelle,
    contract: raw.typeContrat || '',
    ...salaryFields(raw.salaire?.libelle),
    url: raw.origineOffre?.urlOrigine || `https://candidat.francetravail.fr/offres/recherche/detail/${raw.id}`,
    published_at: raw.dateCreation || '',
    description: stripHtml(raw.description),
  }, foundAt);
}

function fromAdzuna(raw, foundAt) {
  const lo = Math.round(Number(raw.salary_min) || Number(raw.salary_max) || 0);
  const hi = Math.round(Number(raw.salary_max) || lo);
  const predicted = String(raw.salary_is_predicted) === '1';
  let salary = {};
  if (lo && predicted) salary = { salary_raw: `Adzuna estimate: ${lo}-${hi} EUR` };
  else if (lo) salary = { salary_raw: `${lo}-${hi} EUR`, salary_min: lo, salary_max: hi };
  return makeOffer('adzuna', raw.id, {
    title: raw.title,
    company: raw.company?.display_name,
    location: raw.location?.display_name,
    contract: [raw.contract_type, raw.contract_time].filter(Boolean).join(' '),
    ...salary,
    url: raw.redirect_url || '',
    published_at: raw.created || '',
    description: stripHtml(raw.description),
  }, foundAt);
}

const WTTJ_WORK_MODES = { fulltime: 'remote', partial: 'hybrid', punctual: 'onsite', no: 'onsite' };

function fromWttj(hit, foundAt) {
  const offices = Array.isArray(hit.offices) ? hit.offices : [];
  const lo = Number(hit.salary_minimum) || Number(hit.salary_maximum) || 0;
  const hi = Number(hit.salary_maximum) || lo;
  const yearly = !hit.salary_period || hit.salary_period === 'yearly';
  const salary = lo && yearly
    ? { salary_raw: `${lo}-${hi} ${hit.salary_currency || 'EUR'}`, salary_min: lo, salary_max: hi }
    : {};
  const org = hit.organization || {};
  return makeOffer('wttj', hit.reference || hit.objectID, {
    title: hit.name,
    company: org.name,
    location: offices.map((o) => o.city).filter(Boolean).join(', ') || (hit.remote === 'fulltime' ? 'Remote' : ''),
    work_mode: WTTJ_WORK_MODES[hit.remote] || 'unknown',
    contract: hit.contract_type || '',
    ...salary,
    url: org.slug && hit.slug ? `https://www.welcometothejungle.com/fr/companies/${org.slug}/jobs/${hit.slug}` : '',
    published_at: hit.published_at || '',
    description: stripHtml([hit.summary, hit.profile].filter(Boolean).join('\n')),
  }, foundAt);
}

// Remotive dates have no timezone; they are UTC.
function remotiveDate(job) {
  const d = job.publication_date || '';
  return d && !/(z|[+-]\d\d:?\d\d)$/i.test(d) ? `${d}Z` : d;
}

function fromRemotive(job, foundAt) {
  return makeOffer('remotive', job.id, {
    title: job.title,
    company: job.company_name,
    location: job.candidate_required_location,
    work_mode: 'remote',
    contract: job.job_type || '',
    ...salaryFields(job.salary),
    url: job.url || '',
    published_at: remotiveDate(job),
    description: stripHtml(job.description),
  }, foundAt);
}

function fromRemoteOk(job, foundAt) {
  const lo = Number(job.salary_min) || 0;
  const hi = Number(job.salary_max) || lo;
  const salary = lo ? { salary_raw: `${lo}-${hi} USD`, salary_min: lo, salary_max: hi } : {};
  return makeOffer('remoteok', job.id, {
    title: job.position,
    company: job.company,
    location: job.location || 'Remote',
    work_mode: 'remote',
    ...salary,
    url: job.url || job.apply_url || '',
    published_at: job.date || '',
    description: stripHtml(job.description),
  }, foundAt);
}

const MAPPERS = {
  france_travail: fromFranceTravail,
  adzuna: fromAdzuna,
  wttj: fromWttj,
  remotive: fromRemotive,
  remoteok: fromRemoteOk,
};

function isEligible(source, raw, config, now) {
  const hours = config.windowHours;
  if (source === 'wttj') {
    const offices = Array.isArray(raw.offices) ? raw.offices : [];
    return raw.contract_type === 'full_time'
      && (raw.remote === 'fulltime' || offices.some((o) => o.country_code === 'FR'))
      && isWithinHours(raw.published_at, hours.wttj, now);
  }
  if (source === 'remotive') {
    return raw.category === 'Software Development'
      && matchesRemoteLocation(raw.candidate_required_location, config.remoteLocationRegex)
      && isWithinHours(remotiveDate(raw), hours.remotive, now);
  }
  if (source === 'remoteok') {
    const tags = (Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t).toLowerCase());
    return config.remoteTags.some((t) => tags.includes(t))
      && matchesRemoteLocation(raw.location, config.remoteLocationRegex)
      && isWithinHours(raw.date, hours.remoteok, now);
  }
  return true;
}

function extractRaw(source, response) {
  if (source === 'france_travail') return Array.isArray(response.resultats) ? response.resultats : [];
  if (source === 'adzuna') return Array.isArray(response.results) ? response.results : [];
  if (source === 'wttj') {
    const results = Array.isArray(response.results) ? response.results : [];
    return results.flatMap((r) => (Array.isArray(r.hits) ? r.hits : []));
  }
  if (source === 'remotive') return Array.isArray(response.jobs) ? response.jobs : [];
  if (source === 'remoteok') {
    // n8n splits a top-level JSON array into one item per element; accept both shapes.
    return (Array.isArray(response) ? response : [response]).filter((j) => j && j.id && j.position);
  }
  throw new Error(`Unknown source: ${source}`);
}

function responseError(response) {
  if (!response || typeof response !== 'object') return 'empty response';
  if (!response.error) return '';
  if (typeof response.error === 'string') return response.error;
  return response.error.message || JSON.stringify(response.error);
}

function normalizeResponses(source, responses, config, now) {
  const offers = [];
  if (source === 'wttj' && !(config.wttj && config.wttj.appId && config.wttj.apiKey && config.wttj.indexName)) {
    return { offers, status: { source, fetched: 0, eligible: 0, error: 'not configured (set wttj.appId, wttj.apiKey and wttj.indexName in src/config.js)' } };
  }
  const foundAt = now.toISOString();
  const errors = [];
  const seen = new Set();
  let fetched = 0;
  for (const response of responses) {
    const error = responseError(response);
    if (error) {
      errors.push(error);
      continue;
    }
    for (const raw of extractRaw(source, response)) {
      fetched += 1;
      if (!isEligible(source, raw, config, now)) continue;
      const offer = MAPPERS[source](raw, foundAt);
      if (!offer.title || !offer.url || seen.has(offer.id)) continue;
      seen.add(offer.id);
      offers.push(offer);
    }
  }
  let error = '';
  if (errors.length === 1) error = errors[0];
  if (errors.length > 1) error = `${errors.length} requests failed: ${errors[0]}`;
  return { offers, status: { source, fetched, eligible: offers.length, error } };
}
// @export
module.exports = { normalizeResponses };
```

Note: the "duplicate offers within one source" test checks `offers.length` only. `fetched` counts every raw job received (6 in that test).

- [ ] **Step 5: Run the tests to check they pass**

Run: `node --test test/normalize.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schema.js src/config.js src/lib/normalize.js test/fixtures test/normalize.test.js
git commit -m "feat: add sheet schema, config and source normalizers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Deduplication and keyword pre-filter

**Files:**
- Create: `src/lib/dedupe.js`, `src/lib/prefilter.js`
- Test: `test/dedupe.test.js`, `test/prefilter.test.js`

**Interfaces:**
- Consumes: `normalizeKey` (text.js), config keys `titleIncludeRegex`, `titleExcludeRegex`, `esnBlocklist`, `salaryFloor`
- Produces: `dedupe(offers: Offer[], existingRows: object[]): Offer[]` (first occurrence wins), `prefilter(offers, config): { kept: Offer[], dropped: { offer, reason }[] }`, `prefilterReason(offer, config): string` (`''` when kept)

- [ ] **Step 1: Write the failing tests**

`test/dedupe.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupe } = require('../src/lib/dedupe');

const offer = (id, key) => ({ id, dedupe_key: key });

test('drops offers whose id is already in the sheet', () => {
  const out = dedupe([offer('a:1', 'k1'), offer('a:2', 'k2')], [{ id: 'a:1', dedupe_key: 'other' }]);
  assert.deepEqual(out.map((o) => o.id), ['a:2']);
});

test('drops offers whose dedupe key is already in the sheet (cross-posted)', () => {
  const out = dedupe([offer('b:9', 'acme|dev')], [{ id: 'a:1', dedupe_key: 'acme|dev' }]);
  assert.deepEqual(out, []);
});

test('keeps the first of two duplicates in the same batch', () => {
  const out = dedupe([offer('a:1', 'k'), offer('b:1', 'k'), offer('a:1', 'z')], []);
  assert.deepEqual(out.map((o) => o.id), ['a:1']);
});

test('offers without a dedupe key are only deduped by id', () => {
  const out = dedupe([offer('a:1', ''), offer('b:1', '')], [{ id: 'c:1', dedupe_key: '' }]);
  assert.deepEqual(out.map((o) => o.id), ['a:1', 'b:1']);
});

test('works with an empty sheet and ignores empty rows', () => {
  assert.deepEqual(dedupe([offer('a:1', 'k')], [{}]).map((o) => o.id), ['a:1']);
});
```

`test/prefilter.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { prefilter, prefilterReason } = require('../src/lib/prefilter');

const offer = (title, company = 'Acme', salaryMax = '') => ({ id: title, title, company, salary_max: salaryMax });

const cases = [
  [offer('Développeur Full Stack Senior'), ''],
  [offer('Tech Lead Symfony'), ''],
  [offer('Lead Developer International'), ''],
  [offer('Comptable'), 'title not matching'],
  [offer('Développeur Full Stack Junior'), 'title excluded'],
  [offer('Senior Python Developer'), 'title excluded'],
  [offer('Stage Développeur Full Stack'), 'title excluded'],
  [offer('Lead Developer', 'Capgemini Engineering'), 'ESN: Capgemini'],
  [offer('Lead Developer', 'Sopra Steria Group'), 'ESN: Sopra Steria'],
  [offer('Lead Developer', 'CGI France'), 'ESN: CGI'],
  [offer('Lead Developer', 'Catalana Tech'), ''],
  [offer('Lead Developer', 'Acme', 55000), 'salary below floor'],
  [offer('Lead Developer', 'Acme', '55000'), 'salary below floor'],
  [offer('Lead Developer', 'Acme', 65000), ''],
  [offer('Lead Developer', 'Acme', ''), ''],
];

for (const [o, expected] of cases) {
  test(`prefilterReason: ${o.title} @ ${o.company} (${o.salary_max})`, () => {
    assert.equal(prefilterReason(o, config), expected);
  });
}

test('prefilter splits kept and dropped offers', () => {
  const { kept, dropped } = prefilter([offer('Lead Developer'), offer('Comptable')], config);
  assert.deepEqual(kept.map((o) => o.title), ['Lead Developer']);
  assert.deepEqual(dropped.map((d) => d.reason), ['title not matching']);
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/dedupe.test.js test/prefilter.test.js`
Expected: FAIL with `Cannot find module '../src/lib/dedupe'` and `'../src/lib/prefilter'`.

- [ ] **Step 3: Implement `src/lib/dedupe.js` and `src/lib/prefilter.js`**

`src/lib/dedupe.js`:
```js
// @body
function dedupe(offers, existingRows) {
  const ids = new Set(existingRows.filter((r) => r.id).map((r) => String(r.id)));
  const keys = new Set(existingRows.map((r) => r.dedupe_key).filter(Boolean));
  const out = [];
  for (const offer of offers) {
    if (ids.has(offer.id)) continue;
    if (offer.dedupe_key && keys.has(offer.dedupe_key)) continue;
    ids.add(offer.id);
    if (offer.dedupe_key) keys.add(offer.dedupe_key);
    out.push(offer);
  }
  return out;
}
// @export
module.exports = { dedupe };
```

`src/lib/prefilter.js`:
```js
const { normalizeKey } = require('./text');
// @body
function prefilterReason(offer, config) {
  if (!new RegExp(config.titleIncludeRegex, 'i').test(offer.title)) return 'title not matching';
  if (new RegExp(config.titleExcludeRegex, 'i').test(offer.title)) return 'title excluded';
  const company = ` ${normalizeKey(offer.company)} `;
  const esn = config.esnBlocklist.find((name) => company.includes(` ${normalizeKey(name)} `));
  if (esn) return `ESN: ${esn}`;
  const max = offer.salary_max;
  if (max !== '' && max !== null && max !== undefined && Number(max) < config.salaryFloor) return 'salary below floor';
  return '';
}

function prefilter(offers, config) {
  const kept = [];
  const dropped = [];
  for (const offer of offers) {
    const reason = prefilterReason(offer, config);
    if (reason) dropped.push({ offer, reason });
    else kept.push(offer);
  }
  return { kept, dropped };
}
// @export
module.exports = { prefilter, prefilterReason };
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test test/dedupe.test.js test/prefilter.test.js`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dedupe.js src/lib/prefilter.js test/dedupe.test.js test/prefilter.test.js
git commit -m "feat: add deduplication and keyword pre-filter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Claude scoring request, response parser and system prompt

**Files:**
- Create: `src/lib/scoring.js`, `prompts/scoring-system-prompt.md`
- Create: `test/fixtures/claude-response.json`
- Test: `test/scoring.test.js`

**Interfaces:**
- Consumes: `truncate` (text.js); config keys `claudeModel`, `claudeMaxTokens`, `claudeEffort`, `descriptionMaxChars`, `systemPrompt` (added by the build from the prompt file)
- Produces: `SCORE_FLAGS`, `WORK_MODES`, `SCORING_SCHEMA`, `buildScoringRequest(row, description: string, config): object` (the full `/v1/messages` body), `parseScoringResponse(response): { ok: true, score, reason, flags: string[], work_mode, estimated_salary } | { ok: false, error: string }`

- [ ] **Step 1: Write the system prompt**

`prompts/scoring-system-prompt.md`:
```markdown
You score job offers for one candidate. Read the offer and judge how well it matches the candidate's profile and preferences.

## Candidate
- Senior Full Stack Developer with about 10 years of professional experience.
- Current role: Full Stack Developer at a fully remote SaaS company. Before that: back-end PHP/Symfony roles and a few years at a consulting firm (ESN).
- Stack: expert in PHP and Symfony, with a strong taste for clean architecture and DDD. React on the front end. Node.js microservices with Kafka (event-driven) in production. Docker.
- Has mentored many junior developers and taught web development courses.
- French native, professional English.

## What they want
- Roles: Senior Full Stack Developer, Lead Developer, Lead Engineer, Tech Lead. Staff Engineer is fine.
- Contract: CDI. For fully remote roles at companies outside France, a salaried contract through an employer of record is fine. Freelance or contractor-only is not wanted.
- Salary: at least €60K gross per year.
- Location: lives east of Paris. Paris and the north/east of Île-de-France are fine in hybrid with at least 2 remote days. The far west suburbs (La Défense, Saclay, Yvelines) are a long commute. Fully remote is the best case, including at foreign companies that hire residents of France.
- Avoid: consulting and staffing firms (ESN, SSII, "société de conseil"), and roles where Python is the main language.

## Scoring rubric
1. Start from role and stack fit:
   - Senior Full Stack or Lead/Tech Lead role on PHP/Symfony, Node.js or React: 7 to 9.
   - Senior role on an adjacent stack (TypeScript back end, Laravel, Next.js, NestJS): 6 to 8.
   - Unrelated stack or role (Java only, .NET only, mobile only, data, DevOps only, not engineering): 0 to 4.
2. Add 1 point for each of these, up to 10: DDD or clean architecture; event-driven architecture (Kafka or similar); product company (not an agency); at least 2 remote days or fully remote; mentoring or technical leadership.
3. Then apply the caps below. When several apply, the lowest one wins.
   - Consulting or staffing firm (ESN): at most 2. Flag "esn".
   - Python is the main language: at most 4. Flag "python_heavy".
   - Freelance or contractor only: at most 4. Flag "contractor_only".
   - Not a CDI or an equivalent salaried contract: at most 4. Flag "not_cdi".
   - Stated salary below €60K per year: at most 3. Flag "salary_below_60k".
   - Junior or mid-level role: at most 4. Flag "not_senior".
   - Onsite only, or fewer than 2 remote days: at most 5. Flag "onsite_only".
   - Office in the far west suburbs without full remote: at most 5. Flag "far_commute".
   - Office outside Île-de-France without full remote: at most 3. Flag "far_commute".
   - Fully remote at a company outside France that does not hire residents of France or the EU: at most 3.
4. A missing salary is neutral. A missing remote policy is neutral: use work_mode "unknown".

## Output fields
- score: integer from 0 to 10, after the caps.
- reason: one sentence in English, at most 160 characters, naming the main driver of the score.
- flags: every flag from the list above that applies. An empty list if none.
- work_mode: "remote", "hybrid", "onsite", or "unknown" if the offer doesn't say.
- estimated_salary: the yearly gross salary range if the offer states or clearly implies one (for example "60-70k EUR"), otherwise null.
```

- [ ] **Step 2: Create the response fixture**

`test/fixtures/claude-response.json`:
```json
{
  "id": "msg_01",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5-5",
  "stop_reason": "end_turn",
  "content": [
    { "type": "thinking", "thinking": "", "signature": "sig" },
    { "type": "text", "text": "{\"score\":8,\"reason\":\"Senior Symfony full stack role with 2 remote days at a product company.\",\"flags\":[],\"work_mode\":\"hybrid\",\"estimated_salary\":\"60-70k EUR\"}" }
  ],
  "usage": { "input_tokens": 1800, "output_tokens": 60 }
}
```

- [ ] **Step 3: Write the failing tests**

`test/scoring.test.js`:
```js
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
```

- [ ] **Step 4: Run the tests to check they fail**

Run: `node --test test/scoring.test.js`
Expected: FAIL with `Cannot find module '../src/lib/scoring'`.

- [ ] **Step 5: Implement `src/lib/scoring.js`**

```js
const { truncate } = require('./text');
// @body
const SCORE_FLAGS = ['esn', 'python_heavy', 'contractor_only', 'salary_below_60k', 'onsite_only', 'far_commute', 'not_senior', 'not_cdi'];
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
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `node --test test/scoring.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scoring.js prompts/scoring-system-prompt.md test/fixtures/claude-response.json test/scoring.test.js
git commit -m "feat: add Claude scoring request, parser and system prompt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Collector pipeline (prepare, apply scores, run log)

**Files:**
- Create: `src/lib/pipeline.js`
- Test: `test/pipeline.test.js`

**Interfaces:**
- Consumes: `pickColumns` (schema.js), `dedupe`, `prefilter`, `buildScoringRequest`, `parseScoringResponse`
- Produces:
  - `prepareCollectorRun(fetched: object[], existingRows: object[], config): PreparedItem[]`, where `PreparedItem = { op: 'append' | 'update', row: object /* OFFER_COLUMNS keys only */, noDescription: boolean, claudeRequest: object }`. `fetched` is the Merge output: status items `{ _status }` and offers. Retry rows come first.
  - `applyScores(prepared: PreparedItem[], responses: object[], config): { op, row }[]`. Throws when the lengths differ.
  - `buildRunLog(fetched: object[], now: Date): object[]` (rows with `RUN_COLUMNS` keys)

- [ ] **Step 1: Write the failing tests**

`test/pipeline.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { OFFER_COLUMNS, RUN_COLUMNS } = require('../src/lib/schema');
const { prepareCollectorRun, applyScores, buildRunLog } = require('../src/lib/pipeline');

const config = { ...baseConfig, systemPrompt: 'SYS' };
const okResponse = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-response.json'), 'utf8'));
const status = (source) => ({ _status: { source, fetched: 3, eligible: 2, error: '' } });
const offer = (id, title, extra = {}) => ({
  id, source: 'adzuna', title, company: 'Acme', location: 'Paris', work_mode: 'unknown', contract: 'CDI',
  salary_min: '', salary_max: '', salary_raw: '', url: `https://x/${id}`, dedupe_key: `acme|${id}`,
  found_at: '2026-10-13T10:00:00.000Z', description: 'desc', ...extra,
});

test('prepareCollectorRun retries to_score rows first, then new offers that pass the filters', () => {
  const fetched = [status('adzuna'), offer('adzuna:1', 'Lead Developer'), offer('adzuna:2', 'Développeur Junior'), offer('adzuna:3', 'Tech Lead')];
  const rows = [
    { id: 'adzuna:3', status: 'new', dedupe_key: 'acme|adzuna:3' },
    { id: 'old:1', status: 'to_score', title: 'Senior PHP Developer', source: 'adzuna', score_attempts: '1', row_number: 5 },
  ];
  const items = prepareCollectorRun(fetched, rows, config);
  assert.deepEqual(items.map((i) => [i.op, i.row.id]), [['update', 'old:1'], ['append', 'adzuna:1']]);

  const [retry, fresh] = items;
  assert.equal(retry.noDescription, true);
  assert.equal('row_number' in retry.row, false);
  assert.match(retry.claudeRequest.messages[0].content, /Description: \(not available/);

  assert.deepEqual(Object.keys(fresh.row), OFFER_COLUMNS);
  assert.equal(fresh.row.status, 'to_score');
  assert.equal(fresh.row.score_attempts, 0);
  assert.equal(fresh.noDescription, false);
  assert.equal('description' in fresh.row, false);
  assert.match(fresh.claudeRequest.messages[0].content, /Description:\ndesc/);
});

test('prepareCollectorRun caps the number of retried rows', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `r:${i}`, status: 'to_score', title: 'T' }));
  assert.equal(prepareCollectorRun([], rows, config).length, 50);
});

test('prepareCollectorRun works on an empty sheet (one empty item from n8n)', () => {
  const items = prepareCollectorRun([status('adzuna'), offer('adzuna:1', 'Lead Developer')], [{}], config);
  assert.deepEqual(items.map((i) => i.op), ['append']);
});

test('applyScores writes successful scores', () => {
  const [item] = prepareCollectorRun([offer('adzuna:1', 'Lead Developer')], [], config);
  const [{ op, row }] = applyScores([item], [okResponse()], config);
  assert.equal(op, 'append');
  assert.equal(row.status, 'new');
  assert.equal(row.score, 8);
  assert.equal(row.score_reason, 'Senior Symfony full stack role with 2 remote days at a product company.');
  assert.equal(row.flags, '');
  assert.equal(row.work_mode, 'hybrid');
  assert.equal(row.estimated_salary, '60-70k EUR');
  assert.equal(row.score_attempts, 1);
});

test('applyScores notes when an offer was scored without its description', () => {
  const [item] = prepareCollectorRun([], [{ id: 'old:1', status: 'to_score', title: 'T', score_attempts: '1' }], config);
  const [{ op, row }] = applyScores([item], [okResponse()], config);
  assert.equal(op, 'update');
  assert.match(row.score_reason, /\(scored without description\)$/);
  assert.equal(row.score_attempts, 2);
});

test('applyScores keeps failed offers for a retry, then gives up after 3 attempts', () => {
  const [fresh] = prepareCollectorRun([offer('adzuna:1', 'Lead Developer')], [], config);
  const [{ row: first }] = applyScores([fresh], [{ error: { message: 'timeout' } }], config);
  assert.equal(first.status, 'to_score');
  assert.equal(first.score, '');
  assert.equal(first.score_reason, 'scoring failed: timeout');
  assert.equal(first.score_attempts, 1);

  const [retry] = prepareCollectorRun([], [{ ...first, score_attempts: '2' }], config);
  const [{ row: last }] = applyScores([retry], [{ error: 'timeout' }], config);
  assert.equal(last.status, 'score_failed');
  assert.equal(last.score_attempts, 3);
});

test('applyScores throws when responses do not line up with prepared items', () => {
  const items = prepareCollectorRun([offer('adzuna:1', 'Lead Developer')], [], config);
  assert.throws(() => applyScores(items, [], config), /1 prepared items but 0 responses/);
});

test('buildRunLog turns status items into run rows', () => {
  const log = buildRunLog([status('adzuna'), offer('adzuna:1', 'Lead'), status('wttj')], new Date('2026-10-13T10:00:00Z'));
  assert.deepEqual(log, [
    { run_at: '2026-10-13T10:00:00.000Z', source: 'adzuna', fetched: 3, eligible: 2, error: '' },
    { run_at: '2026-10-13T10:00:00.000Z', source: 'wttj', fetched: 3, eligible: 2, error: '' },
  ]);
  assert.deepEqual(Object.keys(log[0]), RUN_COLUMNS);
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/pipeline.test.js`
Expected: FAIL with `Cannot find module '../src/lib/pipeline'`.

- [ ] **Step 3: Implement `src/lib/pipeline.js`**

```js
const { pickColumns } = require('./schema');
const { dedupe } = require('./dedupe');
const { prefilter } = require('./prefilter');
const { buildScoringRequest, parseScoringResponse } = require('./scoring');
// @body
function prepareCollectorRun(fetched, existingRows, config) {
  const rows = existingRows.filter((r) => r && r.id);
  const offers = fetched.filter((f) => !f._status && f.id);
  const retryRows = rows.filter((r) => r.status === 'to_score').slice(0, config.maxRetryRows);
  const { kept } = prefilter(dedupe(offers, rows), config);
  const items = [];
  for (const existing of retryRows) {
    const row = pickColumns(existing);
    items.push({ op: 'update', row, noDescription: true, claudeRequest: buildScoringRequest(row, '', config) });
  }
  for (const offer of kept) {
    const row = pickColumns({ ...offer, status: 'to_score', score_attempts: 0 });
    items.push({
      op: 'append',
      row,
      noDescription: !offer.description,
      claudeRequest: buildScoringRequest(row, offer.description, config),
    });
  }
  return items;
}

function applyScores(prepared, responses, config) {
  if (prepared.length !== responses.length) {
    throw new Error(`Scoring mismatch: ${prepared.length} prepared items but ${responses.length} responses`);
  }
  return prepared.map((item, i) => {
    const result = parseScoringResponse(responses[i]);
    const attempts = (Number(item.row.score_attempts) || 0) + 1;
    const row = { ...item.row, score_attempts: attempts };
    if (result.ok) {
      Object.assign(row, {
        score: result.score,
        score_reason: item.noDescription ? `${result.reason} (scored without description)` : result.reason,
        flags: result.flags.join(','),
        work_mode: result.work_mode === 'unknown' ? row.work_mode : result.work_mode,
        estimated_salary: result.estimated_salary,
        status: 'new',
      });
    } else {
      Object.assign(row, {
        score: '',
        score_reason: `scoring failed: ${result.error}`,
        status: attempts >= config.maxScoreAttempts ? 'score_failed' : 'to_score',
      });
    }
    return { op: item.op, row };
  });
}

function buildRunLog(fetched, now) {
  const runAt = now.toISOString();
  return fetched
    .filter((f) => f._status)
    .map((f) => ({ run_at: runAt, source: f._status.source, fetched: f._status.fetched, eligible: f._status.eligible, error: f._status.error }));
}
// @export
module.exports = { prepareCollectorRun, applyScores, buildRunLog };
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test test/pipeline.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline.js test/pipeline.test.js
git commit -m "feat: add collector pipeline (prepare, apply scores, run log)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Digest builder and error email

**Files:**
- Create: `src/lib/digest.js`
- Test: `test/digest.test.js`

**Interfaces:**
- Consumes: `SOURCES` (schema.js), `escapeHtml` (text.js); config keys `scoreThreshold`, `sheetUrl`
- Produces: `selectDigestRows(rows, threshold): object[]`, `sourceHealth(runs, now): { source, label, runs, fetched, lastError, ok }[]`, `recentStats(rows, now): { collected, scored }`, `digestSubject(count, now): string`, `renderDigestHtml(selected, health, stats, config): string`, `buildDigest(rows, runs, config, now): { subject, html, ids: string[] } | null`, `formatErrorEmail(errorData, to): { to, subject, html }`

- [ ] **Step 1: Write the failing tests**

`test/digest.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const {
  selectDigestRows, sourceHealth, recentStats, digestSubject, renderDigestHtml, buildDigest, formatErrorEmail,
} = require('../src/lib/digest');

const NOW = new Date('2026-10-13T06:00:00Z'); // 08:00 in Paris
const config = { ...baseConfig, sheetUrl: 'https://docs.google.com/spreadsheets/d/abc' };
const row = (id, status, score, extra = {}) => ({
  id, status, score, source: 'adzuna', title: `Job ${id}`, company: 'Acme', location: 'Paris', work_mode: 'hybrid',
  salary_raw: '', estimated_salary: '', score_reason: 'Good fit.', flags: '', url: `https://example.com/${id}`,
  published_at: '2026-10-12T08:00:00Z', found_at: '2026-10-12T15:00:00.000Z', ...extra,
});

test('selectDigestRows keeps new rows at or above the threshold, best first', () => {
  const rows = [
    row('a', 'new', '8'),
    row('b', 'new', '6'),
    row('c', 'emailed', '9'),
    row('d', 'new', ''),
    row('e', 'new', '9'),
    row('f', 'new', '0'),
    row('g', 'new', '8', { published_at: '2026-10-12T20:00:00Z' }),
    row('h', 'to_score', ''),
  ];
  assert.deepEqual(selectDigestRows(rows, 7).map((r) => r.id), ['e', 'g', 'a']);
});

test('sourceHealth summarizes the last 24h of runs per source', () => {
  const runs = [
    { run_at: '2026-10-13T05:00:00.000Z', source: 'france_travail', fetched: '12', eligible: '12', error: '' },
    { run_at: '2026-10-12T17:00:00.000Z', source: 'france_travail', fetched: '3', eligible: '3', error: '' },
    { run_at: '2026-10-13T05:00:00.000Z', source: 'adzuna', fetched: '0', eligible: '0', error: '401 Unauthorized' },
    { run_at: '2026-10-11T05:00:00.000Z', source: 'wttj', fetched: '40', eligible: '5', error: '' },
    { run_at: '2026-10-13T05:00:00.000Z', source: 'remotive', fetched: '0', eligible: '0', error: '' },
  ];
  const health = sourceHealth(runs, NOW);
  assert.deepEqual(health.map((h) => [h.source, h.runs, h.fetched, h.ok]), [
    ['france_travail', 2, 15, true],
    ['wttj', 0, 0, false],
    ['adzuna', 1, 0, false],
    ['remotive', 1, 0, false],
    ['remoteok', 0, 0, false],
  ]);
  assert.equal(health[2].lastError, '401 Unauthorized');
  assert.equal(health[0].label, 'France Travail');
});

test('recentStats counts offers saved and scored in the last 24h', () => {
  const rows = [row('a', 'new', '8'), row('b', 'to_score', ''), row('c', 'new', '5', { found_at: '2026-10-10T10:00:00.000Z' })];
  assert.deepEqual(recentStats(rows, NOW), { collected: 2, scored: 1 });
});

test('digestSubject uses the Paris date and pluralizes', () => {
  assert.equal(digestSubject(1, NOW), '🎯 Job digest: 1 new match (13/10)');
  assert.equal(digestSubject(3, new Date('2026-10-13T22:30:00Z')), '🎯 Job digest: 3 new matches (14/10)');
});

test('renderDigestHtml escapes job data and never links unsafe URLs', () => {
  const evil = row('x', 'new', '9', { title: '<script>alert(1)</script>', company: 'Tom & Jerry', url: 'javascript:alert(1)', flags: 'far_commute,esn' });
  const html = renderDigestHtml([evil], sourceHealth([], NOW), { collected: 1, scored: 1 }, config);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Tom &amp; Jerry'));
  assert.ok(html.includes('href="#"'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('far_commute'));
});

test('renderDigestHtml shows salary, warnings, sheet link and attributions', () => {
  const rows = [
    row('a', 'new', '8', { source: 'remoteok', salary_raw: '90000-120000 USD' }),
    row('b', 'new', '7', { source: 'remotive', estimated_salary: '60-70k EUR' }),
  ];
  const runs = [{ run_at: '2026-10-13T05:00:00.000Z', source: 'adzuna', fetched: '0', eligible: '0', error: '401 Unauthorized' }];
  const html = renderDigestHtml(rows, sourceHealth(runs, NOW), { collected: 2, scored: 2 }, config);
  assert.ok(html.includes('90000-120000 USD'));
  assert.ok(html.includes('~60-70k EUR (estimated)'));
  assert.ok(html.includes('⚠️ Adzuna: error: 401 Unauthorized'));
  assert.ok(html.includes('⚠️ Welcome to the Jungle: no runs logged in 24h'));
  assert.ok(html.includes('href="https://docs.google.com/spreadsheets/d/abc"'));
  assert.ok(html.includes('Jobs via <a href="https://remoteok.com">Remote OK</a>'));
  assert.ok(html.includes('Jobs via <a href="https://remotive.com">Remotive</a>'));
  assert.ok(html.includes('score ≥ 7'));
});

test('buildDigest returns null when nothing qualifies', () => {
  assert.equal(buildDigest([row('a', 'new', '5')], [], config, NOW), null);
  assert.equal(buildDigest([], [], config, NOW), null);
});

test('buildDigest returns the subject, html and ids to mark as emailed', () => {
  const d = buildDigest([row('a', 'new', '8'), row('b', 'new', '9'), row('c', 'new', '3')], [], config, NOW);
  assert.equal(d.subject, '🎯 Job digest: 2 new matches (13/10)');
  assert.deepEqual(d.ids, ['b', 'a']);
  assert.ok(d.html.includes('Job b'));
  assert.ok(!d.html.includes('Job c'));
});

test('formatErrorEmail describes the failed workflow', () => {
  const email = formatErrorEmail({
    workflow: { id: '1', name: 'job-hunter-collector' },
    execution: { id: '42', url: 'https://n8n.example.com/execution/42', lastNodeExecuted: 'Read Offers', error: { message: 'Sheet <not> found' } },
  }, 'me@example.com');
  assert.equal(email.to, 'me@example.com');
  assert.equal(email.subject, '⚠️ n8n job hunter: job-hunter-collector failed');
  assert.ok(email.html.includes('Read Offers'));
  assert.ok(email.html.includes('Sheet &lt;not&gt; found'));
  assert.ok(email.html.includes('href="https://n8n.example.com/execution/42"'));
  assert.equal(formatErrorEmail({}, 'me@example.com').subject, '⚠️ n8n job hunter: unknown workflow failed');
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/digest.test.js`
Expected: FAIL with `Cannot find module '../src/lib/digest'`.

- [ ] **Step 3: Implement `src/lib/digest.js`**

```js
const { SOURCES } = require('./schema');
const { escapeHtml } = require('./text');
// @body
const SOURCE_LABELS = {
  france_travail: 'France Travail',
  wttj: 'Welcome to the Jungle',
  adzuna: 'Adzuna',
  remotive: 'Remotive',
  remoteok: 'Remote OK',
};
const DAY_MS = 24 * 3600 * 1000;

function hasScore(row) {
  return row.score !== '' && row.score !== null && row.score !== undefined;
}

function selectDigestRows(rows, threshold) {
  return rows
    .filter((r) => r.status === 'new' && hasScore(r) && Number(r.score) >= threshold)
    .sort((a, b) => Number(b.score) - Number(a.score)
      || (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0));
}

function isRecent(dateish, now) {
  return now.getTime() - Date.parse(dateish) <= DAY_MS;
}

function sourceHealth(runs, now) {
  const recent = runs.filter((r) => isRecent(r.run_at, now));
  return SOURCES.map((source) => {
    const mine = recent.filter((r) => r.source === source);
    const fetched = mine.reduce((sum, r) => sum + (Number(r.fetched) || 0), 0);
    const errors = mine.filter((r) => r.error).map((r) => String(r.error));
    return {
      source,
      label: SOURCE_LABELS[source],
      runs: mine.length,
      fetched,
      lastError: errors.length ? errors[errors.length - 1] : '',
      ok: mine.length > 0 && fetched > 0,
    };
  });
}

function recentStats(rows, now) {
  const recent = rows.filter((r) => isRecent(r.found_at, now));
  return { collected: recent.length, scored: recent.filter(hasScore).length };
}

function digestSubject(count, now) {
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' }).format(now);
  return `🎯 Job digest: ${count} new match${count === 1 ? '' : 'es'} (${date})`;
}

function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '#';
}

function scoreColor(score) {
  if (score >= 9) return '#15803d';
  if (score >= 8) return '#2563eb';
  return '#a16207';
}

function renderOfferCard(row) {
  const score = Number(row.score);
  let salary = 'not specified';
  if (row.salary_raw) salary = row.salary_raw;
  else if (row.estimated_salary) salary = `~${row.estimated_salary} (estimated)`;
  const flags = String(row.flags || '').split(',').filter(Boolean)
    .map((f) => `<span style="display:inline-block;margin:2px 4px 0 0;padding:1px 6px;border-radius:8px;background:#fee2e2;color:#991b1b;font-size:12px">${escapeHtml(f)}</span>`)
    .join('');
  const company = row.company ? ` <span style="color:#6b7280;font-weight:400">@ ${escapeHtml(row.company)}</span>` : '';
  return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 12px">
<div style="font-size:16px;font-weight:600"><span style="display:inline-block;min-width:28px;padding:2px 8px;margin-right:8px;border-radius:12px;background:${scoreColor(score)};color:#fff;text-align:center">${score}</span>${escapeHtml(row.title)}${company}</div>
<div style="color:#374151;font-size:13px;margin-top:6px">📍 ${escapeHtml(row.location || 'unknown')} · ${escapeHtml(row.work_mode || 'unknown')} · 💶 ${escapeHtml(salary)} · ${escapeHtml(SOURCE_LABELS[row.source] || row.source)}</div>
<div style="font-size:14px;margin-top:8px">${escapeHtml(row.score_reason)}</div>
${flags ? `<div style="margin-top:6px">${flags}</div>` : ''}
<div style="margin-top:10px"><a href="${escapeHtml(safeUrl(row.url))}" style="color:#2563eb;font-weight:600">Open offer →</a></div>
</div>`;
}

function healthLine(h) {
  if (h.runs === 0) return `⚠️ ${escapeHtml(h.label)}: no runs logged in 24h`;
  if (h.lastError) return `⚠️ ${escapeHtml(h.label)}: error: ${escapeHtml(h.lastError)}`;
  return `⚠️ ${escapeHtml(h.label)}: no results in 24h, check the source`;
}

function renderDigestHtml(selected, health, stats, config) {
  const count = selected.length;
  const cards = selected.map(renderOfferCard).join('\n');
  const warnings = health.filter((h) => !h.ok).map((h) => `<li>${healthLine(h)}</li>`).join('');
  const perSource = health.map((h) => `${escapeHtml(h.label)} ${h.fetched}`).join(' · ');
  const sheetLink = config.sheetUrl ? `<p><a href="${escapeHtml(safeUrl(config.sheetUrl))}">Open the tracker sheet</a></p>` : '';
  const remoteOk = selected.some((r) => r.source === 'remoteok') ? '<p>Jobs via <a href="https://remoteok.com">Remote OK</a>.</p>' : '';
  const remotive = selected.some((r) => r.source === 'remotive') ? '<p>Jobs via <a href="https://remotive.com">Remotive</a>.</p>' : '';
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
<h2 style="margin:0 0 16px">${count} new match${count === 1 ? '' : 'es'}</h2>
${cards}
<div style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;margin-top:20px;padding-top:12px">
<p>Last 24h: ${stats.collected} offers saved to the sheet, ${stats.scored} scored, ${count} shown (score ≥ ${config.scoreThreshold}).</p>
<p>Fetched per source: ${perSource}</p>
${warnings ? `<ul style="padding-left:18px">${warnings}</ul>` : ''}
${sheetLink}${remoteOk}${remotive}
</div>
</div>`;
}

function buildDigest(rows, runs, config, now) {
  const selected = selectDigestRows(rows, config.scoreThreshold);
  if (selected.length === 0) return null;
  return {
    subject: digestSubject(selected.length, now),
    html: renderDigestHtml(selected, sourceHealth(runs, now), recentStats(rows, now), config),
    ids: selected.map((r) => String(r.id)),
  };
}

function formatErrorEmail(errorData, to) {
  const workflow = (errorData && errorData.workflow) || {};
  const execution = (errorData && errorData.execution) || {};
  const error = execution.error || {};
  const name = workflow.name || 'unknown workflow';
  const link = execution.url ? `<p><a href="${escapeHtml(safeUrl(execution.url))}">Open the execution</a></p>` : '';
  return {
    to,
    subject: `⚠️ n8n job hunter: ${name} failed`,
    html: `<p><b>Workflow:</b> ${escapeHtml(name)}</p>
<p><b>Failed node:</b> ${escapeHtml(execution.lastNodeExecuted || 'unknown')}</p>
<p><b>Error:</b> ${escapeHtml(error.message || 'unknown error')}</p>
${link}`,
  };
}
// @export
module.exports = {
  selectDigestRows, sourceHealth, recentStats, digestSubject, renderDigestHtml, buildDigest, formatErrorEmail,
};
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test test/digest.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.js test/digest.test.js
git commit -m "feat: add digest builder and error email" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Workflow builder helpers and the collector workflow

**Files:**
- Create: `build/n8n.js`, `build/collector.js`
- Create: `build/build.js` (only `workflowConfig()` in this task; `outputs()` and `writeAll()` are added in Task 9)
- Test: `test/collector-workflow.test.js`

**Interfaces:**
- Consumes: `inlineCode` (build/inline.js), every lib through inlining, `runCodeNode`/`findNode` (test/harness.js)
- Produces (`build/n8n.js`): `createWorkflow(name)`, `addNode(wf, node)`, `connect(wf, from, to, input = 0, output = 0)`, `codeNode(wf, name, position, entry, { libs = true })`, `configNode(wf, values, position)`, `httpNode(wf, name, position, parameters, extra = {})`, `sheetsNode(wf, name, position, sheetName, operation, extra = {})`, `gmailNode(wf, name, position, sendTo)`, `assertConnectionsValid(wf)`
- Produces (`build/collector.js`): `buildCollector(cfg): workflow`
- Produces (`build/build.js`): `workflowConfig(): object` (`src/config.js` + `systemPrompt` read from `prompts/scoring-system-prompt.md`)
- Node names the tests rely on: `Every 4 hours`, `Run manually`, `Config`, `FT Queries`, `FT Search`, `FT Normalize`, `WTTJ Queries`, `WTTJ Search`, `WTTJ Normalize`, `Adzuna Queries`, `Adzuna Search`, `Adzuna Normalize`, `Remotive Fetch`, `Remotive Normalize`, `RemoteOK Fetch`, `RemoteOK Normalize`, `Merge Sources`, `Log Run`, `Append Run Log`, `Read Offers`, `Prepare`, `Score Offer`, `Apply Scores`, `New Rows`, `Retried Rows`, `Append Offers`, `Update Offers`

- [ ] **Step 1: Write the failing tests**

`test/collector-workflow.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { OFFER_COLUMNS } = require('../src/lib/schema');
const { buildCollector } = require('../build/collector');
const { workflowConfig } = require('../build/build');
const { assertConnectionsValid } = require('../build/n8n');
const { runCodeNode, findNode } = require('./harness');

const NOW = '2026-10-13T10:00:00Z';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const cfg = { ...workflowConfig(), wttj: { appId: 'APP', apiKey: 'KEY', indexName: 'wttj_jobs' } };
const wf = buildCollector(cfg);
const code = (name) => findNode(wf, name).parameters.jsCode;
const config = runCodeNode(code('Config'))[0];
const run = (name, input, nodes = {}) => runCodeNode(code(name), { input, nodes: { Config: [config], ...nodes }, now: NOW });

test('workflow structure is valid', () => {
  assertConnectionsValid(wf);
  assert.equal(wf.name, 'job-hunter-collector');
  assert.equal(wf.settings.timezone, 'Europe/Paris');
  assert.equal(wf.settings.executionOrder, 'v1');
  const names = wf.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length);
});

test('every Code node compiles and has no require()', () => {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$input', '$', 'Date', node.parameters.jsCode), `${node.name} does not compile`);
    assert.doesNotMatch(node.parameters.jsCode, /\brequire\(/, `${node.name} uses require`);
  }
});

test('the schedule runs 4 times a day', () => {
  assert.deepEqual(findNode(wf, 'Every 4 hours').parameters.rule.interval, [{ field: 'cronExpression', expression: '0 7,11,15,19 * * *' }]);
});

test('sources feed the merge in a fixed order', () => {
  const order = ['FT Normalize', 'WTTJ Normalize', 'Adzuna Normalize', 'Remotive Normalize', 'RemoteOK Normalize'];
  order.forEach((name, input) => {
    assert.deepEqual(wf.connections[name].main[0], [{ node: 'Merge Sources', type: 'main', index: input }]);
  });
  assert.equal(findNode(wf, 'Merge Sources').parameters.numberInputs, 5);
});

test('fetch nodes keep going on errors', () => {
  for (const name of ['FT Search', 'WTTJ Search', 'Adzuna Search', 'Remotive Fetch', 'RemoteOK Fetch', 'Score Offer']) {
    const node = findNode(wf, name);
    assert.equal(node.onError, 'continueRegularOutput', name);
    assert.equal(node.alwaysOutputData, true, name);
  }
});

test('Score Offer calls the Claude API with the right headers and credential', () => {
  const node = findNode(wf, 'Score Offer');
  assert.equal(node.parameters.url, 'https://api.anthropic.com/v1/messages');
  const headers = Object.fromEntries(node.parameters.headerParameters.parameters.map((p) => [p.name, p.value]));
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.deepEqual(node.credentials, { httpHeaderAuth: { name: 'Anthropic API Key' } });
  assert.equal(node.parameters.jsonBody, '={{ JSON.stringify($json.claudeRequest) }}');
});

test('credentials use the documented names', () => {
  assert.deepEqual(findNode(wf, 'FT Search').credentials, { oAuth2Api: { name: 'France Travail OAuth2' } });
  assert.deepEqual(findNode(wf, 'Adzuna Search').credentials, { httpCustomAuth: { name: 'Adzuna API' } });
  for (const name of ['Read Offers', 'Append Offers', 'Update Offers', 'Append Run Log']) {
    assert.deepEqual(findNode(wf, name).credentials, { googleSheetsOAuth2Api: { name: 'Google Sheets account' } }, name);
  }
  assert.deepEqual(findNode(wf, 'Update Offers').parameters.columns.matchingColumns, ['id']);
  assert.equal(findNode(wf, 'Read Offers').executeOnce, true);
});

test('Config carries the system prompt and settings', () => {
  assert.match(config.systemPrompt, /^You score job offers for one candidate\./);
  assert.equal(config.claudeModel, 'claude-opus-5-5');
  assert.equal(config.wttj.indexName, 'wttj_jobs');
});

test('query nodes emit one item per keyword', () => {
  assert.deepEqual(run('FT Queries', []), config.keywords.map((k) => ({ motsCles: k })));
  assert.deepEqual(run('Adzuna Queries', []), config.keywords.map((k) => ({ what: k })));
  const wttj = run('WTTJ Queries', []);
  assert.equal(wttj.length, config.keywords.length);
  assert.deepEqual(wttj[0].body, { requests: [{ indexName: 'wttj_jobs', params: `query=${encodeURIComponent(config.keywords[0])}&hitsPerPage=100` }] });
});

test('end to end: normalize, prepare, score and split rows', () => {
  const merged = [
    ...run('FT Normalize', [fixture('france-travail.json')]),
    ...run('WTTJ Normalize', [fixture('wttj.json')]),
    ...run('Adzuna Normalize', [fixture('adzuna.json')]),
    ...run('Remotive Normalize', [fixture('remotive.json')]),
    ...run('RemoteOK Normalize', fixture('remoteok.json')),
  ];
  assert.equal(merged.filter((m) => m._status).length, 5);

  const log = run('Log Run', merged);
  assert.deepEqual(log.map((l) => l.source), ['france_travail', 'wttj', 'adzuna', 'remotive', 'remoteok']);

  const sheetRows = [
    { id: 'remotive:1680001', status: 'emailed', dedupe_key: 'eta labs|senior react full stack developer', row_number: 2 },
    { id: 'adzuna:999', status: 'to_score', source: 'adzuna', title: 'Senior PHP Developer', company: 'Old Co', score_attempts: 1, row_number: 3 },
  ];
  const prepared = run('Prepare', sheetRows, { 'Merge Sources': merged });
  assert.deepEqual(prepared.map((p) => [p.op, p.row.id]), [
    ['update', 'adzuna:999'],
    ['append', 'france_travail:201ABCD'],
    ['append', 'wttj:WTTJ-REF-1'],
    ['append', 'adzuna:4870000001'],
    ['append', 'remoteok:1137500'],
  ]);

  const ok = fixture('claude-response.json');
  const applied = run('Apply Scores', [ok, ok, { error: { message: 'timeout' } }, ok, ok], { Prepare: prepared });
  const appendRows = run('New Rows', applied);
  const updateRows = run('Retried Rows', applied);
  assert.equal(appendRows.length, 4);
  assert.equal(updateRows.length, 1);
  assert.deepEqual(Object.keys(appendRows[0]), OFFER_COLUMNS);
  assert.equal(appendRows[0].status, 'new');
  assert.equal(appendRows[1].status, 'to_score');
  assert.equal(updateRows[0].id, 'adzuna:999');
  assert.equal(updateRows[0].score_attempts, 2);
});

test('end to end: first run on an empty sheet', () => {
  const merged = run('Adzuna Normalize', [fixture('adzuna.json')]);
  const prepared = run('Prepare', [{}], { 'Merge Sources': merged });
  assert.deepEqual(prepared.map((p) => p.row.id), ['adzuna:4870000001', 'adzuna:4870000002']);
});
```

Note: on an empty sheet, `adzuna:4870000002` isn't a duplicate. The France Travail offer it duplicates is not part of this run, and its predicted salary is ignored, so it passes the salary filter.

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/collector-workflow.test.js`
Expected: FAIL with `Cannot find module '../build/collector'`.

- [ ] **Step 3: Implement `build/n8n.js`**

```js
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
  const entry = `// Generated from src/config.js: edit it there, run npm run build, then re-import.\nreturn [{ json: ${JSON.stringify(values, null, 2)} }];`;
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
```

- [ ] **Step 4: Implement `build/collector.js`**

```js
const { createWorkflow, addNode, connect, codeNode, configNode, httpNode, sheetsNode } = require('./n8n');

function normalizeEntry(source) {
  return `const config = $('Config').first().json;
const { offers, status } = normalizeResponses('${source}', $input.all().map((i) => i.json), config, new Date());
return [{ json: { _status: status } }, ...offers.map((o) => ({ json: o }))];`;
}

const CONFIG = "$('Config').first().json";

function buildCollector(cfg) {
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

  // France Travail
  codeNode(wf, 'FT Queries', [440, 0], `return ${CONFIG}.keywords.map((k) => ({ json: { motsCles: k } }));`, { libs: false });
  httpNode(wf, 'FT Search', [660, 0], {
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
  codeNode(wf, 'FT Normalize', [880, 0], normalizeEntry('france_travail'));
  connect(wf, 'Config', 'FT Queries');
  connect(wf, 'FT Queries', 'FT Search');
  connect(wf, 'FT Search', 'FT Normalize');

  // Welcome to the Jungle (Algolia)
  codeNode(wf, 'WTTJ Queries', [440, 200], `const { wttj, keywords } = ${CONFIG};
return keywords.map((k) => ({ json: { body: { requests: [{ indexName: wttj.indexName, params: \`query=\${encodeURIComponent(k)}&hitsPerPage=100\` }] } } }));`, { libs: false });
  httpNode(wf, 'WTTJ Search', [660, 200], {
    method: 'POST',
    url: `={{ 'https://' + ${CONFIG}.wttj.appId + '-dsn.algolia.net/1/indexes/*/queries' }}`,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'X-Algolia-Application-Id', value: `={{ ${CONFIG}.wttj.appId }}` },
        { name: 'X-Algolia-API-Key', value: `={{ ${CONFIG}.wttj.apiKey }}` },
        { name: 'Referer', value: 'https://www.welcometothejungle.com/' },
        { name: 'Origin', value: 'https://www.welcometothejungle.com' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
  });
  codeNode(wf, 'WTTJ Normalize', [880, 200], normalizeEntry('wttj'));
  connect(wf, 'Config', 'WTTJ Queries');
  connect(wf, 'WTTJ Queries', 'WTTJ Search');
  connect(wf, 'WTTJ Search', 'WTTJ Normalize');

  // Adzuna
  codeNode(wf, 'Adzuna Queries', [440, 400], `return ${CONFIG}.keywords.map((k) => ({ json: { what: k } }));`, { libs: false });
  httpNode(wf, 'Adzuna Search', [660, 400], {
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
  codeNode(wf, 'Adzuna Normalize', [880, 400], normalizeEntry('adzuna'));
  connect(wf, 'Config', 'Adzuna Queries');
  connect(wf, 'Adzuna Queries', 'Adzuna Search');
  connect(wf, 'Adzuna Search', 'Adzuna Normalize');

  // Remotive
  httpNode(wf, 'Remotive Fetch', [660, 600], {
    method: 'GET',
    url: 'https://remotive.com/api/remote-jobs',
    sendQuery: true,
    queryParameters: { parameters: [{ name: 'category', value: 'software-development' }] },
  });
  codeNode(wf, 'Remotive Normalize', [880, 600], normalizeEntry('remotive'));
  connect(wf, 'Config', 'Remotive Fetch');
  connect(wf, 'Remotive Fetch', 'Remotive Normalize');

  // RemoteOK
  httpNode(wf, 'RemoteOK Fetch', [660, 800], {
    method: 'GET',
    url: 'https://remoteok.com/api',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'User-Agent', value: 'n8n-job-hunter (personal job search)' }] },
  });
  codeNode(wf, 'RemoteOK Normalize', [880, 800], normalizeEntry('remoteok'));
  connect(wf, 'Config', 'RemoteOK Fetch');
  connect(wf, 'RemoteOK Fetch', 'RemoteOK Normalize');

  // Merge (input order = dedupe priority)
  addNode(wf, { name: 'Merge Sources', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [1100, 400], parameters: { numberInputs: 5 } });
  ['FT Normalize', 'WTTJ Normalize', 'Adzuna Normalize', 'Remotive Normalize', 'RemoteOK Normalize']
    .forEach((name, input) => connect(wf, name, 'Merge Sources', input));

  // Run log
  codeNode(wf, 'Log Run', [1320, 600], 'return buildRunLog($input.all().map((i) => i.json), new Date()).map((json) => ({ json }));');
  sheetsNode(wf, 'Append Run Log', [1540, 600], 'runs', 'append');
  connect(wf, 'Merge Sources', 'Log Run');
  connect(wf, 'Log Run', 'Append Run Log');

  // Dedupe, filter, score, write
  sheetsNode(wf, 'Read Offers', [1320, 300], 'offers', 'read', { executeOnce: true, alwaysOutputData: true });
  codeNode(wf, 'Prepare', [1540, 300], `const config = $('Config').first().json;
const fetched = $('Merge Sources').all().map((i) => i.json);
const rows = $input.all().map((i) => i.json);
return prepareCollectorRun(fetched, rows, config).map((json) => ({ json }));`);
  httpNode(wf, 'Score Offer', [1760, 300], {
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
  }, { credentials: { httpHeaderAuth: { name: 'Anthropic API Key' } }, maxTries: 3 });
  codeNode(wf, 'Apply Scores', [1980, 300], `const config = $('Config').first().json;
const prepared = $('Prepare').all().map((i) => i.json);
const responses = $input.all().map((i) => i.json);
return applyScores(prepared, responses, config).map((json) => ({ json }));`);
  codeNode(wf, 'New Rows', [2200, 200], "return $input.all().filter((i) => i.json.op === 'append').map((i) => ({ json: i.json.row }));", { libs: false });
  codeNode(wf, 'Retried Rows', [2200, 400], "return $input.all().filter((i) => i.json.op === 'update').map((i) => ({ json: i.json.row }));", { libs: false });
  sheetsNode(wf, 'Append Offers', [2420, 200], 'offers', 'append');
  sheetsNode(wf, 'Update Offers', [2420, 400], 'offers', 'update');
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
```

- [ ] **Step 5: Create `build/build.js` with `workflowConfig()`**

```js
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');

const ROOT = path.join(__dirname, '..');

function workflowConfig() {
  const systemPrompt = fs.readFileSync(path.join(ROOT, 'prompts', 'scoring-system-prompt.md'), 'utf8').trim();
  return { ...baseConfig, systemPrompt };
}

module.exports = { workflowConfig };
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `node --test test/collector-workflow.test.js`
Expected: PASS, 11 tests.

Then run everything: `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add build/n8n.js build/collector.js build/build.js test/collector-workflow.test.js
git commit -m "feat: generate the collector workflow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Digest and error handler workflows, build output

**Files:**
- Create: `build/digest.js`, `build/error-handler.js`
- Modify: `build/build.js` (add `outputs()` and `writeAll()`)
- Create (generated by `npm run build`): `workflows/job-hunter-collector.json`, `workflows/job-hunter-digest.json`, `workflows/job-hunter-error-handler.json`, `sheet/offers-header.csv`, `sheet/runs-header.csv`
- Test: `test/digest-workflow.test.js`, `test/build.test.js`

**Interfaces:**
- Consumes: helpers from `build/n8n.js`, `workflowConfig()`, `buildCollector(cfg)`
- Produces: `buildDigestWorkflow(cfg)`, `buildErrorHandler(cfg)`, `outputs(cfg?): Record<string, string>` (relative path → file content), `writeAll()`
- Node names the tests rely on: digest: `Every day 08:00`, `Run manually`, `Config`, `Read Offers`, `Read Runs`, `Build Digest`, `Send Digest`, `Mark Emailed`, `Update Offers`. Error handler: `On workflow error`, `Format Error`, `Send Alert`.

- [ ] **Step 1: Write the failing tests**

`test/digest-workflow.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDigestWorkflow } = require('../build/digest');
const { buildErrorHandler } = require('../build/error-handler');
const { workflowConfig } = require('../build/build');
const { assertConnectionsValid } = require('../build/n8n');
const { runCodeNode, findNode } = require('./harness');

const NOW = '2026-10-13T06:00:00Z';
const cfg = { ...workflowConfig(), sheetUrl: 'https://docs.google.com/spreadsheets/d/abc' };
const digest = buildDigestWorkflow(cfg);
const errors = buildErrorHandler(cfg);

const compileAll = (wf) => {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$input', '$', 'Date', node.parameters.jsCode), `${node.name} does not compile`);
    assert.doesNotMatch(node.parameters.jsCode, /\brequire\(/, `${node.name} uses require`);
  }
};

test('digest workflow structure', () => {
  assertConnectionsValid(digest);
  compileAll(digest);
  assert.equal(digest.name, 'job-hunter-digest');
  assert.equal(digest.settings.timezone, 'Europe/Paris');
  assert.deepEqual(findNode(digest, 'Every day 08:00').parameters.rule.interval, [{ field: 'cronExpression', expression: '0 8 * * *' }]);
  assert.equal(findNode(digest, 'Read Offers').executeOnce, true);
  assert.equal(findNode(digest, 'Read Runs').parameters.sheetName.value, 'runs');
  assert.deepEqual(findNode(digest, 'Update Offers').parameters.columns.matchingColumns, ['id']);
  assert.equal(findNode(digest, 'Send Digest').parameters.sendTo, "={{ $('Config').first().json.digestEmail }}");
});

test('digest Config only carries what the digest needs', () => {
  const config = runCodeNode(findNode(digest, 'Config').parameters.jsCode)[0];
  assert.deepEqual(Object.keys(config).sort(), ['digestEmail', 'scoreThreshold', 'sheetId', 'sheetUrl']);
  assert.equal(config.digestEmail, 'you@example.com');
});

test('digest end to end: build the email, then mark rows as emailed', () => {
  const config = runCodeNode(findNode(digest, 'Config').parameters.jsCode)[0];
  const offers = [
    { id: 'a', status: 'new', score: '8', source: 'adzuna', title: 'Lead Dev', url: 'https://x/a', found_at: '2026-10-12T15:00:00.000Z' },
    { id: 'b', status: 'new', score: '4', source: 'adzuna', title: 'Other', url: 'https://x/b', found_at: '2026-10-12T15:00:00.000Z' },
  ];
  const runs = [{ run_at: '2026-10-13T05:00:00.000Z', source: 'adzuna', fetched: '10', eligible: '4', error: '' }];
  const built = runCodeNode(findNode(digest, 'Build Digest').parameters.jsCode, {
    input: runs, nodes: { Config: [config], 'Read Offers': offers }, now: NOW,
  });
  assert.equal(built.length, 1);
  assert.equal(built[0].subject, '🎯 Job digest: 1 new match (13/10)');
  assert.deepEqual(built[0].ids, ['a']);

  const marked = runCodeNode(findNode(digest, 'Mark Emailed').parameters.jsCode, {
    input: [{ id: 'gmail-msg' }], nodes: { 'Build Digest': built }, now: NOW,
  });
  assert.deepEqual(marked, [{ id: 'a', status: 'emailed', emailed_at: '2026-10-13T06:00:00.000Z' }]);
});

test('digest sends nothing when no offer qualifies or the sheet is empty', () => {
  const config = runCodeNode(findNode(digest, 'Config').parameters.jsCode)[0];
  const built = runCodeNode(findNode(digest, 'Build Digest').parameters.jsCode, {
    input: [{}], nodes: { Config: [config], 'Read Offers': [{}] }, now: NOW,
  });
  assert.deepEqual(built, []);
});

test('error handler formats and sends an alert', () => {
  assertConnectionsValid(errors);
  compileAll(errors);
  assert.equal(findNode(errors, 'On workflow error').type, 'n8n-nodes-base.errorTrigger');
  const out = runCodeNode(findNode(errors, 'Format Error').parameters.jsCode, {
    input: [{ workflow: { name: 'job-hunter-digest' }, execution: { lastNodeExecuted: 'Send Digest', error: { message: 'boom' } } }],
  });
  assert.equal(out[0].to, 'you@example.com');
  assert.equal(out[0].subject, '⚠️ n8n job hunter: job-hunter-digest failed');
  assert.equal(findNode(errors, 'Send Alert').parameters.sendTo, '={{ $json.to }}');
});
```

`test/build.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { outputs } = require('../build/build');

const ROOT = path.join(__dirname, '..');

test('generated files are up to date (run `npm run build` if this fails)', () => {
  for (const [rel, content] of Object.entries(outputs())) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing`);
    assert.equal(fs.readFileSync(file, 'utf8'), content, `${rel} is stale`);
  }
});

test('sheet headers match the schema', () => {
  const out = outputs();
  assert.equal(out['sheet/runs-header.csv'], 'run_at,source,fetched,eligible,error\n');
  assert.match(out['sheet/offers-header.csv'], /^id,source,title,company,/);
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/digest-workflow.test.js test/build.test.js`
Expected: FAIL with `Cannot find module '../build/digest'`, and `outputs is not a function`.

- [ ] **Step 3: Implement `build/digest.js` and `build/error-handler.js`**

`build/digest.js`:
```js
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
```

`build/error-handler.js`:
```js
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
```

- [ ] **Step 4: Replace `build/build.js` with the full build script**

```js
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { OFFER_COLUMNS, RUN_COLUMNS } = require('../src/lib/schema');

const ROOT = path.join(__dirname, '..');

function workflowConfig() {
  const systemPrompt = fs.readFileSync(path.join(ROOT, 'prompts', 'scoring-system-prompt.md'), 'utf8').trim();
  return { ...baseConfig, systemPrompt };
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

function writeAll() {
  for (const [rel, content] of Object.entries(outputs())) {
    const file = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${rel}`);
  }
}

if (require.main === module) writeAll();

module.exports = { workflowConfig, outputs, writeAll };
```

- [ ] **Step 5: Generate the files**

Run: `npm run build`
Expected output:
```
wrote workflows/job-hunter-collector.json
wrote workflows/job-hunter-digest.json
wrote workflows/job-hunter-error-handler.json
wrote sheet/offers-header.csv
wrote sheet/runs-header.csv
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: all tests PASS (the build test included).

- [ ] **Step 7: Commit**

```bash
git add build/digest.js build/error-handler.js build/build.js workflows sheet test/digest-workflow.test.js test/build.test.js
git commit -m "feat: generate digest and error handler workflows and build output" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: README with setup checklist

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: credential names, node names, config keys and file paths from Tasks 1–9

- [ ] **Step 1: Write `README.md`**

````markdown
# n8n Job Hunter

Collects job offers from France Travail, Welcome to the Jungle, Adzuna, Remotive and Remote OK. Scores each offer with Claude (Opus 5.5) against my profile, keeps everything in a Google Sheet, and emails me a digest of the best new matches every morning.

- **Collector** (`job-hunter-collector`): 07:00, 11:00, 15:00, 19:00. Fetch → normalize → dedupe → keyword pre-filter → Claude score → write to the `offers` tab. Logs per-source counts to the `runs` tab.
- **Digest** (`job-hunter-digest`): 08:00. Emails the `new` offers scoring ≥ 7, then marks them `emailed`.
- **Error handler** (`job-hunter-error-handler`): emails me when either workflow crashes.

Design: `docs/superpowers/specs/2026-10-13-job-hunter-design.md`.

## Using the tracker

The `status` column in the `offers` tab is yours to edit: `new` → `emailed` → `applied` / `interview` / `not_interested`. The workflows only set `to_score`, `score_failed`, `new` and `emailed`, and only on rows they are processing, so your edits are never overwritten.

## Setup

### 1. Google Sheet
1. Create a spreadsheet named "Job Hunter" with two tabs: `offers` and `runs`.
2. Paste the content of `sheet/offers-header.csv` into row 1 of `offers` (Data → Split text to columns if it lands in one cell). Do the same with `sheet/runs-header.csv` in `runs`.
3. Copy the sheet ID from the URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`).

### 2. API accounts
- **France Travail:** create an application on https://francetravail.io, subscribe it to the "Offres d'emploi v2" API, and note the client ID and secret.
- **Adzuna:** create a developer account on https://developer.adzuna.com and note the `app_id` and `app_key`.
- **Anthropic:** create an API key on https://console.anthropic.com and add credits (expect about $10–30 a month).
- **Welcome to the Jungle** (no account): open https://www.welcometothejungle.com/fr/jobs in your browser, open DevTools → Network, filter on `algolia`, and run a search. In the `queries` request, copy:
  - the application ID (`x-algolia-application-id` header, or the start of the request URL)
  - the API key (`x-algolia-api-key` header)
  - the `indexName` from the request payload

### 3. Config
Edit `src/config.js`: set `sheetId`, `sheetUrl` (the full sheet URL), and `wttj.appId`, `wttj.apiKey`, `wttj.indexName`. Then:
```bash
npm test
npm run build
git commit -am "chore: configure sheet and WTTJ keys"
```

### 4. n8n credentials
Create these credentials in n8n. **The names must match exactly.**

| Name | Type | Settings |
|---|---|---|
| `France Travail OAuth2` | OAuth2 API | Grant Type: Client Credentials. Access Token URL: `https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire`. Client ID and Secret from francetravail.io. Scope: `api_offresdemploiv2 o2dsoffre`. Authentication: Send credentials in body |
| `Adzuna API` | Custom Auth | `{"qs": {"app_id": "<app_id>", "app_key": "<app_key>"}}` |
| `Anthropic API Key` | Header Auth | Name: `x-api-key`. Value: your API key |
| `Google Sheets account` | Google Sheets OAuth2 API | Connect your Google account |
| `Gmail account` | Gmail OAuth2 API | Connect your Google account |

### 5. Import the workflows
1. Import `workflows/job-hunter-error-handler.json`, then `job-hunter-collector.json`, then `job-hunter-digest.json` (Workflows → Import from file).
2. In each workflow, open every node showing a credential warning and select the credential with the matching name.
3. In the collector and the digest: Settings → Error workflow → `job-hunter-error-handler`.
4. Run the collector manually once (see "Checks" below), then the digest. When both look right, activate all three workflows.

## Changing settings

Every setting (keywords, ESN blocklist, threshold, model…) lives in `src/config.js`, and the scoring prompt in `prompts/scoring-system-prompt.md`. After a change:
```bash
npm test && npm run build
```
Then re-import the changed workflow in n8n (import it and replace the existing one), and re-select the credentials if n8n asks.

## Development

- `npm test`: unit tests for all Code node logic, plus tests that run the generated Code nodes against fixtures.
- `npm run build`: regenerates `workflows/*.json` and `sheet/*.csv`. Never edit those files by hand. The tests fail if they are stale.
- Code in `src/lib/` is inlined into the Code nodes. It must stay free of `require`, `process` and filesystem access in the part between `// @body` and `// @export`.

## Checks

| Symptom | Where to look |
|---|---|
| The digest shows "⚠️ <source>: error" | The `runs` tab has the error message. Check that source's credential, or whether its API changed |
| WTTJ shows "not configured" | `wttj` keys are missing in `src/config.js` |
| WTTJ errors with 403 | Algolia refuses requests from your server. Get fresh keys (step 2), or remove WTTJ from the keywords flow |
| Rows stuck at `to_score` | Claude calls fail. The `score_reason` column has the error. After 3 attempts the row becomes `score_failed` |
| No email at 08:00 | No new offer scored ≥ 7, or the digest failed (you would get an error email) |
````

- [ ] **Step 2: Check the README against the code**

Run: `grep -o "'[A-Za-z ]*\(OAuth2\|API\|Key\|account\)'" build/*.js | sort -u`
Expected: exactly `'Adzuna API'`, `'Anthropic API Key'`, `'France Travail OAuth2'`, `'Gmail account'`, `'Google Sheets account'`, all listed in the README table.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add setup checklist and usage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Integration on the user's n8n (guided, with the user)

This task runs against real services and needs the user's accounts and n8n instance. The executor guides the user through it and records the results. Code changes found necessary here go through TDD: add the real (trimmed) response as a fixture, write the failing test, fix the code, then `npm test && npm run build` and re-import.

**Files:**
- Modify: `src/config.js` (sheet ID, sheet URL, WTTJ keys)
- Possibly modify: `src/lib/normalize.js` and `test/fixtures/*.json` (if a live API shape differs from the fixtures)
- Possibly modify: `prompts/scoring-system-prompt.md` (calibration)

- [ ] **Step 1: Setup (README steps 1–5)**

the user follows README "Setup" steps 1–5. Check: `npm test` passes after the config edit, and the 3 workflows are imported with no credential warnings.

- [ ] **Step 2: Verify each source on real data**

In the collector, run the workflow manually, then open each `* Normalize` node's output. For each source, check that the first status item has `error: ""` and `fetched > 0`. Check that at least 5 offers have a non-empty `title`, `url` that opens the right offer, `company`, `location`, and a `published_at` that parses. Checks per source:
- **France Travail:** salary fields filled when the offer has a salary.
- **Adzuna:** the title has no HTML.
- **WTTJ:** `work_mode` and `url` are right. If the live hits use other field names than the fixture (`name`, `slug`, `organization`, `offices`, `contract_type`, `remote`, `salary_*`, `published_at`), copy 2 real hits into `test/fixtures/wttj.json`, update the expectations in `test/normalize.test.js`, and fix `fromWttj`/`isEligible`.
- **Remotive / RemoteOK:** only software jobs open to Europe or worldwide.

Expected: every source is OK, or its problem is fixed (TDD) or written down. If WTTJ answers 403 from the server, record it and leave it disabled. The other 4 sources still run.

- [ ] **Step 3: Verify the Sheet writes**

After the manual run, check:
- The `offers` tab has new rows with every column filled in the right place.
- `status` is `new` (or `to_score` for failures).
- `Read Offers` → `Update Offers` matches on `id`: open the `Update Offers` node and check that "Column to match on" shows `id`. Select it if the import lost it.
- The `runs` tab has 5 rows for this run.

Run the collector a second time. Expected: no duplicate rows (same `id` or same `dedupe_key`).

- [ ] **Step 4: Scoring calibration with the user**

Pick 20 scored rows, spread across scores. the user marks each one "would apply" or "would not". Expected: the "would apply" offers score ≥ 7 and the obvious misfits score < 7. If not, adjust the rubric in `prompts/scoring-system-prompt.md`, rebuild, re-import, then clear `score` and set `status = to_score` and `score_attempts = 0` on those 20 rows so the next run re-scores them. Repeat until the result is acceptable to the user.

- [ ] **Step 5: Failure paths**

1. Edit the `Adzuna API` credential to a wrong `app_key` and run the collector. Expected: the other sources still write rows, and the `runs` tab shows an Adzuna error. Restore the key.
2. Edit the `Anthropic API Key` credential to an invalid value and run the collector. Expected: new rows land as `to_score` with `score_reason` "scoring failed: …". Restore the key and run again: those rows become `new` with a score ending in "(scored without description)".
3. Temporarily set the collector's `Config` to a wrong `sheetId` in n8n (not in the repo) and run. Expected: an error email from `job-hunter-error-handler`. Restore it.

- [ ] **Step 6: End to end**

Run the digest manually. Expected:
- The email arrives at you@example.com.
- It renders correctly in Gmail on web and mobile.
- It lists the `new` rows scoring ≥ 7, best first.
- Links open the offers, and the footer stats and warnings match the `runs` tab.
- Those rows are now `emailed` with `emailed_at` set.
- A second manual run sends nothing.

- [ ] **Step 7: Activate and commit**

Activate the three workflows. Commit any config, fixture, code or prompt changes from this task:
```bash
npm test && npm run build
git add -A
git commit -m "chore: configure and calibrate on live n8n" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
