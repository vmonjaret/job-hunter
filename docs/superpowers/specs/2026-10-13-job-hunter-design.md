# n8n Job Hunter — Design Spec

**Date:** 2026-10-13
**Owner:** the repository owner
**Status:** Approved design, pending spec review

## 1. Goal

Automatically find job offers matching the user's profile, score them with Claude, keep them in a Google Sheet tracker, and send a daily email digest of the best new matches.

**Success criteria**
- Each morning a digest email lists the new offers scoring ≥ 7/10, best first, with a one-line reason per offer.
- Every collected offer (any score) is in the Google Sheet exactly once, with a hand-editable `status` column for tracking applications.
- A single failing source never prevents the other sources or the digest from running.
- Running cost stays at about $10–30/month (the Claude API is the only paid component).

## 2. Candidate profile (used verbatim-ish as the scoring system prompt)

- **Senior Full Stack Developer**, about 10 years of professional experience.
- Current role: Full Stack Developer at a fully remote SaaS company. Previously back-end PHP/Symfony roles and a consulting firm (ESN).
- Stack: **PHP/Symfony** expert (clean architecture, DDD), **React** front end, **Node.js microservices with Kafka** (event-driven), Docker.
- Has mentored many juniors and taught web development courses.
- Languages: French (native), English (professional).
- **Target roles:** Senior Full Stack Developer, Lead Engineer / Tech Lead / Lead Developer (Staff is acceptable).
- **Contract:** CDI. For remote roles at foreign companies, a salaried employer-of-record contract is acceptable. Contractor-only offers are not wanted.
- **Salary:** at least €60K gross/year. Flexible above that.
- **Location:** lives east of Paris.
  - Paris area: hybrid with **at least 2 remote days** (fully remote is better). Far west suburbs (La Défense, Saclay, 78) are a long commute.
  - Abroad: **fully remote** roles at companies that hire French residents.
- **Avoid:** consulting firms (ESN), Python-centric roles.

## 3. Architecture

Self-hosted n8n. Three workflows:

| Workflow | Trigger | Purpose |
|---|---|---|
| `job-hunter-collector` | Cron: every 4h from 07:00 to 19:00, Europe/Paris (07, 11, 15, 19). 4 runs a day because Remotive's API terms ask for at most 4 calls a day | Fetch → normalize → dedupe → pre-filter → score → append to Sheet, and log per-source counts to the `runs` tab |
| `job-hunter-digest` | Cron: daily 08:00, Europe/Paris | Read unsent rows scoring ≥ threshold → email → mark as emailed |
| `job-hunter-error-handler` | Error Trigger (set as the error workflow of the other two) | Email the user on any workflow crash |

The Google Sheet is the single source of truth and the interface between the collector and the digest.

## 4. Collector workflow

### 4.1 Config node (first node)

A Code node holding all tunable values, generated from `src/config.js` at build time, so nothing else needs editing:
- `keywords`: search phrases ("développeur full stack", "fullstack senior", "lead developer", "tech lead", "php symfony", "node.js senior").
- `titleIncludeRegex`: `full.?stack|lead|staff|senior|php|symfony|node|react|typescript|back.?end`
- `titleExcludeRegex`: `\bjunior\b|\bstage\b|stagiaire|\bintern(ship)?\b|alternan|apprenti|freelance|python|data scientist` (word boundaries so "International" or "Backstage" are not excluded)
- `esnBlocklist`: Capgemini, Sopra Steria, Alten, Akkodis, Altran, CGI, Accenture, Inetum, Modis, Atos, Expleo, Devoteam, Onepoint, Wavestone, Keyrus, SII, Aubay, Talan, Extia, Davidson, Ausy, Neurones, Sword, Infotel (editable). Matched on whole words of the normalized company name.
- `salaryFloor`: 60000
- `scoreThreshold`: 7 (the digest workflow gets the same value in its own Config node)
- `claudeModel`: `claude-opus-5-5`, `claudeEffort`: `low`, `claudeMaxTokens`: 4096
- `descriptionMaxChars`: 6000
- `maxRetryRows`: 50, `maxScoreAttempts`: 3
- `sheetId`, `sheetUrl`, `digestEmail`, and the WTTJ Algolia index name (`wttj.indexName`)

### 4.2 Sources

Each source is an independent branch. Every HTTP node has **On Error → Continue (using error output)**, and errors are counted for the digest's source health line (§5).

