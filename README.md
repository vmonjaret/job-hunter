# n8n Job Hunter

Collects job offers from Welcome to the Jungle, LinkedIn, Remotive and Remote OK (France Travail and Adzuna are supported but switched off in `enabledSources`). Scores each offer with Claude (Opus 5.5) against a candidate profile, keeps everything in a Google Sheet, and emails a digest of the best new matches every morning.

- **Collector** (`job-hunter-collector`): 07:00, 11:00, 15:00, 19:00. Fetch → normalize → dedupe → keyword pre-filter → Claude score → write to the `offers` tab. Logs per-source counts to the `runs` tab.
- **Digest** (`job-hunter-digest`): 08:00. Emails the `new` offers scoring ≥ 7, then marks them `emailed`.
- **Error handler** (`job-hunter-error-handler`): emails you when either workflow crashes.

Design: `docs/superpowers/specs/2026-10-13-job-hunter-design.md`.

## Using the tracker

The `status` column in the `offers` tab is yours to edit: `new` → `emailed` → `applied` / `interview` / `not_interested`. The workflows only set `to_score`, `score_failed`, `new` and `emailed`, and only on rows they are processing, so your edits are never overwritten.

## Setup

### 0. Run n8n (Podman)
```bash
podman compose up -d        # n8n on http://localhost:5678, Europe/Paris time
podman compose logs -f n8n  # follow logs
podman compose down         # stop (data stays in the n8n_data volume)
```
Open http://localhost:5678 and create the owner account. The workflows only run while the container is up, so keep the machine on at 07:00–19:00. Podman has no daemon: to restart the container after a reboot, run `systemctl --user enable --now podman-restart.service` (`restart: unless-stopped` then takes effect). To upgrade n8n, change the image tag in `compose.yaml` and run `podman compose up -d`.

### 1. Google Sheet
1. Create a spreadsheet named "Job Hunter" with two tabs: `offers` and `runs`.
2. Paste the content of `sheet/offers-header.csv` into row 1 of `offers` (Data → Split text to columns if it lands in one cell). Do the same with `sheet/runs-header.csv` in `runs`.
3. Copy the sheet ID from the URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`).

### 2. API accounts
- **France Travail** (only if you add it to `enabledSources`): create an application on https://francetravail.io, subscribe it to the "Offres d'emploi v2" API, and note the client ID and secret.
- **Adzuna** (only if you add it to `enabledSources`): create a developer account on https://developer.adzuna.com and note the `app_id` and `app_key`.
- **Anthropic:** create an API key on https://console.anthropic.com and add credits (expect about $10–30 a month).
- **LinkedIn**: nothing to do. The collector reads LinkedIn's public guest job pages, without logging in.
- **Welcome to the Jungle**: nothing to do. The collector reads the public Algolia keys from `https://www.welcometothejungle.com/api/env` on each run.

### 3. Config
Your personal settings live in gitignored files, so they never end up in git:
```bash
cp src/config.local.example.js src/config.local.js
cp prompts/candidate-profile.example.md prompts/candidate-profile.md
```
1. In `src/config.local.js`, set `sheetId`, `sheetUrl` (the full sheet URL) and `digestEmail`. Any other key from `src/config.js` (keywords, salary floor…) can be overridden there too.
2. In `prompts/candidate-profile.md`, replace the example with your own profile: background, core and adjacent stacks, target roles, nice-to-haves, contract, salary, location and what to avoid. Keep the headings, since the scoring rubric in `prompts/scoring-system-prompt.md` refers to them. The build inserts the profile into the rubric at `{{candidate_profile}}`.
3. Build your workflows into `dist/workflows/` (gitignored):
```bash
npm test
npm run build:local
```

### 4. n8n credentials
Create these credentials in n8n. **The names must match exactly.**

| Name | Type | Settings |
|---|---|---|
| `France Travail OAuth2` (if enabled) | OAuth2 API | Grant Type: Client Credentials. Access Token URL: `https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire`. Client ID and Secret from francetravail.io. Scope: `api_offresdemploiv2 o2dsoffre`. Authentication: Send credentials in body |
| `Adzuna API` (if enabled) | Custom Auth | `{"qs": {"app_id": "<app_id>", "app_key": "<app_key>"}}` |
| `Anthropic API Key` | Header Auth | Name: `x-api-key`. Value: your API key |
| `Google Sheets account` | Google Sheets OAuth2 API | Connect your Google account |
| `Gmail account` | Gmail OAuth2 API | Connect your Google account |

### 5. Import the workflows
1. Import `dist/workflows/job-hunter-error-handler.json`, then `job-hunter-collector.json`, then `job-hunter-digest.json` (Workflows → Import from file). Or import all three at once from the CLI: `podman exec n8n n8n import:workflow --separate --input=/workflows`. Use the CLI only for the first import: the workflows have no fixed ID, so running it again creates duplicates.
2. In each workflow, open every node showing a credential warning and select the credential with the matching name.
3. In the collector and the digest: Settings → Error workflow → `job-hunter-error-handler`.
4. Run the collector manually once (see "Checks" below), then the digest. When both look right, activate all three workflows.

## Changing settings

Defaults (enabled sources, keywords, ESN blocklist, threshold, model…) live in `src/config.js`, your overrides in `src/config.local.js`, your profile in `prompts/candidate-profile.md`, and the scoring rubric in `prompts/scoring-system-prompt.md`. After a change:
```bash
npm test && npm run build:local
```
Then re-import the changed workflow in n8n (import it and replace the existing one), and re-select the credentials if n8n asks.

## Development

- `npm test`: unit tests for all Code node logic, plus tests that run the generated Code nodes against fixtures.
- `npm run build`: regenerates the committed `workflows/*.json` and `sheet/*.csv` from the defaults (no personal data). Never edit those files by hand. The tests fail if they are stale.
- `npm run build:local`: same workflows with your local overrides, written to `dist/workflows/`.
- Code in `src/lib/` is inlined into the Code nodes. It must stay free of `require`, `process` and filesystem access in the part between `// @body` and `// @export`.

## Checks

| Symptom | Where to look |
|---|---|
| The digest shows "⚠️ <source>: error" (only enabled sources are checked) | The `runs` tab has the error message. Check that source's credential, or whether its API changed |
| LinkedIn shows "429 - Too Many Requests" | LinkedIn throttled the guest pages. Offers whose job page failed are fetched again on the next run. If every run fails, lower `linkedinPages` / `linkedinMaxDetails` in `src/config.js` |
| LinkedIn fetches 0 offers without an error | LinkedIn changed its page HTML. Update `src/lib/linkedin.js` and the fixtures in `test/fixtures/linkedin-*.html` |
| WTTJ shows "no Algolia keys" | `https://www.welcometothejungle.com/api/env` failed or changed format. Open it in a browser and check that it still has `PUBLIC_ALGOLIA_APPLICATION_ID` and `PUBLIC_ALGOLIA_API_KEY_CLIENT` |
| WTTJ errors with 403 or "index does not exist" | Algolia refuses requests from your server, or WTTJ renamed the index. Check `wttj.indexName` in `src/config.js` against the `indexName` the WTTJ jobs page sends (DevTools → Network → `algolia`) |
| Rows stuck at `to_score` | Claude calls fail. The `score_reason` column has the error. After 3 attempts the row becomes `score_failed` |
| No email at 08:00 | No new offer scored ≥ 7, or the digest failed (you would get an error email) |
