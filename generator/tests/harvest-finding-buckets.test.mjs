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
