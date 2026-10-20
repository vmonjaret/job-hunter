const { stripHtml } = require('./text');
// @body
// LinkedIn guest pages (no login): search results are <li> job cards, a job page has the full description.
function firstMatch(html, regex) {
  const m = String(html || '').match(regex);
  return m ? stripHtml(m[1]) : '';
}

function parseLinkedinCards(html) {
  return String(html || '').split('<li>').slice(1).map((card) => ({
    id: firstMatch(card, /urn:li:jobPosting:(\d+)/),
    title: firstMatch(card, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/),
    company: firstMatch(card, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
    location: firstMatch(card, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
    published_at: firstMatch(card, /<time[^>]*datetime="([^"]+)"/),
  })).filter((c) => c.id && c.title);
}

function parseLinkedinDetail(html) {
  const criteria = {};
  const re = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
  let m = re.exec(String(html || ''));
  while (m) {
    criteria[stripHtml(m[1])] = stripHtml(m[2]);
    m = re.exec(String(html || ''));
  }
  return {
    description: firstMatch(html, /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/),
    employment_type: criteria['Employment type'] || '',
    seniority: criteria['Seniority level'] || '',
  };
}
// @export
module.exports = { parseLinkedinCards, parseLinkedinDetail };
