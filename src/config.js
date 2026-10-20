// Values for each workflow's Config node. Put your own values (sheet, email…) in src/config.local.js,
// run `npm run build:local`, then re-import the workflows from dist/.
module.exports = {
  // Sources the collector fetches, from: france_travail, wttj, linkedin, adzuna, remotive, remoteok.
  // France Travail is off until its API subscription works; Adzuna needs an account.
  enabledSources: ['wttj', 'linkedin', 'remotive', 'remoteok'],
  sheetId: '<SHEET_ID>',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/<SHEET_ID>',
  digestEmail: 'you@example.com',
  keywords: ['développeur full stack', 'fullstack senior', 'lead developer', 'tech lead', 'php symfony', 'node.js senior'],
  ftRegion: '11',
  adzunaWhere: 'Paris',
  adzunaDistanceKm: 40,
  // Algolia keys are read from the WTTJ website on each run. This index is sorted by publication date.
  wttj: { indexName: 'wttj_jobs_production_fr_published_at_desc' },
  // LinkedIn guest search (no login): pages of 10 results per keyword, and at most this many job pages per run.
  linkedinLocation: 'Paris, Île-de-France, France',
  linkedinPages: 2,
  linkedinMaxDetails: 30,
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
