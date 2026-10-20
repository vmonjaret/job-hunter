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
