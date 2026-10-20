const { SOURCES } = require('./schema');
const { escapeHtml } = require('./text');
// @body
const SOURCE_LABELS = {
  france_travail: 'France Travail',
  wttj: 'Welcome to the Jungle',
  linkedin: 'LinkedIn',
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

function sourceHealth(runs, now, sources = SOURCES) {
  const recent = runs.filter((r) => isRecent(r.run_at, now));
  return sources.map((source) => {
    const mine = recent.filter((r) => r.source === source);
    const fetched = mine.reduce((sum, r) => sum + (Number(r.fetched) || 0), 0);
    const errors = mine.filter((r) => r.error).map((r) => String(r.error));
    return {
      source,
      label: SOURCE_LABELS[source],
      runs: mine.length,
      fetched,
      lastError: errors.length ? errors[errors.length - 1] : '',
      ok: mine.length > 0 && fetched > 0 && errors.length === 0,
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
    html: renderDigestHtml(selected, sourceHealth(runs, now, config.enabledSources), recentStats(rows, now), config),
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
