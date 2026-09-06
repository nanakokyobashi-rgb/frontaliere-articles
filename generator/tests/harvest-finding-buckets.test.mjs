/**
 * harvest-finding-buckets.test.mjs — la ricognizione negata NON e' un finding.
 *
 * ## Il difetto che copre (issue #901)
 *
 * `REVIEW.md` fa della superficie pubblicata la priorita' 1 della review e
 * chiede di promuovere a 🔴 ogni ❓ che la tocchi. Ne segue che quasi ogni
 * review chiude il verdetto con una ricognizione NEGATA — «nessun impatto su
 * `dist/api/`, sulle sitemap o sui feed» — che dice l'opposto di un difetto.
 *
 * Quella frase vive sulla riga del verdetto, che porta il glifo di severita':
 * `detectSeverity` la conta come finding confermato e la taxonomy la butta nel
 * bucket il cui vocabolario compare nell'ELENCO DELLE COSE NON TOCCATE. Su
 * questo repo l'elenco nomina SEMPRE sitemap/canonical, quindi
 * `canonical-sitemap` si gonfia a ogni PR pulita e ri-escala per sempre: 10 hit
 * su 14gg in #901, di cui 4 dei 5 esempi citati (#896, #882, #881, #879) sono
 * esattamente questa ricognizione.
 *
 * Gli snippet qui sotto sono VERBATIM dalle review reali di quelle PR: un test
 * su prosa inventata avrebbe dimostrato solo che la regex fa quello che ho
 * scritto io, non che chiude il caso misurato.
 *
 * ## Perche' un test e non solo la regex
 *
 * Il rimedio e' cross-bucket per costruzione (la clausola sparisce PRIMA della
 * scelta del bucket), quindi la sua regressione non si vedrebbe su
 * `canonical-sitemap`: si vedrebbe su un bucket qualsiasi, mesi dopo, come
 * un'escalation che nessun fix puo' chiudere — la stessa forma di #2114
 * (`auto-ads`), #2122 (`i18n-naming`) e #4342 (`NEGATED_SEVERITY_RE`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFinding, stripNegatedImpactClauses, tallyFindings } from '../../scripts/ci/harvest-agent-lessons.mjs';

// Verbatim dalle review claude delle PR citate in #901.
const RICOGNIZIONI_NEGATE = [
  ['#896', "Comportamento del reset invariato e pinnato esplicitamente (`resolverFlaps.github === 2` dopo un reset `silent`); nessun impatto su `dist/api/`, sulle sitemap o sui feed — `getStats()` cresce di un campo additivo. I due 🟡 non bloccano."],
  ['#882', "🔴 Important: l'allarme mette `process.exitCode = 1` nel primo step del job, e nessun articolo nuovo raggiunge `content/`, la sitemap blog e la superficie `dist/api/`."],
  ['#881', "🟡 Nit: `markedExhausted` e' per-modello, quindi il nuovo `else` non puo' saltare il ban di un id fratello. Nessun impatto su `dist/api/`, slug, sitemap o feed: il delta e' interamente nel ledger della cascata."],
  ['#879', "🔴 Nessuno dei tre viene promosso a 🔴: tutti si manifestano come un rosso rumoroso, nessuno tocca `dist/api/`, gli slug, le sitemap, i canonical o i feed RSS."],
  ['#837', "🔴 Important: una riga di misura chiude la domanda. Non escalato: il ramo tocca l'automazione delle issue di CI, non `dist/api/`, le sitemap, i feed o gli slug."],
  ['#808', "🟡 Nit: il log distingue apertura da promozione. Nulla tocca `dist/api/`, le sitemap, i feed o gli slug. I due 🟡 sono debito locale."],
];

for (const [pr, line] of RICOGNIZIONI_NEGATE) {
  test(`ricognizione negata di ${pr}: la superficie NON toccata non fa punteggio su canonical-sitemap`, () => {
    assert.notEqual(bucketFinding(line), 'canonical-sitemap');
  });
}

test('il difetto VERO su canonical/sitemap resta contato (#878)', () => {
  const line = "`generator/scripts/create-article.mjs:L15733`: 🔴 Important: esce `/de/blog/null` in `slugs.json`, nel canonical e nella sitemap — esattamente il difetto #868 item 1.";
  assert.equal(bucketFinding(line), 'canonical-sitemap');
});

test('il difetto VERO sul publish delle sitemap resta contato (#766)', () => {
  const line = "🔴 Important: aggiungi a `paths:` di `publish-api.yml` gli input reali del publish (`scripts/lib/build-sitemap.mjs`), oppure il workflow di trasporto non ripubblica la sitemap.";
  assert.equal(bucketFinding(line), 'canonical-sitemap');
});

test('la negazione di COMPORTAMENTO non e\' una ricognizione: resta un difetto', () => {
  // «non aggiorna / non emette» sono verbi di comportamento: li' la negazione E'
  // il difetto. Solo i verbi di IMPATTO/PORTATA descrivono cio' che la PR non tocca.
  assert.equal(bucketFinding('🔴 Important: il ramo di recupero non aggiorna la sitemap dopo il rename dello slug.'), 'canonical-sitemap');
  assert.equal(bucketFinding('🔴 Important: la pagina non emette il canonical quando il locale manca.'), 'canonical-sitemap');
});

test('il rimedio e\' cross-bucket, non una toppa su canonical-sitemap', () => {
  assert.notEqual(bucketFinding('🟡 Nit: il refactor e\' neutro; nessun impatto su structured data o JSON-LD.'), 'structured-data');
  assert.notEqual(bucketFinding('🟡 Nit: nulla tocca il router o `parsePath`.'), 'router-nav');
  // e il difetto vero sugli stessi bucket resta contato
  assert.equal(bucketFinding('🔴 Important: il JSON-LD emette `baseSalary` senza valuta.'), 'structured-data');
});

test('lo strip si ferma al confine di frase: il resto della riga resta scansionabile', () => {
  const line = '🔴 Important: nessun impatto su `dist/api/` o sulle sitemap. Il JSON-LD pero\' emette `baseSalary` senza valuta.';
  assert.match(stripNegatedImpactClauses(line), /baseSalary/);
  assert.equal(bucketFinding(line), 'structured-data');
});

test('la coda contrastiva toglie solo se stessa, non cio\' che la precede', () => {
  const line = '🔴 Important: il fix tocca il canonical del locale `de`, non `dist/api/`, le sitemap o i feed.';
  const stripped = stripNegatedImpactClauses(line);
  assert.match(stripped, /tocca il canonical/);
  assert.doesNotMatch(stripped, /le sitemap o i feed/);
  assert.equal(bucketFinding(line), 'canonical-sitemap');
});

test('stripNegatedImpactClauses e\' pura e tollera null/undefined', () => {
  assert.equal(stripNegatedImpactClauses(null), '');
  assert.equal(stripNegatedImpactClauses(undefined), '');
  const line = 'nessun impatto su `dist/api/` o sulle sitemap.';
  assert.equal(stripNegatedImpactClauses(line), stripNegatedImpactClauses(line));
});

test('end-to-end: sei PR con la sola ricognizione negata non aprono un bucket canonical-sitemap', () => {
  const prs = RICOGNIZIONI_NEGATE.map(([pr, line], i) => ({
    number: 900 + i,
    mergedAt: '2026-09-01T00:00:00Z',
    reviews: [{ author: { login: 'claude' }, body: `## Findings\n${line}\n` }],
  }));
  const { counts } = tallyFindings(prs);
  assert.equal(counts['canonical-sitemap'] ?? 0, 0, `bucket ${JSON.stringify(counts)}`);
});

// --- Round 2: le tre imprecisioni della regex misurate dalla review di #909 ---
// Tutte e tre riproducibili importando il modulo: il primo confine di frase era
// un punto NUDO, quindi bastava che la ricognizione nominasse un file perche' la
// clausola si troncasse a meta' e il resto tornasse scansionabile. Su questo repo
// la ricognizione nomina quasi sempre un file, quindi era il caso dominante.

test('il punto dentro un code span non e\' confine di frase: la ricognizione sparisce intera', () => {
  // Prima: lo strip si fermava su `articles` e lasciava «.json`, sulle sitemap o
  // sui feed» → `canonical-sitemap`. Stessa forma con qualunque estensione.
  for (const file of ['articles.json', 'meta-it.json', 'publish-api.yml', 'build-rss.mjs']) {
    const line = `🟡 Nit: nessun impatto su \`${file}\`, sulle sitemap o sui feed.`;
    assert.doesNotMatch(stripNegatedImpactClauses(line), /sitemap/, `residuo su ${file}`);
    assert.notEqual(bucketFinding(line), 'canonical-sitemap', `bucket su ${file}`);
  }
});

test('il punto SEGUITO da spazio resta confine: la frase dopo la ricognizione e\' ancora scansionabile', () => {
  const line = '🔴 Important: nessun impatto su `manifest.json` o sulle sitemap. Il JSON-LD emette `baseSalary` senza valuta.';
  assert.match(stripNegatedImpactClauses(line), /baseSalary/);
  assert.equal(bucketFinding(line), 'structured-data');
});

test('la coda contrastiva sopravvive a un punto nel nome del file negato', () => {
  // Prima: il punto di `.mjs` spezzava il lookbehind e la coda non veniva tolta
  // affatto, quindi `slugs.json`/sitemap/feed restavano a fare punteggio.
  const line = '🟡 Nit: il fix tocca `create-article.mjs`, non `slugs.json`, le sitemap o i feed.';
  const stripped = stripNegatedImpactClauses(line);
  assert.match(stripped, /create-article\.mjs/);
  assert.doesNotMatch(stripped, /le sitemap o i feed/);
  assert.notEqual(bucketFinding(line), 'canonical-sitemap');
});

test('la negazione inglese `not` conta quanto `no impact on`', () => {
  // `IMPACT_VERB` portava gia' touch/reach/affect, ma l'elenco delle negazioni
  // aveva solo `no`: la forma piu' comune in inglese («does not touch») passava.
  assert.notEqual(bucketFinding('🟡 Nit: this refactor does not touch `dist/api/`, sitemaps or feeds.'), 'canonical-sitemap');
  assert.notEqual(bucketFinding('🟡 Nit: the change does not affect slugs, sitemaps or canonical URLs.'), 'canonical-sitemap');
  assert.notEqual(bucketFinding('🟡 Nit: no impact on `dist/api/`, sitemaps or feeds.'), 'canonical-sitemap');
});

test('lo sweep incompleto NON e\' una ricognizione: la negazione li\' e\' il difetto', () => {
  // `non toccat` e' insieme il tell della TAXONOMY `sibling-class-fix` e una
  // negazione + participio di `IMPACT_VERB`: senza il guard lo strip mangiava la
  // forma che REVIEW.md prescrive per un finding di classe. Riga verbatim da #880.
  const verbatim = '`scripts/cf-purge-cache.mjs`:L76: 🟡 Nit: stesso anti-pattern che la PR chiude altrove, non toccato — `Number(process.env.CF_PURGE_SETTLE_MS) || 20_000` copre `NaN`.';
  assert.equal(stripNegatedImpactClauses(verbatim), verbatim, 'la riga di sweep non va toccata');
  assert.equal(bucketFinding(verbatim), 'sibling-class-fix');
  // e la forma senza il tell letterale della taxonomy resta almeno nella rete fingerprint
  const equivalente = '🔴 Important: il ramo equivalente in `build-rss.mjs` non e\' toccato dalla PR.';
  assert.equal(stripNegatedImpactClauses(equivalente), equivalente);
  assert.ok(bucketFinding(equivalente), 'non deve sparire nel nulla');
});

// --- Round 3: il guard di sweep e' per-FRASE, non per riga (#974) ------------
// Una riga puo' portare le due forme insieme: l'affermazione di sweep incompleto
// E la ricognizione negata di chiusura. Col guard applicato alla riga intera lo
// strip saltava per intero e il vocabolario che compare SOLO nella ricognizione
// tornava a fare punteggio — cioe' il falso positivo che lo strip chiude.

test('sweep incompleto + ricognizione negata sulla stessa riga: si toglie solo la ricognizione', () => {
  const line = "🔴 Important: lo stesso anti-pattern in `build-rss.mjs` non e' toccato. Nessun impatto su `dist/api/`, sulle sitemap o sui feed.";
  const stripped = stripNegatedImpactClauses(line);
  assert.match(stripped, /stesso anti-pattern/, 'la frase di sweep resta intera');
  assert.match(stripped, /non e' toccato/, "la negazione della frase di sweep e' il difetto, non si tocca");
  assert.doesNotMatch(stripped, /sitemap/, 'la ricognizione negata sparisce');
  assert.equal(bucketFinding(line), 'sibling-class-fix');
});

test('ordine inverso: la ricognizione in testa non salva se stessa perche\' lo sweep viene dopo', () => {
  const line = "🔴 Important: nessun impatto su `dist/api/`, sulle sitemap o sui feed. Il file gemello `build-rss.mjs` non e' toccato.";
  const stripped = stripNegatedImpactClauses(line);
  assert.doesNotMatch(stripped, /sulle sitemap o sui feed/, 'la ricognizione negata sparisce');
  assert.match(stripped, /file gemello/);
  assert.equal(bucketFinding(line), 'sibling-class-fix');
});

test('la coda contrastiva segue la stessa regola per-frase', () => {
  const line = "🟡 Nit: il fix tocca `create-article.mjs`, non le sitemap o i feed. Lo stesso costrutto in `build-rss.mjs` resta.";
  const stripped = stripNegatedImpactClauses(line);
  assert.doesNotMatch(stripped, /le sitemap o i feed/, 'la coda negata sparisce anche se la riga porta un tell di sweep altrove');
  assert.match(stripped, /stesso costrutto/);
});

test('tell di sweep e ricognizione nella STESSA frase: il guard resta conservativo', () => {
  const line = "🟡 Nit: il file gemello `build-rss.mjs` e' gia' allineato, nessun impatto su `dist/api/` o sulle sitemap.";
  assert.equal(stripNegatedImpactClauses(line), line, 'una frase sola: non si sa separarle, si tiene tutto');
});

test('end-to-end: le righe miste non aprono un bucket canonical-sitemap', () => {
  const misti = [
    "🔴 Important: lo stesso anti-pattern in `build-rss.mjs` non e' toccato. Nessun impatto su `dist/api/`, sulle sitemap o sui feed.",
    "🔴 Important: il file gemello `build-rss.mjs` non e' toccato; nessun impatto su slug, sitemap o canonical.",
    "🟡 Nit: this refactor does not touch `dist/api/`, sitemaps or feeds. The sibling `build-rss.mjs` still carries it.",
  ];
  const prs = misti.map((line, i) => ({
    number: 940 + i,
    mergedAt: '2026-09-01T00:00:00Z',
    reviews: [{ author: { login: 'claude' }, body: `## Findings\n${line}\n` }],
  }));
  const { counts } = tallyFindings(prs);
  assert.equal(counts['canonical-sitemap'] ?? 0, 0, `bucket ${JSON.stringify(counts)}`);
  assert.equal(counts['sibling-class-fix'] ?? 0, 3, `bucket ${JSON.stringify(counts)}`);
});
