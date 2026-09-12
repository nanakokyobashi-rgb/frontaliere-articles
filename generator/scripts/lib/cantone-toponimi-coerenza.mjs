/**
 * Coerenza fra il cantone dichiarato dallo slug e i toponimi del contenuto.
 *
 * Questa prima regola chiude la classe misurata in #1053: le guide verso
 * Grigioni/Vallese non devono presentare comuni o il cantone Ticino come luogo
 * della guida. La mappa e' intenzionalmente esplicita e piccola; un toponimo
 * nuovo va aggiunto insieme a un caso verificato, non dedotto da un dizionario
 * geografico generico che introdurrebbe falsi positivi.
 */

const CANTON_TOPONYMS_INTERNAL = {
  ticino: [
    'ticino',
    'tessin',
    'lugano',
    'bellinzona',
    'locarno',
    'chiasso',
    'mendrisio',
  ],
  grigioni: [
    'grigioni',
    'grisons',
    'graubünden',
    'graubuenden',
  ],
  vallese: [
    'vallese',
    'valais',
    'wallis',
  ],
};

export const CANTON_TOPONYMS = Object.freeze(
  Object.fromEntries(
    Object.entries(CANTON_TOPONYMS_INTERNAL)
      .map(([canton, toponyms]) => [canton, Object.freeze([...toponyms])]),
  ),
);

export const CANTON_ALIASES = Object.freeze({
  ticino: Object.freeze(['ticino', 'tessin']),
  grigioni: Object.freeze(['grigioni', 'grisons', 'graubünden', 'graubuenden']),
  vallese: Object.freeze(['vallese', 'valais', 'wallis']),
});

/**
 * Casi gia' pubblicati al momento della misura del 2026-09-06. Sono una
 * baseline osservabile, non un allow-list per articoli nuovi: l'id storico
 * resta pubblicabile mentre la guardia impedisce che la stessa classe rientri.
 */
export const KNOWN_BASELINE_CROSS_CANTON_ARTICLE_IDS = Object.freeze([
  'bionaz-lavorare-vallese-frontaliere',
  'torre-santa-maria-lavoro-grigioni-frontaliere',
  'vivere-a-tirano-e-lavorare-in-grigioni-da-frontaliere',
  'vivere-albosaggia-lavorare-grigioni-frontaliere',
  'vivere-aosta-lavorare-vallese',
  'vivere-campodolcino-lavorare-grigioni-da-frontaliere',
  'vivere-charvensod-lavorare-vallese-da-frontaliere',
  'vivere-chiavenna-lavorare-grigioni',
  'vivere-chiuro-lavorare-grigioni-frontaliere',
  'vivere-courmayeur-e-lavorare-vallese-da-frontaliere',
  'vivere-edolo-lavorare-grigioni-frontaliere',
  'vivere-gressan-lavorare-vallese-frontaliere',
  'vivere-grosio-lavorare-grigioni-frontaliere',
  'vivere-incudine-lavorare-grigioni-frontaliere',
  'vivere-la-thuile-lavorare-vallese',
  'vivere-livigno-lavorare-grigioni-frontalieri',
  'vivere-lovero-lavorare-grigioni-frontaliere',
  'vivere-malles-venosta-lavorare-grigioni',
  'vivere-malonno-lavorare-grigioni-frontaliere',
  'vivere-martello-lavorare-grigioni-frontaliere',
  'vivere-oyace-lavorare-vallese-frontaliere',
  'vivere-prata-camportaccio-lavorare-grigioni',
  'vivere-prato-allo-lavorare-grigioni',
  'vivere-quart-lavorare-vallese-frontaliere',
  'vivere-saint-pierre-e-lavorare-in-vallese-da-frontaliere',
  'vivere-saint-rhemy-en-bosses-lavorare-vallese-da-frontaliere',
  'vivere-samolaco-lavorare-grigioni-da-frontaliere',
  'vivere-sernio-lavorare-grigioni-frontaliere',
  'vivere-valbondione-lavorare-grigioni-frontaliere',
  'vivere-valfurva-e-lavorare-grigioni-da-frontaliere',
  'vivere-valtellina-lavorare-grigioni-frontaliere',
  'vivere-vezza-d-oglio-lavorare-grigioni-frontaliere',
]);

