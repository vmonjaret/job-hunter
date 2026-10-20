const { stripHtml, dedupeKey, isWithinHours } = require('./text');
const { parseSalary } = require('./salary');
const { parseLinkedinCards, parseLinkedinDetail } = require('./linkedin');
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
  // Some n8n errors (e.g. a failed OAuth2 token request) reach the item without a message.
  return response.error.message || response.error.description || 'request failed (n8n recorded no details, open the execution to see the node error)';
}

// The WTTJ website publishes its public Algolia keys at /api/env as `window.env = {...};`.
function parseWttjEnv(text) {
  const read = (name) => {
    const m = String(text || '').match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`));
    return m ? m[1] : '';
  };
  return { appId: read('PUBLIC_ALGOLIA_APPLICATION_ID'), apiKey: read('PUBLIC_ALGOLIA_API_KEY_CLIENT') };
}

function normalizeResponses(source, responses, config, now) {
  const offers = [];
  if (source === 'wttj' && !(config.wttj && config.wttj.appId && config.wttj.apiKey && config.wttj.indexName)) {
    return { offers, status: { source, fetched: 0, eligible: 0, error: 'no Algolia keys (could not read welcometothejungle.com/api/env)' } };
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
  return { offers, status: { source, fetched, eligible: offers.length, error: sourceError(errors) } };
}
function linkedinCardOffer(card, foundAt) {
  return makeOffer('linkedin', card.id, {
    title: card.title,
    company: card.company,
    location: card.location,
    url: `https://www.linkedin.com/jobs/view/${card.id}/`,
    published_at: card.published_at || '',
  }, foundAt);
}

function sourceError(errors) {
  if (errors.length === 0) return '';
  return errors.length === 1 ? errors[0] : `${errors.length} requests failed: ${errors[0]}`;
}

// picks[i] is the search card whose job page is detailResponses[i]. Failed pages are left out, so the next run retries them.
function normalizeLinkedin(searchResponses, picks, detailResponses, now) {
  const foundAt = now.toISOString();
  const errors = searchResponses.map(responseError).filter(Boolean);
  const ids = new Set(searchResponses.flatMap((r) => parseLinkedinCards(r && r.data).map((c) => c.id)));
  const offers = [];
  picks.forEach((card, i) => {
    const response = detailResponses[i];
    const error = responseError(response);
    const detail = error ? null : parseLinkedinDetail(response.data);
    if (!detail || !detail.description) {
      errors.push(error || 'job page without description');
      return;
    }
    // The search's full-time filter still lets some part-time and contract offers through.
    if (detail.employment_type && detail.employment_type !== 'Full-time') return;
    offers.push({ ...linkedinCardOffer(card, foundAt), contract: detail.employment_type, description: detail.description });
  });
  return { offers, status: { source: 'linkedin', fetched: ids.size, eligible: offers.length, error: sourceError(errors) } };
}
// @export
module.exports = { normalizeResponses, parseWttjEnv, linkedinCardOffer, normalizeLinkedin };