| Source | Endpoint / access | Query |
|---|---|---|
| France Travail | Offres d'emploi v2 API. OAuth2 client credentials (francetravail.io, scope `api_offresdemploiv2 o2dsoffre`) | One search per keyword: `motsCles`, `region=11` (Île-de-France; the API accepts at most 5 departments), `typeContrat=CDI`, `publieeDepuis=1`, `range=0-149` |
| Adzuna | `api.adzuna.com/v1/api/jobs/fr/search/1` with `app_id` / `app_key` | One search per keyword: `what`, `where=Paris`, `distance=40`, `permanent=1`, `max_days_old=1`, `results_per_page=50`, `sort_by=date` |
| Welcome to the Jungle | Algolia search endpoint used by the WTTJ website (unofficial) | One query per keyword. Keep `contract_type = full_time` with an office in France **or** `remote = fulltime`, published within 48h |
| LinkedIn | Guest pages, no login (unofficial, against LinkedIn's terms; personal low volume). `jobs-guest/jobs/api/seeMoreJobPostings/search` returns 10 job cards per page; `jobs-guest/jobs/api/jobPosting/<id>` returns the job page with the description | `linkedinPages` (2) pages per keyword with `location=Paris, Île-de-France, France`, `f_TPR=r86400` (last 24h), `f_JT=F` (full-time). Keep `Employment type = Full-time` (or missing) from the job page |
| Remotive | `remotive.com/api/remote-jobs?category=software-development` | The category parameter is not reliable, so also keep only `category = "Software Development"` in code. Keep locations covering France, Europe/EU/EMEA/CET, or worldwide. Jobs are published with a 24h delay, so the window is 72h |
| RemoteOK | `remoteok.com/api` (attribution link required in the digest) | Keep tags ∩ {php, symfony, node, nodejs, react, full-stack, fullstack, full stack, lead, typescript}. Same location rule as Remotive (an empty location is kept). Published within 48h |

Implementation notes:
- France Travail: the HTTP node uses an n8n OAuth2 credential (client credentials grant), which handles the token.
- WTTJ: the website serves its public Algolia app ID and search key at `https://www.welcometothejungle.com/api/env` (`PUBLIC_ALGOLIA_APPLICATION_ID`, `PUBLIC_ALGOLIA_API_KEY_CLIENT`), with no bot blocking (checked 2026-10-13). The collector reads them on each run, so key rotations need no action. Only the index name lives in `src/config.js`: `wttj_jobs_production_fr_published_at_desc`, sorted by publication date, which returns 2–3× more offers from the last 48h than the relevance-sorted `wttj_jobs_production_fr`. If the keys can't be read, WTTJ reports an error and the other sources continue.
- Sources: `enabledSources` in `src/config.js` picks the sources built into the collector (at least 2). France Travail is off until its API subscription works (2026-10-14: `invalid_scope`); Adzuna is off because it needs an account.
- LinkedIn: the job pages are rate-limited (HTTP 429 even at a few requests per minute). So the collector reads the `offers` tab first and fetches job pages only for new cards that pass the pre-filter, at most `linkedinMaxDetails` (30) per run, one every 3s (searches one every 2s). A job page that fails is left out and fetched again on the next run, since the card shows up in the 24h search again. Parsing lives in `src/lib/linkedin.js`; LinkedIn's HTML can change at any time.
- Adzuna: an estimated salary (`salary_is_predicted = 1`) is shown as "Adzuna estimate" in `salary_raw` but not used for the salary pre-filter.
- n8n splits a top-level JSON array response (RemoteOK) into one item per element. The normalizer accepts both shapes.
- Each normalizer emits a status item (`source`, `fetched`, `eligible`, `error`). The statuses are appended to the `runs` tab.

### 4.3 Normalization

A Code node per source maps raw offers to one schema. These are exactly the Sheet columns:

| Column | Description |
|---|---|
| `id` | `<source>:<external id>` |
| `source` | `france_travail` / `adzuna` / `wttj` / `remotive` / `remoteok` |
| `title` | Job title as published |
| `company` | Company name (empty if hidden) |
| `location` | Free-text location |
| `work_mode` | `onsite` / `hybrid` / `remote` / `unknown` (from the source data, refined by Claude) |
| `contract` | As published (CDI, full_time, …) |
| `salary_min`, `salary_max` | Yearly EUR numbers if parseable, otherwise empty |
| `salary_raw` | Salary text as published |
| `estimated_salary` | Salary range Claude read in the description, if any |
| `url` | Link to the offer |
| `published_at` | ISO date |
| `found_at` | ISO datetime of collection |
| `score` | 0–10, empty if not scored yet |
| `score_reason` | Claude's one-line reason |
| `flags` | Comma-separated flags from Claude |
| `status` | `to_score` / `score_failed` / `new` / `emailed` / `applied` / `interview` / `not_interested` |
| `score_attempts` | Number of scoring attempts so far |
| `emailed_at` | ISO datetime when included in a digest |
| `notes` | Free text, edited by hand |
| `dedupe_key` | Normalized `company + title` (lowercase, accents and punctuation stripped) |

`description` is carried through the workflow for scoring but **not** stored in the Sheet.

### 4.4 Deduplication

1. Read the `id` and `dedupe_key` columns from the Sheet once per run.
2. Drop an offer if its `id` exists **or** its `dedupe_key` exists (the same offer cross-posted on several sites).
3. Also dedupe within the current batch (first one wins, in source order France Travail → WTTJ → LinkedIn → Adzuna → Remotive → RemoteOK).

### 4.5 Keyword pre-filter

An offer is kept only if **all** of these hold:
- `title` matches `title_include_regex` (case-insensitive).
- `title` does not match `title_exclude_regex`.
- `company` does not match any `esn_blocklist` entry (case-insensitive substring).
- `salary_max` is empty or ≥ `salary_floor`.

Offers that fail the pre-filter are **not** written to the Sheet, to keep it readable. They are not counted separately: the `runs` tab records `fetched` and `eligible` per source, which is enough to spot a broken source.

### 4.6 Claude scoring

One HTTP Request node per offer (batches of 5, with a short wait between batches to respect rate limits).

- `POST https://api.anthropic.com/v1/messages`
- Headers: `x-api-key` (n8n credential), `anthropic-version: 2023-06-01`, `anthropic-beta: server-side-fallback-2026-07-01`
- Body:
  - `model`: `claude-opus-5-5`
  - `max_tokens`: 4096 (Opus 5.5 always uses adaptive thinking, so it needs headroom)
  - `output_config`: `{ "effort": "low", "format": { "type": "json_schema", "schema": <below> } }`
  - `fallbacks`: `"default"` (if the model declines a request, the API retries it on another model automatically)
  - `system`: the profile (§2) + rubric (below)
  - `messages`: one user message with the offer's title, company, location, contract, salary_raw, and description truncated to `description_max_chars`
- Read the response only when `stop_reason` is `end_turn`, then parse the JSON from the text block. Any other outcome counts as a scoring failure.

**Output schema**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["score", "reason", "flags", "work_mode", "estimated_salary"],
  "properties": {
    "score": { "type": "integer", "description": "Match score from 0 (no fit) to 10 (perfect fit)" },
    "reason": { "type": "string" },
    "flags": { "type": "array", "items": { "type": "string", "enum": ["esn", "python_heavy", "contractor_only", "salary_below_60k", "onsite_only", "far_commute", "not_senior", "not_cdi"] } },
    "work_mode": { "type": "string", "enum": ["onsite", "hybrid", "remote", "unknown"] },
    "estimated_salary": { "anyOf": [{ "type": "string" }, { "type": "null" }] }
  }
}
```

Structured outputs don't support numeric constraints (`minimum`/`maximum`), so the 0–10 range is checked when parsing. An out-of-range score counts as a scoring failure.

**Rubric (in the system prompt)**
- Base score from role and seniority fit: Senior Full Stack or Lead/Tech Lead with a PHP/Symfony, Node.js or React stack → 7–9. Adjacent stacks (TypeScript back end, Laravel, Next.js) → 6–8. Unrelated stack → ≤ 4.
- Bonuses (+1 each, max 10): DDD or clean architecture, event-driven systems (Kafka or similar), product company (not an agency), ≥ 2 remote days or fully remote, mentoring or lead responsibilities.
- Hard caps: ESN or consulting/staffing firm → ≤ 2. Python as the main language → ≤ 4. Contractor or freelance only → ≤ 4. Not CDI or an equivalent salaried contract → ≤ 4. Stated salary under €60K → ≤ 3. Onsite only or fewer than 2 remote days → ≤ 5. Office in the far west suburbs without full remote → ≤ 5. Office outside Île-de-France without full remote → ≤ 3. Junior/mid-level role → ≤ 4.
- An unknown salary is neutral.
- Remote roles outside France: only score high if they hire residents of France or the EU.
- `reason`: one sentence in English, ≤ 160 characters, stating the main driver of the score.

**Failure handling:** if the call fails or the output doesn't parse, write the row with an empty `score` and `status = to_score`. At the start of each collector run, read the `to_score` rows (up to 50) and score them again before processing new offers. After 3 failed attempts (`score_attempts`), the row becomes `score_failed` and is no longer retried. Since `description` isn't stored in the Sheet, the retry re-scores from the title, company, location and salary only, and says so in `reason` ("scored without description").

### 4.7 Write to Sheet

Append the scored offers with `status = new`. Retried `to_score` rows are updated in place (matched on `id`).

## 5. Digest workflow

1. Cron trigger at 08:00, Europe/Paris.
2. Read all rows from the `offers` and `runs` tabs.
3. Select rows with `status = new` and `score ≥ score_threshold`, sorted by score (descending), then `published_at` (descending). Sheet values may come back as strings, so they are compared as numbers.
4. Compute stats for the last 24h: offers saved and scored (from `found_at` in `offers`), and offers fetched per source (from `runs`). Any source with no runs, an error, or 0 fetched in 24h gets a "⚠️" line with the last error message.
5. If the selection is empty, send no email.
6. Otherwise build an HTML email:
   - Subject: `🎯 Job digest: N new matches (DD/MM)`
   - One card per offer: **title @ company**, a score badge, location and work mode, salary (raw or estimated), the reason, flags as small tags, and an "Open offer" link.
   - Footer: stats, the source health line, a link to the Sheet, and "Jobs via RemoteOK" attribution when any RemoteOK offer is included.
7. Send with the Gmail node (OAuth2) to you@example.com.
8. Update the sent rows: `status = emailed`, `emailed_at = now`.

Rows below the threshold remain `new` in the Sheet and are never emailed.

## 6. Error handler workflow

The Error Trigger receives the failing workflow's name, the failed node and the error message, and emails them through Gmail with the execution URL. It's set as the **Error Workflow** in both other workflows' settings.

## 7. Credentials and setup

| Credential | Where to get it | n8n credential type |
|---|---|---|
| France Travail | francetravail.io → create an application → subscribe to "Offres d'emploi v2" | Generic OAuth2 (client credentials) or Header Auth + token node |
| Adzuna | developer.adzuna.com → app_id / app_key | Query Auth |
| Anthropic | console.anthropic.com → API key + credits | Header Auth (`x-api-key`) |
| Google | Google Cloud OAuth client with the Sheets and Gmail APIs enabled | Google Sheets OAuth2, Gmail OAuth2 |

WTTJ, Remotive and RemoteOK need no credentials.

The Sheet holds two tabs:
- `offers`, with the header row from §4.3 in that order.
- `runs`, with the header `run_at, source, fetched, eligible, error` (one row per source per collector run).

## 8. Deliverables (repo layout)

The Code node logic is written as plain JavaScript modules with unit tests (Node's built-in test runner, no dependencies). A build script inlines the modules into the Code nodes and generates the workflow JSON files to import.

```
n8n-job-hunter/
├── README.md                     # setup checklist, import order, how to tune
├── package.json                  # npm test, npm run build
├── src/
│   ├── config.js                 # all tunable values (becomes each workflow's Config node)
│   └── lib/                      # pure functions inlined into Code nodes
├── build/                        # workflow generators + build script
├── test/                         # unit tests, fixtures, n8n Code node harness
├── workflows/                    # generated, committed, imported into n8n
│   ├── job-hunter-collector.json
│   ├── job-hunter-digest.json
│   └── job-hunter-error-handler.json
├── sheet/
│   ├── offers-header.csv         # header rows to paste into the Sheet
│   └── runs-header.csv
├── prompts/
│   └── scoring-system-prompt.md  # profile + rubric (the source of truth, copied into the workflow)
└── docs/superpowers/
```

## 9. Testing plan

1. **Per source:** run each branch manually and check that the normalized output fills every schema field correctly for at least 5 offers. Pin the data for the later steps.
2. **Dedupe and pre-filter:** feed pinned data containing a known duplicate, an ESN, a junior role and a low salary. Check that exactly those are dropped.
3. **Scoring calibration:** score about 20 real offers and review them with the user. Adjust the rubric until their "would apply" offers score ≥ 7 and the obvious misfits score < 7.
4. **Failure paths:** use a wrong Adzuna key and check that the other sources still run and the digest shows the warning. Use an invalid Anthropic key and check that rows land as `to_score`, then get retried.
5. **End to end:** a full collector run, then a manual digest run. Check the email renders in Gmail (web and mobile) and the rows switch to `emailed`.

## 10. Out of scope (for now)

- Indeed (fragile and against its terms of service). Could be added later through Apify.
- Automatic applications or cover letter generation.
- Commute-time calculation through a maps API (Claude's `far_commute` flag covers it roughly).
- A web UI other than the Sheet.