const BASELINE_IDS = new Set(KNOWN_BASELINE_CROSS_CANTON_ARTICLE_IDS);
const GUIDE_WORK_SCOPE_RX = /\b(?:vivere|guida|lavor\w*)\b/iu;

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .replace(/[’‘]/gu, "'")
    .toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsWholeTerm(text, term, { caseSensitive = false } = {}) {
  const originalTerm = String(term || '').trim();
  if (!originalTerm) return false;
  const matchedText = caseSensitive
    ? String(text || '').normalize('NFKC').replace(/[’‘]/gu, "'")
    : fold(text);
  const matchedTerm = caseSensitive
    ? originalTerm.charAt(0).toUpperCase() + originalTerm.slice(1)
    : fold(originalTerm).trim();
  const termPattern = matchedTerm.split(/\s+/u).map(escapeRegex).join('\\s+');
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${termPattern}(?![\\p{L}\\p{N}])`,
    caseSensitive ? 'u' : 'iu',
  ).test(matchedText);
}

const WORK_CLAUSE_RX = /\b(?:lavor\w*|work\w*|arbeit\w*|beschaft\w*|travaill\w*|emploi\w*)\b/giu;

function cantonMentions(text) {
  const foldedText = fold(text);
  const mentions = [];
  for (const [canton, toponyms] of Object.entries(CANTON_TOPONYMS)) {
    for (const toponym of toponyms) {
      const foldedTerm = fold(toponym).trim();
      const termPattern = foldedTerm.split(/\s+/u).map(escapeRegex).join('\\s+');
      const match = new RegExp(
        `(?<![\\p{L}\\p{N}])${termPattern}(?![\\p{L}\\p{N}])`,
        'u',
      ).exec(foldedText);
      if (match) mentions.push({ canton, toponym, index: match.index });
    }
  }
  return mentions.sort((a, b) => a.index - b.index);
}

/**
 * In a couple slug the residence commonly names Ticino before the destination:
 * `vivere-a-lugano-e-lavorare-vallese`. Prefer the first canton in the
 * `lavorare-*` clause so the residence does not make the slug ambiguous.
 */
function cantonFromWorkClause(text) {
  const foldedText = fold(text);
  const markers = [...foldedText.matchAll(WORK_CLAUSE_RX)];
  const marker = markers.at(-1);
  if (!marker) return null;
  return cantonMentions(foldedText.slice(marker.index + marker[0].length))[0]?.canton || null;
}

function matchesCantonInText(text, canton) {
  return CANTON_TOPONYMS[canton].some((toponym) => containsWholeTerm(text, toponym));
}

function cantonsMentionedIn(text) {
  return Object.keys(CANTON_TOPONYMS).filter((canton) => matchesCantonInText(text, canton));
}

/**
 * Ricava il cantone dichiarato soprattutto dallo slug. Il titolo e' un
 * fallback per producer che non hanno ancora uno slug localizzato.
 */
export function detectDeclaredCanton(slug, title = '') {
  const fromSlugWorkClause = cantonFromWorkClause(slug);
  if (fromSlugWorkClause) return fromSlugWorkClause;
  const fromTitleWorkClause = cantonFromWorkClause(title);
  if (fromTitleWorkClause) return fromTitleWorkClause;
  const fromSlug = cantonsMentionedIn(slug);
  if (fromSlug.length === 1) return fromSlug[0];
  if (fromSlug.length > 1) return null;
  const fromTitle = cantonsMentionedIn(title);
  return fromTitle.length === 1 ? fromTitle[0] : null;
}

/**
 * Il controllo riguarda le guide e i percorsi di lavoro, non ogni contenuto
 * che per ragioni editoriali nomina piu' cantoni. In particolare il digest
 * eventi dichiara Ticino ma include una sezione "altri cantoni" per progetto.
 *
 * Il cantone resta ricavato dallo slug/titolo, mentre il pattern guida/lavoro
 * delimita il tipo di articolo su cui il rilievo di un toponimo e' azionabile.
 */
export function isCantonGuideCandidate({ articleId = '', slug = '', title = '' } = {}) {
  const slugOrId = slug || articleId;
  const declaredCanton = detectDeclaredCanton(slugOrId, title);
  if (!declaredCanton) return false;
  return GUIDE_WORK_SCOPE_RX.test(`${articleId} ${slugOrId} ${title}`);
}

/**
 * Restituisce i toponimi appartenenti a un altro cantone rispetto a quello
 * dichiarato. Un singolo risultato e' sufficiente a far scattare il gate.
 */
export function findForeignCantonToponyms({ declaredCanton, slug = '', title = '', body = '' } = {}) {
  const canton = declaredCanton || detectDeclaredCanton(slug, title);
  if (!canton || !CANTON_TOPONYMS[canton]) return [];

  const found = [];
  const text = `${title}\n${body}`;
  for (const [otherCanton, toponyms] of Object.entries(CANTON_TOPONYMS)) {
    if (otherCanton === canton) continue;
    for (const toponym of toponyms) {
      // The issue baseline is the editorial form with proper-case place
      // names. Matching that form avoids treating a lowercase common-word
      // occurrence in an unrelated guide as a canton inconsistency.
      if (containsWholeTerm(text, toponym, { caseSensitive: true })) {
        found.push({ canton: otherCanton, toponym });
      }
    }
  }
  return found;
}

/**
 * Verdetto del guard. `baseline` e' l'unico esito tollerato per i 32 articoli
 * storici; uno slug nuovo con lo stesso rilievo torna `reject`.
 */
export function checkCantonToponymConsistency({
  articleId = '',
  slug = '',
  title = '',
  body = '',
} = {}) {
  const id = String(articleId || slug || '').replace(/\.ts$/u, '');
  const declaredCanton = detectDeclaredCanton(slug || id, title);

  if (BASELINE_IDS.has(id)) {
    const matches = findForeignCantonToponyms({ declaredCanton, slug: slug || id, title, body });
    return {
      ok: true,
      status: 'baseline',
      articleId: id,
      declaredCanton,
      matches,
    };
  }
  if (!isCantonGuideCandidate({ articleId: id, slug: slug || id, title })) {
    return {
      ok: true,
      status: 'unscoped',
      articleId: id,
      declaredCanton,
      matches: [],
    };
  }
  const matches = findForeignCantonToponyms({ declaredCanton, slug: slug || id, title, body });
  return {
    ok: matches.length === 0,
    status: matches.length === 0 ? 'pass' : 'reject',
    articleId: id,
    declaredCanton,
    matches,
  };
}

export default {
  CANTON_TOPONYMS,
  CANTON_ALIASES,
  KNOWN_BASELINE_CROSS_CANTON_ARTICLE_IDS,
  detectDeclaredCanton,
  isCantonGuideCandidate,
  findForeignCantonToponyms,
  checkCantonToponymConsistency,
};
